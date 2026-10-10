import { createHash } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import { load as loadYaml } from "js-yaml";
import { config } from "@/lib/config";
import { prisma } from "@/lib/db";
import { chunkDocument, siblingIdsByParent } from "./chunking";
import { chunkRowMetadata, getKnowledgeConfig } from "./rag";
import { indexChunks, deleteBySourcePrefix } from "@/lib/milvus/indexer";
import { scopedRetrieve } from "./search";
import {
  repoCheckoutPath,
  syncCheckout,
  workspaceStatus,
  WorkspaceError,
} from "./workspace";
import type { ProjectIndex, Repository } from "@/generated/prisma/client";
import { Prisma } from "@/generated/prisma/client";

const asJson = (value: unknown): Prisma.InputJsonValue =>
  value as Prisma.InputJsonValue;

const PROJECT_PREFIX = "devflow:project";
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  ".nuxt",
  "dist",
  "build",
  "coverage",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
]);
const SECRET_FILENAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".npmrc",
  ".pypirc",
]);

const MANIFEST_NAMES = new Set([
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "composer.json",
  "Gemfile",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);
const DOC_LIKE_EXT = new Set([".md", ".mdx", ".rst", ".txt", ".adoc"]);
const CONFIG_EXT = new Set([
  ".toml",
  ".yaml",
  ".yml",
  ".json",
  ".ini",
  ".conf",
  ".properties",
]);

export interface ProjectDocCandidate {
  rel: string;
  sourceType: string;
  tier: "core" | "docs" | "support";
}

export interface ProjectDocHit {
  path: string;
  sourceType: string;
  content: string;
  score: number;
}

export function projectFilter(repoId: string): string {
  return `source like "${PROJECT_PREFIX}:${repoId}:%"`;
}

function docSource(repoId: string, rel: string): string {
  const hash = createHash("sha256").update(rel).digest("hex").slice(0, 16);
  return `${PROJECT_PREFIX}:${repoId}:${hash}`;
}

function classify(rel: string): ProjectDocCandidate | null {
  const name = path.basename(rel);
  const lower = name.toLowerCase();
  if (SECRET_FILENAMES.has(name)) return null;
  const dirParts = path.dirname(rel).split(path.sep);
  const underDocs = dirParts.some((p) => p === "docs" || p === "doc");

  if (/^readme(\.|$)/i.test(name)) {
    return { rel, sourceType: "readme", tier: "core" };
  }
  if (MANIFEST_NAMES.has(name)) {
    return { rel, sourceType: "manifest", tier: "core" };
  }
  if (
    /^(changelog|contributing|license|security|authors|code_of_conduct)(\.|$)/i.test(
      name,
    )
  ) {
    return { rel, sourceType: "docs", tier: "docs" };
  }
  const ext = path.extname(lower);
  if (DOC_LIKE_EXT.has(ext)) {
    return { rel, sourceType: "docs", tier: underDocs ? "docs" : "docs" };
  }
  if (
    name.toLowerCase() === "dockerfile" ||
    name.toLowerCase() === "makefile" ||
    (dirParts.includes(".github") && CONFIG_EXT.has(ext)) ||
    (dirParts.length === 0 && CONFIG_EXT.has(ext) && !MANIFEST_NAMES.has(name))
  ) {
    return { rel, sourceType: "config", tier: "support" };
  }
  return null;
}

export async function discoverProjectDocs(
  checkout: string,
  maxFiles = 500,
  policy?: ProjectIndexPolicy,
): Promise<ProjectDocCandidate[]> {
  const out: ProjectDocCandidate[] = [];
  let visited = 0;
  const walk = async (dir: string): Promise<void> => {
    if (out.length >= maxFiles || visited > 5000) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (out.length >= maxFiles || visited > 5000) return;
      if (SKIP_DIRS.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        visited += 1;
        const rel = path.relative(checkout, abs).split(path.sep).join("/");
        const candidate = classify(rel);
        if (candidate && (!policy || policyAllows(candidate, policy))) {
          out.push(candidate);
        }
      }
    }
  };
  await walk(checkout);
  const tierRank: Record<string, number> = { core: 0, docs: 1, support: 2 };
  out.sort(
    (a, b) =>
      (tierRank[a.tier] ?? 3) - (tierRank[b.tier] ?? 3) ||
      a.rel.localeCompare(b.rel),
  );
  return out.slice(0, maxFiles);
}

