// GET  /api/devflow/repos — list connected repositories with synced counts.
// POST /api/devflow/repos — connect a repository: either a GitHub one
//       (validated via the GitHub API, optional token encrypted) or a
//       local-path mode user-owned git working tree (legacy repos.py:157-263
//       _inspect_local_repository). Managed connects may pin a
//       cloneParentDir for where their checkout lives.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db";
import { encryptToken } from "@/lib/devflow/crypto";
import { fetchRepoMeta, syncRepository } from "@/lib/devflow/sync";
import { RepoConnectSchema } from "@/lib/devflow/schemas";
import { parseGitRemoteUrl } from "@/lib/devflow/workspace";
import { errorMessage, fail, failRaw, ok } from "@/lib/devflow/http";
import { GitHubApiError } from "@/lib/devflow/github";

export { OPTIONS } from "@/lib/devflow/http";

const execFileAsync = promisify(execFile);

// legacy repos.py:27 GITHUB_HOSTS.
const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

// legacy repos.py:57-73 _git_output — execFile argv array (no shell), fail
// with the git diagnostic instead of raising through a shell.
async function gitTextAt(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: 30_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout.trim();
  } catch (e) {
    const msg = errorMessage(e);
    if (msg.includes("ENOENT")) {
      throw new Error("git executable not found; cannot inspect a local repo");
    }
    throw new Error(`Failed to inspect local repository: ${msg}`);
  }
}

// legacy repos.py:46-54 _resolve_user_path — trim/quote strip, `~` home
// expansion, resolve against cwd when relative. ($VAR expansion is not
// ported; browser-submitted paths never need it.)
function resolveUserPath(raw: string): string {
  const cleaned = raw.trim().replace(/^['"]|['"]$/g, "");
  if (!cleaned) throw new Error("Path cannot be empty");
  if (cleaned === "~") return homedir();
  const expanded = cleaned.startsWith("~/")
    ? path.join(homedir(), cleaned.slice(2))
    : cleaned;
  return path.resolve(expanded);
}

export async function GET() {
  try {
    const repos = await prisma.repository.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        _count: {
          select: {
            issues: true,
            pullRequests: true,
            workflowRuns: true,
            knowledgeDocuments: true,
          },
        },
      },
    });
    return ok(
      repos.map((repo) => ({
        id: repo.id,
        owner: repo.owner,
        name: repo.name,
        fullName: repo.fullName,
        provider: repo.provider,
        apiBaseUrl: repo.apiBaseUrl,
        description: repo.description,
        defaultBranch: repo.defaultBranch,
        lastSyncAt: repo.lastSyncAt,
        lastSyncError: repo.lastSyncError,
        hasToken: repo.tokenEncrypted !== null,
        checkoutMode: repo.checkoutMode,
        localPath: repo.localPath,
        cloneParentDir: repo.cloneParentDir,
        createdAt: repo.createdAt,
        counts: {
          issues: repo._count.issues,
          pullRequests: repo._count.pullRequests,
          workflowRuns: repo._count.workflowRuns,
          knowledgeDocuments: repo._count.knowledgeDocuments,
        },
      })),
    );
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}

