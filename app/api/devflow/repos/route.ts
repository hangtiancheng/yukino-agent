// GET  /api/devflow/repos — list connected repositories with synced counts.
// POST /api/devflow/repos — connect a GitHub repository (validates via the
//       GitHub API, encrypts the optional token, kicks off an initial sync).
import { prisma } from "@/lib/db";
import { encryptToken } from "@/lib/devflow/crypto";
import { fetchRepoMeta, syncRepository } from "@/lib/devflow/sync";
import { RepoConnectSchema } from "@/lib/devflow/schemas";
import { errorMessage, fail, ok } from "@/lib/devflow/http";
import { GitHubApiError } from "@/lib/devflow/github";

export { OPTIONS } from "@/lib/devflow/http";

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
    return fail(500, errorMessage(e));
  }
}

export async function POST(request: Request) {
  try {
    const parsed = RepoConnectSchema.safeParse(await request.json());
    if (!parsed.success) {
      return fail(
        400,
        `Invalid request: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
      );
    }
    const { owner, repo, provider, apiBaseUrl, token } = parsed.data;

    const ctx = {
      token: token ?? null,
      baseUrl: provider === "github_compatible" ? apiBaseUrl : null,
    };
    let meta;
    try {
      meta = await fetchRepoMeta(owner, repo, ctx);
    } catch (e) {
      if (e instanceof GitHubApiError) {
        return fail(
          e.status === 404 ? 404 : 400,
          e.status === 404
            ? `Repository ${owner}/${repo} not found (or the token cannot see it).`
            : `GitHub connection failed: ${e.message}`,
        );
      }
      throw e;
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
      apiBaseUrl:
        provider === "github_compatible" ? (apiBaseUrl ?? null) : null,
      description: meta.description,
      defaultBranch: meta.defaultBranch,
      githubId: meta.githubId,
      ...(token ? { tokenEncrypted: encryptToken(token) } : {}),
    };
    const saved = existing
      ? await prisma.repository.update({ where: { id: existing.id }, data })
      : await prisma.repository.create({ data });

    // Initial best-effort sync so the workspace has data right away; failures
    // are recorded on the repo row instead of failing the connect call.
    let syncError: string | null = null;
    try {
      await syncRepository(saved.id, { limit: 30 });
    } catch (e) {
      syncError = errorMessage(e);
    }

    return ok({ repoId: saved.id, fullName, syncError }, 201);
  } catch (e) {
    return fail(500, errorMessage(e));
  }
}