function detectTechStack(files: Set<string>): string[] {
  const stack: string[] = [];
  if (files.has("package.json")) stack.push("JavaScript/TypeScript");
  if (files.has("tsconfig.json")) stack.push("TypeScript");
  if (
    files.has("pyproject.toml") ||
    files.has("requirements.txt") ||
    files.has("setup.py")
  )
    stack.push("Python");
  if (files.has("go.mod")) stack.push("Go");
  if (files.has("Cargo.toml")) stack.push("Rust");
  if (files.has("pom.xml") || files.has("build.gradle")) stack.push("Java");
  if (files.has("composer.json")) stack.push("PHP");
  if (files.has("Gemfile")) stack.push("Ruby");
  return stack;
}

export async function buildSummary(
  checkout: string,
  candidates: ProjectDocCandidate[],
): Promise<Record<string, unknown>> {
  const topEntries = await readdir(checkout, { withFileTypes: true }).catch(
    () => [],
  );
  const topDirs = topEntries
    .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name))
    .map((e) => e.name)
    .sort()
    .slice(0, 12);
  const rootFiles = new Set(
    topEntries.filter((e) => e.isFile()).map((e) => e.name),
  );
  const sourceTypeCoverage: Record<string, number> = {};
  for (const c of candidates) {
    sourceTypeCoverage[c.sourceType] =
      (sourceTypeCoverage[c.sourceType] ?? 0) + 1;
  }
  return {
    techStack: detectTechStack(rootFiles),
    topDirs,
    sourceTypeCoverage,
    docs: candidates.slice(0, 200).map((c) => ({
      path: c.rel,
      tier: c.tier,
      sourceType: c.sourceType,
    })),
  };
}

export function projectFingerprint(
  branch: string | null,
  commitSha: string | null,
  policyDigest = "",
): string {
  const base = `${branch ?? "?"}@${commitSha ? commitSha.slice(0, 12) : "?"}`;
  return policyDigest === "" ? base : `${base}:${policyDigest}`;
}

export interface ProjectIndexPolicy {
  mode: "auto" | "allowlist";
  include: string[];
  exclude: string[];
  includeManifests: boolean;
}

const DEFAULT_POLICY: ProjectIndexPolicy = {
  mode: "auto",
  include: [],
  exclude: [],
  includeManifests: true,
};

export function globToRegExp(pattern: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i] as string;
    if (ch === "*") {
      re += ".*";
      i += 1;
    } else if (ch === "?") {
      re += ".";
      i += 1;
    } else if (ch === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) {
        re += "\\[";
        i += 1;
      } else {
        let inner = pattern.slice(i + 1, close);
        if (inner.startsWith("!")) inner = `^${inner.slice(1)}`;
        re += `[${inner}]`;
        i = close + 1;
      }
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`${re}$`);
}

function matchesAny(rel: string, patterns: string[]): boolean {
  return patterns.some((p) => globToRegExp(p).test(rel));
}

const INDEX_POLICY_SCHEMA = z.object({
  version: z.union([z.number(), z.string()]).optional(),
  project_docs: z
    .object({
      mode: z.enum(["auto", "allowlist"]).optional(),
      include: z.array(z.string()).optional(),
      exclude: z.array(z.string()).optional(),
    })
    .optional(),
  include_manifests: z.boolean().optional(),
});

