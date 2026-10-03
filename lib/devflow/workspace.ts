// Category B: server-side managed git checkouts + workspace file tools.
// Faithful TS port of the Python code_analysis._sync_checkout (clone/refresh)
// and code_search (path-guarded list/read/lexical-search), MINUS the git
// worktree lifecycle (intentionally not migrated). Clones are shallow
// (--depth 1) and stored under config.devflow.workspace.checkoutDir.
//
// SECURITY: every file operation resolves the requested path and asserts it
// stays inside the checkout (no traversal), skips VCS/build dirs, and refuses
// secret files (.env, .npmrc, ...). git runs via execFile with an argv array
// (no shell), so repo/branch/token values cannot inject commands.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { config } from "@/lib/config";
import { prisma } from "@/lib/db";
import { decryptToken } from "./crypto";
import type { Repository } from "@/generated/prisma/client";

const execFileAsync = promisify(execFile);

export class WorkspaceError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

const SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
]);

const SECRET_FILENAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".npmrc",
  ".pypirc",
]);

const TEXT_EXTENSIONS = new Set([
  ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".java", ".go", ".rs",
  ".cs", ".cpp", ".c", ".h", ".hpp", ".php", ".rb", ".swift", ".kt", ".kts",
  ".scala", ".sql", ".sh", ".ps1", ".bat", ".cmd", ".html", ".css", ".scss",
  ".json", ".yaml", ".yml", ".toml", ".ini", ".md", ".mdx", ".txt",
]);

const TEXT_FILENAMES = new Set([
  "Dockerfile",
  "Makefile",
  "README",
  "LICENSE",
  "package.json",
  "requirements.txt",
  "pyproject.toml",
]);

const QUERY_TOKEN_RE =
  /[A-Za-z_$][A-Za-z0-9_.$:/\\-]*|[0-9]{3,}|[\u4e00-\u9fff]{2,}/g;

const STOP_TERMS = new Set([
  "about", "after", "before", "code", "error", "failed", "failure", "file",
  "from", "into", "issue", "project", "pull", "request", "test", "tests",
  "that", "the", "this", "with",
]);

// ---------------------------------------------------------------------------
// Paths + git
// ---------------------------------------------------------------------------

export function workspaceRoot(): string {
  const dir = config.devflow.workspace.checkoutDir;
  const abs = path.isAbsolute(dir) ? dir : path.resolve(process.cwd(), dir);
  return abs;
}

export function repoCheckoutPath(repo: Repository): string {
  const safeName = repo.fullName.replace(/[\\/]/g, "__");
  return path.join(workspaceRoot(), `${repo.id}-${safeName}`);
}

function cloneUrl(repo: Repository): string {
  let host = "github.com";
  if (repo.apiBaseUrl) {
    try {
      host = new URL(repo.apiBaseUrl).host;
    } catch {
      // fall back to github.com
    }
  }
  return `https://${host}/${repo.owner}/${repo.name}.git`;
}

function cloneUrlWithToken(url: string, token: string | null): string {
  if (!token) return url;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return url;
    if (parsed.username) return url;
    parsed.username = "x-access-token";
    parsed.password = token;
    return parsed.toString();
  } catch {
    return url;
  }
}

