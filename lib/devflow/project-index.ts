// Category B: project-doc index. Discovers a repository's documentation and
// manifests from its managed checkout, chunks + embeds them into the shared
// Milvus collection (source = "devflow:project:<repoId>:<docHash>"), and tracks
// a per-repo ProjectIndex row (status/fingerprint/summary) in PostgreSQL.
// Port of the Python project_indexing.py discovery + indexing (minus the
// policy-file loader, kept to a built-in classification). Vectors live in
// Milvus; only state + summary live in Postgres.
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { config } from "@/lib/config";
import { prisma } from "@/lib/db";
import { chunkText } from "./rag";
import { indexChunks, deleteBySourcePrefix } from "@/lib/milvus/indexer";
import { retrieve } from "@/lib/milvus/retriever";
import {
  repoCheckoutPath,
  syncCheckout,
  workspaceStatus,
  WorkspaceError,
} from "./workspace";
import type { ProjectIndex, Repository } from "@/generated/prisma/client";
import { Prisma } from "@/generated/prisma/client";

// Prisma's InputJsonValue rejects `unknown` leaves; the persisted payloads are
// already JSON-serializable, so assert once at the boundary.
const asJson = (value: unknown): Prisma.InputJsonValue =>
  value as Prisma.InputJsonValue;

const PROJECT_PREFIX = "devflow:project";
const SKIP_DIRS = new Set([
  ".git", "node_modules", ".next", ".nuxt", "dist", "build", "coverage",
  "vendor", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache",
]);
const SECRET_FILENAMES = new Set([".env", ".env.local", ".env.production", ".npmrc", ".pypirc"]);

const MANIFEST_NAMES = new Set([
  "package.json", "pyproject.toml", "requirements.txt", "setup.py", "go.mod",
  "Cargo.toml", "pom.xml", "build.gradle", "composer.json", "Gemfile",
  "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
]);
const DOC_LIKE_EXT = new Set([".md", ".mdx", ".rst", ".txt", ".adoc"]);
const CONFIG_EXT = new Set([".toml", ".yaml", ".yml", ".json", ".ini", ".conf", ".properties"]);

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
  if (/^(changelog|contributing|license|security|authors|code_of_conduct)(\.|$)/i.test(name)) {
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
        if (candidate) out.push(candidate);
      }
    }
  };
  await walk(checkout);
  // Deterministic order: core first, then docs, then support; path as tiebreak.
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
  if (files.has("pyproject.toml") || files.has("requirements.txt") || files.has("setup.py"))
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
  const topEntries = await readdir(checkout, { withFileTypes: true }).catch(() => []);
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
    sourceTypeCoverage[c.sourceType] = (sourceTypeCoverage[c.sourceType] ?? 0) + 1;
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

export function projectFingerprint(branch: string | null, commitSha: string | null): string {
  return `${branch ?? "?"}@${commitSha ? commitSha.slice(0, 12) : "?"}`;
}

async function readBounded(file: string, maxBytes: number): Promise<string | null> {
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

async function setState(repoId: string, data: ProjectIndexPatch): Promise<void> {
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

export async function getProjectIndexState(
  repo: Repository,
): Promise<{ index: ProjectIndex | null; stale: boolean; checkoutCloned: boolean }> {
  const index = await prisma.projectIndex.findUnique({ where: { repoId: repo.id } });
  const status = await workspaceStatus(repo);
  let stale = false;
  if (index && index.status === "ready" && status.cloned) {
    const current = projectFingerprint(status.branch, status.commitSha);
    stale = index.fingerprint !== current;
  }
  return { index, stale, checkoutCloned: status.cloned };
}

// Index a repository's project docs into Milvus. Requires the checkout to exist
// (clones it first if needed). Embedding depends on a valid embedding API key
// (same dependency as the knowledge base).
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
    const candidates = await discoverProjectDocs(synced.path);
    const fingerprint = projectFingerprint(synced.branch, synced.commitSha);

    // Clear the previous project-doc vectors for this repo, then re-add.
    await deleteBySourcePrefix(`${PROJECT_PREFIX}:${repo.id}:`);

    const maxBytes = config.devflow.workspace.maxFileBytes;
    let chunkCount = 0;
    for (const candidate of candidates) {
      const abs = path.join(synced.path, ...candidate.rel.split("/"));
      const text = await readBounded(abs, maxBytes);
      if (text === null) continue;
      const chunks = chunkText(text);
      if (chunks.length === 0) continue;
      const source = docSource(repo.id, candidate.rel);
      await indexChunks(
        chunks.map((content, i) => ({
          id: `${createHash("sha256").update(`${repo.id}:${candidate.rel}#${i}`).digest("hex")}`,
          content,
          metadata: {
            _source: source,
            repo_id: repo.id,
            path: candidate.rel,
            source_type: candidate.sourceType,
            tier: candidate.tier,
            chunk_index: i,
          },
        })),
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
    await setState(repo.id, { status: "failed", errorMessage: message }).catch(() => {});
    throw e instanceof WorkspaceError ? e : new WorkspaceError(message, 500);
  }
}

export async function searchProjectDocs(
  repoId: string,
  query: string,
  topK = 5,
): Promise<ProjectDocHit[]> {
  const docs = await retrieve(query, topK, projectFilter(repoId));
  return docs.map((doc) => ({
    path: String(doc.metadata.path ?? "unknown"),
    sourceType: String(doc.metadata.source_type ?? "unknown"),
    content: doc.content,
    score: doc.score,
  }));
}
