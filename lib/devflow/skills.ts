// DevFlow skill registry — port of the legacy DevFlow-AI skill system
// (services/skills/registry.py + routes/skills.py). Skills are SKILL.md files
// with a YAML frontmatter manifest; the chat agent activates them by intent
// (trigger keywords) or explicit request and injects the matching workflow
// instructions into the system prompt (progressive disclosure of curated
// engineering playbooks).
//
// Divergences from legacy, recorded honestly:
//   - The legacy `entrypoint` mapped a skill to a Python agent tool and drove
//     entrypoint-activation + a per-skill tool allow-list inside the custom
//     LangGraph agent. This stack's chat runs on AI SDK tools, so entrypoints
//     are kept as manifest metadata (catalog/trace) but activation is
//     trigger/explicit only and the tool allow-list is advisory (surfaced in
//     the injected instructions), not a hard runtime gate.
//   - The legacy `/api/skills/mcp-status` probed the stdio MCP memory
//     subprocess, which is replaced by in-process tools here (Yukino.md #25),
//     so that probe is not ported.
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { load } from "js-yaml";

export interface SkillManifest {
  name: string;
  title: string;
  version: string;
  description: string;
  category: string;
  entrypoint: string;
  tools: string[];
  inputModes: string[];
  triggers: string[];
  workflowSteps: string[];
  outputContract: string;
  safetyLevel: string;
}

export interface SkillDefinition {
  manifest: SkillManifest;
  path: string;
  instructions: string;
}

export interface SkillActivation {
  skillName: string;
  skillTitle: string;
  skillVersion: string;
  entrypoint: string;
  tools: string[];
  workflowSteps: string[];
  outputContract: string;
  safetyLevel: string;
  activationMode: "explicit" | "automatic";
  activationReason: string;
  instructions: string;
  instructionDigest: string;
  resources: Array<{
    path: string;
    content: string;
    size: number;
    digest: string;
  }>;
}

export class SkillRegistryError extends Error {}

const SKILLS_DIR = path.resolve(process.cwd(), "data/devflow-skills");
const MAX_AUTO_SKILLS = 3;
const MAX_REFERENCED_RESOURCES = 8;
const MAX_RESOURCE_BYTES = 64 * 1024;
const TEXT_SUFFIXES = new Set([
  ".md",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".py",
  ".sh",
  ".ps1",
  ".ts",
]);

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === "string" && value.trim() !== "") return [value.trim()];
  return [];
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : fallback;
}

