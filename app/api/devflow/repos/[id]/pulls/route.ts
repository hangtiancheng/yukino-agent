// GET /api/devflow/repos/:id/pulls — synced pull requests with file summaries.
import { prisma } from "@/lib/db";
import { errorMessage, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const url = new URL(request.url);
    const state = url.searchParams.get("state"); // open | closed | merged | null(all)
    const q = url.searchParams.get("q")?.toLowerCase() ?? "";

    const pulls = await prisma.pullRequest.findMany({
      where: {
        repoId: id,
        ...(state ? { state } : {}),
        ...(q ? { title: { contains: q, mode: "insensitive" } } : {}),
      },
      orderBy: { githubUpdatedAt: "desc" },
      take: 200,
      include: {
        files: {
          select: {
            filename: true,
            status: true,
            additions: true,
            deletions: true,
          },
        },
        _count: { select: { reviewComments: true } },
      },
    });

    const analyses = await prisma.analysisResult.findMany({
      where: {
        targetType: "pull_request",
        targetId: { in: pulls.map((p) => p.id) },
      },
      orderBy: { createdAt: "desc" },
      select: { targetId: true, id: true, createdAt: true },
    });
    const latestByPr = new Map<string, { id: string; createdAt: Date }>();
    for (const a of analyses) {
      if (!latestByPr.has(a.targetId)) {
        latestByPr.set(a.targetId, { id: a.id, createdAt: a.createdAt });
      }
    }

    return ok(
      pulls.map((pr) => ({
        id: pr.id,
        number: pr.number,
        title: pr.title,
        body: pr.body,
        state: pr.state,
        author: pr.author,
        baseBranch: pr.baseBranch,
        headBranch: pr.headBranch,
        additions: pr.additions,
        deletions: pr.deletions,
        changedFiles: pr.changedFiles,
        mergedAt: pr.mergedAt,
        githubCreatedAt: pr.githubCreatedAt,
        githubUpdatedAt: pr.githubUpdatedAt,
        files: pr.files,
        reviewCommentCount: pr._count.reviewComments,
        latestAnalysis: latestByPr.get(pr.id) ?? null,
      })),
    );
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
