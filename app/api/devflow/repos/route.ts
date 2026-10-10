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

const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

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
    let note: string | null = null;
    let meta: {
      githubId: bigint | null;
      description: string | null;
      defaultBranch: string | null;
      cloneUrl: string | null;
    };

    if (rawLocalPath) {
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
      } catch {}
      const remoteInfo = remoteUrl ? parseGitRemoteUrl(remoteUrl) : null;
      if (remoteInfo) {
        owner = remoteInfo.owner;
        repo = remoteInfo.name;
      } else {
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