export function parseIndexPolicyYaml(raw: string): ProjectIndexPolicy {
  let parsed: unknown;
  try {
    parsed = loadYaml(raw);
  } catch (e) {
    throw new Error(
      `Could not read .devflow/index.yml: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (parsed === null || parsed === undefined) return { ...DEFAULT_POLICY };
  const validated = INDEX_POLICY_SCHEMA.safeParse(parsed);
  if (!validated.success) {
    throw new Error(
      `.devflow/index.yml is invalid: ${validated.error.issues.map((i) => i.message).join(", ")}`,
    );
  }
  const version = validated.data.version ?? 1;
  if (Number(version) !== 1) {
    throw new Error(`Unsupported project index config version: ${version}`);
  }
  const docs = validated.data.project_docs ?? {};
  const mode = docs.mode ?? "auto";
  const include = docs.include ?? [];
  if (mode === "allowlist" && include.length === 0) {
    throw new Error(
      "project_docs.include cannot be empty when mode is allowlist",
    );
  }
  return {
    mode,
    include,
    exclude: docs.exclude ?? [],
    includeManifests: validated.data.include_manifests ?? true,
  };
}

export async function loadProjectIndexPolicy(
  checkout: string,
): Promise<ProjectIndexPolicy> {
  try {
    const raw = await readFile(
      path.join(checkout, ".devflow", "index.yml"),
      "utf8",
    );
    return parseIndexPolicyYaml(raw);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Could not read")) throw e;
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      return { ...DEFAULT_POLICY };
    if (e instanceof Error && e.message.startsWith(".devflow/index.yml"))
      throw e;
    return { ...DEFAULT_POLICY };
  }
}

export function policyDigest(policy: ProjectIndexPolicy): string {
  const payload = JSON.stringify([
    policy.mode,
    policy.include,
    policy.exclude,
    policy.includeManifests,
  ]);
  return createHash("sha256").update(payload).digest("hex").slice(0, 8);
}

export function policyAllows(
  candidate: { rel: string; sourceType: string },
  policy: ProjectIndexPolicy,
): boolean {
  if (matchesAny(candidate.rel, policy.exclude)) return false;
  if (candidate.sourceType === "manifest") return policy.includeManifests;
  if (policy.mode === "allowlist")
    return matchesAny(candidate.rel, policy.include);
  return true;
}

async function readBounded(
  file: string,
  maxBytes: number,
): Promise<string | null> {
  try {
    const data = await readFile(file);
    if (data.length === 0 || data.length > maxBytes) return null;
    if (data.subarray(0, 4096).includes(0)) return null;
    return data.toString("utf8");
  } catch {
    return null;
  }
}

type ProjectIndexPatch = Partial<{
  status: string;
  fingerprint: string | null;
  branch: string | null;
  commitSha: string | null;
  fileCount: number;
  chunkCount: number;
  summary: Record<string, unknown>;
  errorMessage: string | null;
  snoozedUntil: Date | null;
  lastIndexedAt: Date | null;
}>;

async function setState(
  repoId: string,
  data: ProjectIndexPatch,
): Promise<void> {
  const { summary, ...rest } = data;
  const fields = {
    ...rest,
    ...(summary ? { summary: asJson(summary) } : {}),
  };
  await prisma.projectIndex.upsert({
    where: { repoId },
    create: { repoId, ...fields },
    update: fields,
  });
}

export async function getProjectIndexState(repo: Repository): Promise<{
  index: ProjectIndex | null;
  stale: boolean;
  checkoutCloned: boolean;
}> {
  const index = await prisma.projectIndex.findUnique({
    where: { repoId: repo.id },
  });
  const status = await workspaceStatus(repo);
  let stale = false;
  if (index && index.status === "ready" && status.cloned) {
    const policy = await loadProjectIndexPolicy(status.path).catch(
      () => undefined,
    );
    const current = projectFingerprint(
      status.branch,
      status.commitSha,
      policy ? policyDigest(policy) : "",
    );
    stale = index.fingerprint !== current;
  }
  return { index, stale, checkoutCloned: status.cloned };
}

function extractTitle(text: string, fallback: string): string {
  for (const line of text.split("\n")) {
    const stripped = line.trim();
    if (stripped.startsWith("# ")) {
      const title = stripped.slice(2).trim().slice(0, 500);
      if (title !== "") return title;
      return fallback;
    }
  }
  return fallback;
}

export async function indexProject(repo: Repository): Promise<{
  fileCount: number;
  chunkCount: number;
  fingerprint: string;
}> {
  await setState(repo.id, { status: "building", errorMessage: null });
  try {
    const checkout = repoCheckoutPath(repo);
    const synced = await syncCheckout(repo);
    await mkdir(path.dirname(checkout), { recursive: true });
    const policy = await loadProjectIndexPolicy(synced.path);
    const candidates = await discoverProjectDocs(synced.path, 500, policy);
    const fingerprint = projectFingerprint(
      synced.branch,
      synced.commitSha,
      policyDigest(policy),
    );
    const scannedAt = new Date().toISOString();

    await deleteBySourcePrefix(`${PROJECT_PREFIX}:${repo.id}:`);

    const maxBytes = config.devflow.workspace.maxFileBytes;
    let chunkCount = 0;
    for (const candidate of candidates) {
      const abs = path.join(synced.path, ...candidate.rel.split("/"));
      const text = await readBounded(abs, maxBytes);
      if (text === null) continue;
      const chunks = chunkDocument(text, candidate.rel, 1800, 180);
      if (chunks.length === 0) continue;
      const source = docSource(repo.id, candidate.rel);
      const docTitle = extractTitle(text, candidate.rel);
      const idFor = (i: number) =>
        createHash("sha256")
          .update(`${repo.id}:${candidate.rel}#${i}`)
          .digest("hex");
      const siblings = siblingIdsByParent(chunks, idFor);
      await indexChunks(
        chunks.map((chunk, i) => {
          const title = chunk.section_title
            ? `${docTitle} · ${chunk.section_title}`
            : chunks.length > 1
              ? `${docTitle}#${i + 1}`
              : docTitle;
          return {
            id: idFor(i),
            content: chunk.content,
            embedText: `${title}\n${chunk.content}`,
            metadata: {
              ...chunkRowMetadata(
                chunk,
                {
                  _source: source,
                  repo_id: repo.id,
                  path: candidate.rel,
                  source_type: candidate.sourceType,
                  tier: candidate.tier,
                  display_title: docTitle,
                  provenance_tier: candidate.tier,
                  chunk_index: i,
                  chunk_chars: chunk.content.length,
                  total_chunks: chunks.length,
                  fingerprint,
                  scanned_at: scannedAt,
                },
                siblings[i] ?? ["", idFor(i), ""],
              ),
            },
          };
        }),
      );
      chunkCount += chunks.length;
    }

    const summary = await buildSummary(synced.path, candidates);
    await setState(repo.id, {
      status: "ready",
      fingerprint,
      branch: synced.branch,
      commitSha: synced.commitSha,
      fileCount: candidates.length,
      chunkCount,
      summary,
      errorMessage: null,
      lastIndexedAt: new Date(),
    });
    return { fileCount: candidates.length, chunkCount, fingerprint };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await setState(repo.id, { status: "failed", errorMessage: message }).catch(
      () => {},
    );
    throw e instanceof WorkspaceError ? e : new WorkspaceError(message, 500);
  }
}

export async function searchProjectDocs(
  repoId: string,
  query: string,
  topK = 5,
): Promise<ProjectDocHit[]> {
  const cfg = await getKnowledgeConfig(repoId);
  const docs = await scopedRetrieve(query, topK, projectFilter(repoId), {
    method: cfg.retrievalMethod,
    rerank: cfg.rerankEnabled,
  });
  return docs.map((doc) => ({
    path: String(doc.metadata.path ?? "unknown"),
    sourceType: String(doc.metadata.source_type ?? "unknown"),
    content: doc.content,
    score: doc.score,
  }));
}
