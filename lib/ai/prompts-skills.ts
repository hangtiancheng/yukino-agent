// User-managed chat prompts + SKILL.md skill assets — port of the legacy
// agent_py `super_ai/chat/configuration.py` + `chat/streaming.py:551-574`.
//
// The legacy surface was per-user (auth-scoped assets). This deployment is a
// public single tenant (AGENTS.md), so assets are administrator-managed and
// global: the Prisma `ChatPrompt` / `SkillAsset` models back the REST routes,
// and only ENABLED skills participate in the prompt catalog / load_skill.
//
// Progressive disclosure is kept verbatim from legacy: the system prompt
// carries only `name: description` lines (configuration.py:62-76); the full
// instruction body is returned on demand by the `load_skill` tool
// (streaming.py:551-574), and unknown names fail honestly with the list of
// loadable names instead of fabricating content.
import { load } from "js-yaml";
import { tool } from "ai";
import { prisma } from "@/lib/db";
import { loadSkillSchema } from "@/lib/ai/tools/schemas";

// Legacy limits (configuration.py:17-20).
export const MAX_CHAT_PROMPT_NAME_LENGTH = 160;
export const MAX_CHAT_PROMPT_CONTENT_LENGTH = 12000;
export const MAX_SKILL_BYTES = 65536;
export const MAX_SKILL_NAME_LENGTH = 64;
export const MAX_SKILL_DESCRIPTION_LENGTH = 1024;

// Legacy _SKILL_FRONTMATTER_PATTERN (configuration.py:21).
const SKILL_FRONTMATTER_PATTERN =
  /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export interface SkillValidationOk {
  name: string;
  description: string;
  content: string;
}
export type SkillValidationResult =
  { ok: true; skill: SkillValidationOk } | { ok: false; error: string };

// Legacy _is_valid_skill_name (configuration.py:137-145): 1-64 chars of
// lowercase letters / digits / single hyphens, no leading/trailing/double '-'.
export function isValidSkillName(name: string): boolean {
  if (name === "" || name.length > MAX_SKILL_NAME_LENGTH) return false;
  if (name.startsWith("-") || name.endsWith("-") || name.includes("--")) {
    return false;
  }
  return [...name].every(
    (c) => c === "-" || (c >= "0" && c <= "9") || (c >= "a" && c <= "z"),
  );
}

// Port of validate_skill_upload (configuration.py:91-134), minus the
// multipart filename gate (the REST route checks `fileName === "SKILL.md"`
// when one is supplied) — the content rules are unchanged.
export function validateSkillMarkdown(
  content: string,
  fileName?: string,
): SkillValidationResult {
  if (fileName !== undefined && fileName !== "SKILL.md") {
    return {
      ok: false,
      error: "The skill file name must be exactly SKILL.md.",
    };
  }
  const trimmed = content.trim();
  if (trimmed === "") {
    return {
      ok: false,
      error: "The skill file must not be empty UTF-8 Markdown.",
    };
  }
  if (Buffer.byteLength(content, "utf8") > MAX_SKILL_BYTES) {
    return { ok: false, error: "The skill file must not exceed 64 KB." };
  }
  const match = SKILL_FRONTMATTER_PATTERN.exec(trimmed);
  if (match === null) {
    return {
      ok: false,
      error:
        "SKILL.md must start with a YAML frontmatter block containing name and description.",
    };
  }
  let parsed: unknown;
  try {
    parsed = load(match[1]);
  } catch {
    return { ok: false, error: "The SKILL.md YAML frontmatter is invalid." };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      error: "The SKILL.md YAML frontmatter must be a key-value mapping.",
    };
  }
  const metadata = parsed as Record<string, unknown>;
  const name =
    typeof metadata["name"] === "string" ? metadata["name"].trim() : "";
  if (!isValidSkillName(name)) {
    return {
      ok: false,
      error:
        "Skill name must be 1-64 lowercase letters, digits or single hyphens, without a leading or trailing hyphen.",
    };
  }
  const description =
    typeof metadata["description"] === "string"
      ? metadata["description"].trim()
      : "";
  if (description === "") {
    return {
      ok: false,
      error:
        "Skill description must not be empty and should state the capability and when to use it.",
    };
  }
  if (description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
    return {
      ok: false,
      error: "Skill description must not exceed 1024 characters.",
    };
  }
  return { ok: true, skill: { name, description, content: trimmed } };
}