// Split a SKILL.md into its YAML frontmatter mapping and markdown body.
function splitFrontmatter(
  text: string,
  file: string,
): { data: Record<string, unknown>; body: string } {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalized);
  if (!match) {
    throw new SkillRegistryError(
      `${file} must start with a YAML frontmatter block`,
    );
  }
  let parsed: unknown;
  try {
    parsed = load(match[1]);
  } catch (e) {
    throw new SkillRegistryError(
      `${file} has invalid YAML frontmatter: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SkillRegistryError(
      `${file} frontmatter must be a key-value mapping`,
    );
  }
  return {
    data: parsed as Record<string, unknown>,
    body: normalized.slice(match[0].length).trim(),
  };
}

function parseManifest(
  data: Record<string, unknown>,
  file: string,
): SkillManifest {
  const name = asString(data["name"], "");
  if (name === "")
    throw new SkillRegistryError(`${file} frontmatter is missing 'name'`);
  return {
    name,
    title: asString(data["title"], name),
    version: asString(data["version"], "0.0.0"),
    description: asString(data["description"], ""),
    category: asString(data["category"], "general"),
    entrypoint: asString(data["entrypoint"], ""),
    tools: asStringArray(data["tools"]),
    inputModes: asStringArray(data["input_modes"] ?? data["inputModes"]),
    triggers: asStringArray(data["triggers"]),
    workflowSteps: asStringArray(
      data["workflow_steps"] ?? data["workflowSteps"],
    ),
    outputContract: asString(
      data["output_contract"] ?? data["outputContract"],
      "freeform",
    ),
    safetyLevel: asString(
      data["safety_level"] ?? data["safetyLevel"],
      "read_only",
    ),
  };
}

async function loadSkill(file: string): Promise<SkillDefinition> {
  const text = await readFile(file, "utf8");
  const { data, body } = splitFrontmatter(text, file);
  return {
    manifest: parseManifest(data, file),
    path: file,
    instructions: body,
  };
}

// Score a message against a skill's triggers (legacy _activation_score):
// ASCII triggers match on word boundaries, other triggers (e.g. CJK) match as
// substrings; longer triggers weigh more, capped at 8.
function activationScore(message: string, skill: SkillDefinition): number {
  const lowered = message.toLowerCase();
  let score = 0;
  for (const raw of skill.manifest.triggers) {
    const trigger = raw.trim().toLowerCase();
    if (trigger === "") continue;
    let matched: boolean;
    if (/^[a-z0-9_+#.-]+$/.test(trigger)) {
      const escaped = trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      matched = new RegExp(`(?<![a-z0-9_])${escaped}(?![a-z0-9_])`).test(
        lowered,
      );
    } else {
      matched = lowered.includes(trigger);
    }
    if (matched) score += Math.max(1, Math.min(trigger.length, 8));
  }
  return score;
}

export class SkillRegistry {
  private readonly skills: SkillDefinition[];
  private readonly byName: Map<string, SkillDefinition>;

  constructor(skills: SkillDefinition[]) {
    this.skills = [...skills].sort((a, b) =>
      a.manifest.name.localeCompare(b.manifest.name),
    );
    const seen = new Set<string>();
    for (const skill of this.skills) {
      if (seen.has(skill.manifest.name)) {
        throw new SkillRegistryError(
          `Duplicate skill name: ${skill.manifest.name}`,
        );
      }
      seen.add(skill.manifest.name);
    }
    this.byName = new Map(this.skills.map((s) => [s.manifest.name, s]));
  }

  listSkills(): SkillDefinition[] {
    return this.skills;
  }

  getSkill(name: string): SkillDefinition | undefined {
    return this.byName.get(name.trim().toLowerCase());
  }

  // Lightweight catalog for the system prompt (legacy prompt_context).
  promptContext(): string {
    if (this.skills.length === 0) return "No DevFlow skills are registered.";
    return this.skills
      .map((s) => {
        const steps =
          s.manifest.workflowSteps.length > 0
            ? s.manifest.workflowSteps.join(", ")
            : "defined in SKILL.md";
        return `- ${s.manifest.name} v${s.manifest.version} (${s.manifest.title}): ${s.manifest.description} Steps: ${steps}. Safety: ${s.manifest.safetyLevel}.`;
      })
      .join("\n");
  }

  // Activate skills for a message: explicit request wins, otherwise the
  // top-scoring trigger matches (legacy SkillRegistry.activate).
  async activate(
    message: string,
    requestedName?: string | null,
  ): Promise<SkillActivation[]> {
    const explicit = this.explicitSkills(message, requestedName);
    if (explicit.length > 0) {
      return Promise.all(
        explicit.map((s) =>
          this.toActivation(
            s,
            "explicit",
            "User explicitly requested this skill",
          ),
        ),
      );
    }
    const scored = this.skills
      .map((s) => ({ score: activationScore(message, s), skill: s }))
      .filter((item) => item.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.skill.manifest.name.localeCompare(b.skill.manifest.name),
      );
    return Promise.all(
      scored
        .slice(0, MAX_AUTO_SKILLS)
        .map((item) =>
          this.toActivation(
            item.skill,
            "automatic",
            `Message matched skill triggers (score ${item.score})`,
          ),
        ),
    );
  }

  private explicitSkills(
    message: string,
    requestedName?: string | null,
  ): SkillDefinition[] {
    if (requestedName && requestedName.trim() !== "") {
      const skill = this.byNameOrTitle(requestedName);
      if (!skill)
        throw new SkillRegistryError(
          `Requested skill not found: ${requestedName}`,
        );
      return [skill];
    }
    const lowered = message.toLowerCase();
    if (!lowered.includes("skill") && !message.includes("技能")) return [];
    const selected = this.skills.filter(
      (s) =>
        lowered.includes(s.manifest.name.toLowerCase()) ||
        lowered.includes(s.manifest.title.toLowerCase()),
    );
    return selected;
  }

  private byNameOrTitle(value: string): SkillDefinition | undefined {
    const normalized = value.trim().toLowerCase();
    return this.skills.find(
      (s) =>
        s.manifest.name.toLowerCase() === normalized ||
        s.manifest.title.toLowerCase() === normalized,
    );
  }

  private async toActivation(
    skill: SkillDefinition,
    mode: "explicit" | "automatic",
    reason: string,
  ): Promise<SkillActivation> {
    const instructions = skill.instructions.trim();
    return {
      skillName: skill.manifest.name,
      skillTitle: skill.manifest.title,
      skillVersion: skill.manifest.version,
      entrypoint: skill.manifest.entrypoint,
      tools: skill.manifest.tools,
      workflowSteps: skill.manifest.workflowSteps,
      outputContract: skill.manifest.outputContract,
      safetyLevel: skill.manifest.safetyLevel,
      activationMode: mode,
      activationReason: reason,
      instructions,
      instructionDigest: createHash("sha256")
        .update(instructions)
        .digest("hex")
        .slice(0, 16),
      resources: await this.loadReferencedResources(skill),
    };
  }

  // Load resources referenced from the instructions as `references/...`,
  // `templates/...`, `scripts/...` or `assets/...` (legacy
  // _load_referenced_resources): path-guarded to the skill directory, capped at
  // 8 references / 64 KiB each, text-only content inlined.
  private async loadReferencedResources(
    skill: SkillDefinition,
  ): Promise<
    Array<{ path: string; content: string; size: number; digest: string }>
  > {
    const refs = Array.from(
      new Set(
        Array.from(
          skill.instructions.matchAll(
            /`((?:references|templates|scripts|assets)\/[^`]+)`/g,
          ),
          (m) => m[1].trim(),
        ),
      ),
    ).sort();
    if (refs.length > MAX_REFERENCED_RESOURCES) {
      throw new SkillRegistryError(
        `Skill ${skill.manifest.name} references more than ${MAX_REFERENCED_RESOURCES} resources`,
      );
    }
    const skillRoot = path.resolve(path.dirname(skill.path));
    const resources: Array<{
      path: string;
      content: string;
      size: number;
      digest: string;
    }> = [];
    for (const relative of refs) {
      const resolved = path.resolve(skillRoot, relative);
      if (
        resolved !== skillRoot &&
        !resolved.startsWith(skillRoot + path.sep)
      ) {
        throw new SkillRegistryError(
          `Skill ${skill.manifest.name} references a resource outside its directory: ${relative}`,
        );
      }
      let s;
      try {
        s = await stat(resolved);
      } catch {
        throw new SkillRegistryError(
          `Skill ${skill.manifest.name} references a missing resource: ${relative}`,
        );
      }
      if (!s.isFile()) {
        throw new SkillRegistryError(
          `Skill ${skill.manifest.name} references a non-file resource: ${relative}`,
        );
      }
      if (s.size > MAX_RESOURCE_BYTES) {
        throw new SkillRegistryError(
          `Skill ${skill.manifest.name} references a resource over ${MAX_RESOURCE_BYTES} bytes: ${relative}`,
        );
      }
      const bytes = await readFile(resolved);
      const isText = TEXT_SUFFIXES.has(path.extname(resolved).toLowerCase());
      resources.push({
        path: relative.replace(/\\/g, "/"),
        content: isText ? bytes.toString("utf8") : "",
        size: s.size,
        digest: createHash("sha256").update(bytes).digest("hex").slice(0, 16),
      });
    }
    return resources;
  }

  // Render activated skills as a system-prompt block (legacy _active_skill_prompt).
  static renderPromptBlock(
    activations: SkillActivation[],
    maxChars = 24_000,
  ): string {
    if (activations.length === 0) return "";
    const blocks = activations.map((a) => {
      const tools = a.tools.length > 0 ? a.tools.join(", ") : "none";
      const resourceSections = a.resources
        .filter((r) => r.content.trim() !== "")
        .map((r) => `### Resource: ${r.path}\n${r.content}`);
      const resourceText =
        resourceSections.length > 0
          ? `\n\nResources loaded on demand:\n\n${resourceSections.join("\n\n")}`
          : "";
      return [
        `## ${a.skillTitle} (${a.skillName} v${a.skillVersion})`,
        `Activation: ${a.activationMode}; reason: ${a.activationReason}`,
        `Suggested tools: ${tools}`,
        `Output contract: ${a.outputContract}; safety level: ${a.safetyLevel}`,
        "",
        a.instructions + resourceText,
      ].join("\n");
    });
    const joined = blocks.join("\n\n");
    return joined.length > maxChars
      ? `${joined.slice(0, maxChars)}\n[Skill instructions truncated for context budget]`
      : joined;
  }
}

let cachedRegistry: SkillRegistry | null = null;

// Load the registry from data/devflow-skills/*/SKILL.md. A missing directory
// yields an empty registry (skills are an enhancement, never a hard failure).
export async function getSkillRegistry(): Promise<SkillRegistry> {
  if (cachedRegistry) return cachedRegistry;
  let entries: string[] = [];
  try {
    entries = await readdir(SKILLS_DIR);
  } catch {
    cachedRegistry = new SkillRegistry([]);
    return cachedRegistry;
  }
  const skills: SkillDefinition[] = [];
  for (const entry of entries.sort()) {
    const file = path.join(SKILLS_DIR, entry, "SKILL.md");
    try {
      const s = await stat(file);
      if (!s.isFile()) continue;
      skills.push(await loadSkill(file));
    } catch {
      // Skip directories without a SKILL.md.
    }
  }
  cachedRegistry = new SkillRegistry(skills);
  return cachedRegistry;
}

// Test/reset hook (mirrors the legacy lru_cache clear).
export function resetSkillRegistry(): void {
  cachedRegistry = null;
}