async function runGit(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, {
    cwd,
    timeout: config.devflow.workspace.gitTimeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    // Never let git prompt for credentials interactively; fail fast instead.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

async function gitText(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function isGitWorkTree(dir: string): Promise<boolean> {
  try {
    const s = await stat(dir);
    if (!s.isDirectory()) return false;
  } catch {
    return false;
  }
  const out = await gitText(["rev-parse", "--is-inside-work-tree"], dir);
  return out?.toLowerCase() === "true";
}

// Dedupe concurrent clone/refresh of the same repo (globalThis survives HMR).
const globalForSync = globalThis as unknown as {
  devflowWorkspaceSync?: Map<string, Promise<SyncResult>>;
};
function syncMap(): Map<string, Promise<SyncResult>> {
  if (!globalForSync.devflowWorkspaceSync) {
    globalForSync.devflowWorkspaceSync = new Map();
  }
  return globalForSync.devflowWorkspaceSync;
}

export interface SyncResult {
  path: string;
  branch: string | null;
  commitSha: string | null;
  cloned: boolean;
}

export interface WorkspaceStatus {
  cloned: boolean;
  path: string;
  branch: string | null;
  commitSha: string | null;
}

// Clone (shallow) or refresh a repository's checkout. Safe to call repeatedly.
export function syncCheckout(repo: Repository): Promise<SyncResult> {
  const map = syncMap();
  const existing = map.get(repo.id);
  if (existing) return existing;
  const task = doSyncCheckout(repo).finally(() => map.delete(repo.id));
  map.set(repo.id, task);
  return task;
}

async function doSyncCheckout(repo: Repository): Promise<SyncResult> {
  const target = repoCheckoutPath(repo);
  const branch = repo.defaultBranch || "main";
  const token = repo.tokenEncrypted ? decryptToken(repo.tokenEncrypted) : null;
  const url = cloneUrlWithToken(cloneUrl(repo), token);

  if (await isGitWorkTree(target)) {
    // Best-effort refresh; on failure keep the cached checkout (like the source).
    try {
      await runGit(["fetch", "--depth", "1", "origin", branch], target);
      await runGit(["checkout", branch], target);
      await runGit(["pull", "--ff-only", "origin", branch], target);
    } catch (e) {
      console.warn(
        `[devflow:workspace] refresh failed for ${repo.fullName}, using cache:`,
        e instanceof Error ? e.message : String(e),
      );
    }
    return {
      path: target,
      branch: (await gitText(["branch", "--show-current"], target)) ?? branch,
      commitSha: await gitText(["rev-parse", "HEAD"], target),
      cloned: true,
    };
  }

  await mkdir(path.dirname(target), { recursive: true });
  // Remove a non-git leftover directory before cloning.
  try {
    await rm(target, { recursive: true, force: true });
  } catch {
    // ignore
  }
  const cloneArgs = ["clone", "--depth", "1"];
  if (branch) cloneArgs.push("--branch", branch);
  cloneArgs.push(url, target);
  try {
    await runGit(cloneArgs, path.dirname(target));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Never leak the token in an error surfaced to the client.
    throw new WorkspaceError(
      `git clone failed: ${msg.replaceAll(token ?? "\u0000", "***")}`,
      502,
    );
  }
  return {
    path: target,
    branch: (await gitText(["branch", "--show-current"], target)) ?? branch,
    commitSha: await gitText(["rev-parse", "HEAD"], target),
    cloned: true,
  };
}

export async function workspaceStatus(repo: Repository): Promise<WorkspaceStatus> {
  const target = repoCheckoutPath(repo);
  const cloned = await isGitWorkTree(target);
  return {
    cloned,
    path: target,
    branch: cloned
      ? ((await gitText(["branch", "--show-current"], target)) ?? null)
      : null,
    commitSha: cloned ? await gitText(["rev-parse", "HEAD"], target) : null,
  };
}

// ---------------------------------------------------------------------------
// Path guarding + text helpers
// ---------------------------------------------------------------------------

function isTextFile(name: string): boolean {
  if (SECRET_FILENAMES.has(name)) return false;
  const lower = name.toLowerCase();
  if (/\.(log|db|sqlite|sqlite3)$/.test(lower)) return false;
  if (TEXT_FILENAMES.has(name)) return true;
  const ext = path.extname(lower);
  return TEXT_EXTENSIONS.has(ext) || lower.endsWith("dockerfile");
}

function relParts(checkout: string, rel: string): string[] {
  const requested = (rel || ".").trim();
  const normalized =
    requested === "" || requested === "." || requested === "./"
      ? "."
      : requested.replace(/^[\\/]+/, "");
  const resolved = path.resolve(checkout, normalized);
  const relative = path.relative(checkout, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new WorkspaceError("Path is outside the repository workspace");
  }
  const parts = relative === "" ? [] : relative.split(path.sep);
  if (parts.some((p) => SKIP_DIRS.has(p))) {
    throw new WorkspaceError("Path is inside a skipped directory");
  }
  if (parts.length > 0 && SECRET_FILENAMES.has(parts[parts.length - 1])) {
    throw new WorkspaceError("Refusing to access a secret config file");
  }
  return parts;
}

async function readTextBounded(
  file: string,
  maxBytes: number,
): Promise<string | null> {
  try {
    const data = await readFile(file);
    if (data.length === 0 || data.length > maxBytes) return null;
    if (data.subarray(0, 4096).includes(0)) return null; // binary
    return data.toString("utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// File tools
// ---------------------------------------------------------------------------

export interface FileEntry {
  path: string;
  type: "file" | "dir";
  size: number | null;
}

// Bounded recursive listing of files under a directory (relative posix paths).
export async function listFiles(
  checkout: string,
  relPath: string,
  limit = 200,
): Promise<FileEntry[]> {
  const parts = relParts(checkout, relPath);
  const root = path.resolve(checkout, ...parts);
  const s = await stat(root).catch(() => null);
  if (!s) throw new WorkspaceError("Path does not exist", 404);
  if (!s.isDirectory()) throw new WorkspaceError("Path is not a directory");

  const cap = Math.max(1, Math.min(limit, 1000));
  const out: FileEntry[] = [];
  const walk = async (dir: string): Promise<void> => {
    if (out.length >= cap) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= cap) return;
      if (SKIP_DIRS.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(checkout, abs).split(path.sep).join("/");
      if (entry.isDirectory()) {
        out.push({ path: rel, type: "dir", size: null });
        await walk(abs);
      } else if (entry.isFile()) {
        if (SECRET_FILENAMES.has(entry.name)) continue;
        const st = await stat(abs).catch(() => null);
        out.push({ path: rel, type: "file", size: st ? st.size : null });
      }
    }
  };
  await walk(root);
  return out.slice(0, cap);
}

export interface FileContent {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
}

// Read a text file (optionally a line range). Refuses binaries and secrets.
export async function readCodeFile(
  checkout: string,
  relPath: string,
  opts: { startLine?: number; lineCount?: number } = {},
): Promise<FileContent> {
  const parts = relParts(checkout, relPath);
  if (parts.length === 0) throw new WorkspaceError("Path is required");
  const abs = path.resolve(checkout, ...parts);
  const name = parts[parts.length - 1];
  const s = await stat(abs).catch(() => null);
  if (!s || !s.isFile()) throw new WorkspaceError("File not found", 404);
  if (!isTextFile(name)) {
    throw new WorkspaceError("Not a readable text file (binary or excluded)");
  }
  const text = await readTextBounded(abs, config.devflow.workspace.maxFileBytes);
  if (text === null) {
    throw new WorkspaceError("File is empty, binary, or too large to read");
  }
  const lines = text.split("\n");
  const total = lines.length;
  const start = Math.max(1, opts.startLine ?? 1);
  const count = Math.max(1, opts.lineCount ?? total);
  const end = Math.min(start + count - 1, total);
  const truncated = start > 1 || end < total;
  const slice = lines.slice(start - 1, end).join("\n");
  return {
    path: parts.join("/"),
    content: slice,
    startLine: start,
    endLine: end,
    totalLines: total,
    truncated,
  };
}

export function queryTerms(query: string, limit = 16): string[] {
  const primary: Array<[number, number, string]> = [];
  const fallback: Array<[number, number, string]> = [];
  const seen = new Set<string>();
  for (const match of (query || "").matchAll(QUERY_TOKEN_RE)) {
    const value = match[0].trim();
    const normalized = value.toLowerCase();
    if (normalized.length < 2 || seen.has(normalized)) continue;
    seen.add(normalized);
    const codeLike =
      /[_.$:/\\\-0-9]/.test(value) ||
      (/[a-z]/.test(value) && /[A-Z]/.test(value));
    const candidate: [number, number, string] = [
      codeLike ? 1 : 0,
      value.length,
      normalized,
    ];
    fallback.push(candidate);
    if (!STOP_TERMS.has(normalized)) primary.push(candidate);
  }
  const chosen = primary.length ? primary : fallback;
  chosen.sort((a, b) => b[0] - a[0] || b[1] - a[1] || a[2].localeCompare(b[2]));
  return chosen.slice(0, Math.max(1, limit)).map((c) => c[2]);
}

function scoreMatch(relPath: string, line: string, terms: string[]): number {
  const pathText = relPath.toLowerCase();
  const lineText = line.toLowerCase();
  let matched = 0;
  let occurrences = 0;
  let pathHits = 0;
  for (const term of terms) {
    if (lineText.includes(term) || pathText.includes(term)) matched += 1;
    occurrences += Math.min(countOccurrences(lineText, term), 4);
    pathHits += countOccurrences(pathText, term);
  }
  return matched * 4 + occurrences + pathHits * 2;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

export interface CodeSearchHit {
  path: string;
  line: number;
  snippet: string;
  score: number;
}

// Bounded lexical code search (port of code_search._python_matches). Scans text
// files under the root, scores each line against the query terms, keeps the best
// line per file, and returns the top `limit` files.
export async function searchCode(
  checkout: string,
  query: string,
  relPath?: string,
  limit = 12,
): Promise<CodeSearchHit[]> {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const parts = relParts(checkout, relPath ?? ".");
  const root = path.resolve(checkout, ...parts);
  const s = await stat(root).catch(() => null);
  if (!s) throw new WorkspaceError("Path does not exist", 404);

  const cappedLimit = Math.max(1, Math.min(limit, 50));
  const maxScan = config.devflow.workspace.maxScanFiles;
  const maxBytes = config.devflow.workspace.maxFileBytes;
  const best = new Map<string, CodeSearchHit>();
  let scanned = 0;

  const walk = async (dir: string): Promise<void> => {
    if (scanned >= maxScan || best.size >= cappedLimit * 8) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (scanned >= maxScan || best.size >= cappedLimit * 8) return;
      if (SKIP_DIRS.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        if (!isTextFile(entry.name)) continue;
        scanned += 1;
        const rel = path.relative(checkout, abs).split(path.sep).join("/");
        const text = await readTextBounded(abs, maxBytes);
        if (text === null) continue;
        const lines = text.split("\n");
        let bestHit: CodeSearchHit | null = null;
        for (let i = 0; i < lines.length; i++) {
          const score = scoreMatch(rel, lines[i], terms);
          if (score <= 0) continue;
          const hit: CodeSearchHit = {
            path: rel,
            line: i + 1,
            snippet: lines[i].trim().slice(0, 320),
            score,
          };
          if (!bestHit || hit.score > bestHit.score) bestHit = hit;
        }
        if (bestHit) best.set(rel, bestHit);
      }
    }
  };

  if (s.isFile()) {
    // Single-file search.
    const rel = path.relative(checkout, root).split(path.sep).join("/");
    if (isTextFile(path.basename(root))) {
      const text = await readTextBounded(root, maxBytes);
      if (text) {
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const score = scoreMatch(rel, lines[i], terms);
          if (score > 0) {
            best.set(`${rel}:${i + 1}`, {
              path: rel,
              line: i + 1,
              snippet: lines[i].trim().slice(0, 320),
              score,
            });
          }
        }
      }
    }
  } else {
    await walk(root);
  }

  const hits = [...best.values()].sort(
    (a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line,
  );
  const maxScore = hits[0]?.score || 1;
  return hits.slice(0, cappedLimit).map((h) => ({ ...h, score: h.score / maxScore }));
}

// Convenience: resolve a repo's checkout, throwing a clear error if not cloned.
export async function requireCheckout(repo: Repository): Promise<string> {
  const target = repoCheckoutPath(repo);
  if (!(await isGitWorkTree(target))) {
    throw new WorkspaceError(
      `Code for ${repo.fullName} is not cloned yet. Clone it from the Code page (POST /api/devflow/repos/:id/workspace) first.`,
      409,
    );
  }
  return target;
}

export async function getRepoOrThrow(repoId: string): Promise<Repository> {
  const repo = await prisma.repository.findUnique({ where: { id: repoId } });
  if (!repo) throw new WorkspaceError("Repository not found", 404);
  return repo;
}