export async function POST(request: Request) {
  try {
    const parsed = RepoConnectSchema.safeParse(await request.json());
    if (!parsed.success) {
      return fail(400, "invalidRequest", {
        detail: parsed.error.issues.map((i) => i.message).join(", "),
      });
    }
    const {
      owner: rawOwner,
      repo: rawRepo,
      provider: requestedProvider,
      apiBaseUrl: rawApiBaseUrl,
      token,
      localPath: rawLocalPath,
      cloneParentDir: rawCloneParentDir,
    } = parsed.data;

    let owner = rawOwner ?? "";
    let repo = rawRepo ?? "";
    let provider = requestedProvider;
    let apiBaseUrl = rawApiBaseUrl ?? null;
    let checkoutMode: "managed" | "local" = "managed";
    let localPath: string | null = null;
    let cloneParentDir: string | null = null;
    // Non-null when GitHub API metadata could not be verified and the row was
    // filled from the local git inspection instead (legacy repos.py:204-207
    // fallback message; the demo-mode branch of that fallback is not
    // migrated, so we record the degraded provenance in the response).
    let note: string | null = null;
    let meta: {
      githubId: bigint | null;
      description: string | null;
      defaultBranch: string | null;
      cloneUrl: string | null;
    };

    if (rawLocalPath) {
      // legacy repos.py:101-120 _inspect_local_repository: verify it is a git
      // work tree, take the toplevel as the identity, derive owner/name from
      // `origin` (directory-name fallback when there is no parseable remote),
      // then infer the provider from the remote host (repos.py:123-138).
      let abs: string;
      try {
        abs = resolveUserPath(rawLocalPath);
      } catch (e) {
        return failRaw(400, errorMessage(e));
      }
      const s = await stat(abs).catch(() => null);
      if (!s || !s.isDirectory()) {
        return failRaw(
          400,
          `Local repository path does not exist or is not a directory: ${abs}`,
        );
      }
      let inside: string;
      try {
        inside = await gitTextAt(["rev-parse", "--is-inside-work-tree"], abs);
      } catch (e) {
        return failRaw(400, errorMessage(e));
      }
      if (inside.toLowerCase() !== "true") {
        return failRaw(
          400,
          `Local path is not inside a git repository: ${abs}`,
        );
      }
      let toplevel: string;
      try {
        toplevel = await gitTextAt(["rev-parse", "--show-toplevel"], abs);
      } catch (e) {
        return failRaw(400, errorMessage(e));
      }
      localPath = await realpath(toplevel).catch(() => path.resolve(toplevel));
      checkoutMode = "local";
      let remoteUrl = "";
      try {
        remoteUrl = await gitTextAt(["remote", "get-url", "origin"], localPath);
      } catch {
        // No origin remote (fresh local repo): keep the directory name below.
      }
      const remoteInfo = remoteUrl ? parseGitRemoteUrl(remoteUrl) : null;
      if (remoteInfo) {
        owner = remoteInfo.owner;
        repo = remoteInfo.name;
      } else {
        // Directory-name fallback (see the header note); `local` mirrors the
        // legacy test seed owner="local" for non-GitHub working trees.
        owner = "local";
        repo = path.basename(localPath);
      }
      const host = remoteInfo?.host ?? null;
      if (host && !GITHUB_HOSTS.has(host)) provider = "github_compatible";
      if (provider === "github_compatible") {
        apiBaseUrl = apiBaseUrl ?? (host ? `https://${host}/api/v3` : null);
      } else {
        apiBaseUrl = null;
      }
      let currentBranch: string | null = null;
      try {
        currentBranch =
          (await gitTextAt(["branch", "--show-current"], localPath)) || null;
      } catch {
        currentBranch = null;
      }
      // legacy repos.py:197-207 still verifies against the API; on failure
      // (self-hosted without REST, offline, private without token) a
      // local-mode connect stays useful with git-derived metadata.
      try {
        meta = await fetchRepoMeta(owner, repo, {
          token: token ?? null,
          baseUrl: provider === "github_compatible" ? apiBaseUrl : null,
        });
        if (!meta.defaultBranch) meta.defaultBranch = currentBranch;
      } catch {
        meta = {
          githubId: null,
          description: null,
          defaultBranch: currentBranch || "main",
          cloneUrl: remoteUrl || null,
        };
        note = `GitHub verification failed for ${owner}/${repo}; connected as a local working tree (metadata from git).`;
      }
    } else {
      const ctx = {
        token: token ?? null,
        baseUrl:
          provider === "github_compatible" ? (rawApiBaseUrl ?? null) : null,
      };
      try {
        meta = await fetchRepoMeta(owner, repo, ctx);
      } catch (e) {
        if (e instanceof GitHubApiError) {
          return e.status === 404
            ? fail(404, "repoNotFoundOnGithub", { repo: `${owner}/${repo}` })
            : fail(400, "githubConnectionFailed", { error: e.message });
        }
        throw e;
      }
      apiBaseUrl =
        provider === "github_compatible" ? (rawApiBaseUrl ?? null) : null;
      if (rawCloneParentDir) {
        // legacy repos.py:141-154 _clone_target_from_parent: the parent must
        // be a directory when it exists; missing parents are created on the
        // first managed clone (workspace.syncCheckout mkdir -p).
        const absParent = resolveUserPath(rawCloneParentDir);
        const ps = await stat(absParent).catch(() => null);
        if (ps && !ps.isDirectory()) {
          return failRaw(
            400,
            `Download parent path is not a directory: ${absParent}`,
          );
        }
        cloneParentDir = absParent;
      }
    }

    const fullName = `${owner}/${repo}`;
    const existing = await prisma.repository.findUnique({
      where: { fullName },
    });
    const data = {
      owner,
      name: repo,
      fullName,
      provider,
      apiBaseUrl,
      description: meta.description,
      defaultBranch: meta.defaultBranch,
      githubId: meta.githubId,
      checkoutMode,
      localPath,
      cloneParentDir,
      ...(token ? { tokenEncrypted: encryptToken(token) } : {}),
    };
    const saved = existing
      ? await prisma.repository.update({ where: { id: existing.id }, data })
      : await prisma.repository.create({ data });

    // Initial best-effort sync so the workspace has data right away; failures
    // are recorded on the repo row instead of failing the connect call.
    // Local-mode repos still sync GitHub data via the REST API (assignment
    // rule: only the checkout is local).
    let syncError: string | null = null;
    try {
      await syncRepository(saved.id, { limit: 30 });
    } catch (e) {
      syncError = errorMessage(e);
    }

    return ok(
      {
        repoId: saved.id,
        fullName,
        checkoutMode,
        localPath,
        cloneParentDir,
        note,
        syncError,
      },
      201,
    );
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