// Port of validate_chat_prompt_content (configuration.py:80-88).
export type PromptValidationResult =
  { ok: true; name: string; content: string } | { ok: false; error: string };

export function validateChatPrompt(
  name: string,
  content: string,
): PromptValidationResult {
  const normalizedName = name.trim();
  const normalizedContent = content.trim();
  if (normalizedName === "" || normalizedContent === "") {
    return {
      ok: false,
      error: "Prompt name and content must both be non-empty.",
    };
  }
  if (
    normalizedName.length > MAX_CHAT_PROMPT_NAME_LENGTH ||
    normalizedContent.length > MAX_CHAT_PROMPT_CONTENT_LENGTH
  ) {
    return {
      ok: false,
      error: `Prompt name must not exceed ${MAX_CHAT_PROMPT_NAME_LENGTH} characters and content must not exceed ${MAX_CHAT_PROMPT_CONTENT_LENGTH} characters.`,
    };
  }
  return { ok: true, name: normalizedName, content: normalizedContent };
}

// Catalog injection — port of the "## Available Skills" section built by
// configuration.py:62-76. Returns "" (no section) when no skill is enabled
// or the database is unreachable, so prompt assembly degrades honestly.
export async function getSkillCatalogPrompt(): Promise<string> {
  try {
    const skills = await prisma.skillAsset.findMany({
      where: { enabled: true },
      orderBy: { name: "asc" },
    });
    if (skills.length === 0) return "";
    const catalog = skills
      .map((s) => `- **${s.name}**: ${s.description}`)
      .join("\n");
    return [
      "## Available Skills",
      catalog,
      "Only the skills listed above are available in this session. When the user's task matches a skill's description you MUST first call `load_skill` with that skill's name, then follow the full instructions it returns. Never guess or claim to have loaded a skill you did not call.",
    ].join("\n");
  } catch (e) {
    console.error("[skills] catalog load failed:", e);
    return "";
  }
}

// Custom-instruction injection — port of the legacy chat configuration's
// selected system prompt (agent_py chat/configuration.py build_chat_system_prompt:
// "用户选择的系统提示词" section). Single-tenant public form: every ENABLED
// ChatPrompt preset is applied (newest first), so administrator-defined
// instructions actually reach the model instead of sitting unused in the DB.
// Degrades to "" (no section) when none are enabled or the store is unreadable.
export async function getChatPromptSection(): Promise<string> {
  try {
    const prompts = await prisma.chatPrompt.findMany({
      where: { enabled: true },
      orderBy: { updatedAt: "desc" },
    });
    if (prompts.length === 0) return "";
    const body = prompts
      .map((p) =>
        prompts.length > 1
          ? `### ${p.name}\n${p.content.trim()}`
          : p.content.trim(),
      )
      .join("\n\n");
    return `\n\n## Custom instructions\n${body}`;
  } catch (e) {
    console.error("[prompts] custom instruction load failed:", e);
    return "";
  }
}

export interface LoadedSkill {
  name: string;
  content: string;
}

// Legacy load_skill body (streaming.py:555-567): registry lookup by exact
// name, honest failure listing the available names, `Loaded skill: ...`
// prefix on success.
export async function loadSkill(name: string): Promise<string> {
  const requested = name.trim();
  let available: string[] = [];
  try {
    const skills = await prisma.skillAsset.findMany({
      where: { enabled: true },
      select: { name: true, content: true },
      orderBy: { name: "asc" },
    });
    available = skills.map((s) => s.name);
    const hit = skills.find((s) => s.name === requested);
    if (hit) return `Loaded skill: ${hit.name}\n\n${hit.content}`;
  } catch (e) {
    return `Skill '${requested}' is unavailable: the skill store could not be read (${e instanceof Error ? e.message : String(e)}).`;
  }
  return `Skill '${requested}' is not available. Currently loadable skills: ${available.join(", ") || "none"}.`;
}

export const loadSkillTool = tool({
  description:
    "Load the full instructions of an available skill by name. Call ONLY when the user's task matches a skill description from the Available Skills catalog, then follow the returned instructions.",
  inputSchema: loadSkillSchema,
  execute: async (input) => loadSkill(input.skill_name),
});
