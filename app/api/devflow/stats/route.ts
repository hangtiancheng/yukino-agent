// GET /api/devflow/stats?repoId= — dashboard aggregates for one repository
// (or all repositories when repoId is omitted).
import { prisma } from "@/lib/db";
import { errorMessage, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const repoId = url.searchParams.get("repoId");
    const where = repoId ? { repoId } : {};

    const [
      repoCount,
      openIssues,
      closedIssues,
      openPrs,
      mergedPrs,
      failedRuns,
      totalRuns,
      docCount,
      pendingDrafts,
      recentAnalyses,
    ] = await Promise.all([
      prisma.repository.count(),
      prisma.issue.count({ where: { ...where, state: "open" } }),
      prisma.issue.count({ where: { ...where, state: "closed" } }),
      prisma.pullRequest.count({ where: { ...where, state: "open" } }),
      prisma.pullRequest.count({
        where: { ...where, mergedAt: { not: null } },
      }),
      prisma.workflowRun.count({ where: { ...where, conclusion: "failure" } }),
      prisma.workflowRun.count({ where }),
      prisma.knowledgeDocument.count({ where: repoId ? { repoId } : {} }),
      prisma.actionDraft.count({
        where: { ...where, status: "pending_confirmation" },
      }),
      prisma.analysisResult.count(),
    ]);

    const recentIssues = await prisma.issue.findMany({
      where,
      orderBy: { githubUpdatedAt: "desc" },
      take: 5,
      select: {
        id: true,
        number: true,
        title: true,
        state: true,
        repoId: true,
      },
    });
    const recentPrs = await prisma.pullRequest.findMany({
      where,
      orderBy: { githubUpdatedAt: "desc" },
      take: 5,
      select: {
        id: true,
        number: true,
        title: true,
        state: true,
        repoId: true,
      },
    });
    const recentFailedRuns = await prisma.workflowRun.findMany({
      where: { ...where, conclusion: "failure" },
      orderBy: { githubCreatedAt: "desc" },
      take: 5,
      select: {
        id: true,
        name: true,
        headBranch: true,
        repoId: true,
        githubCreatedAt: true,
      },
    });

    return ok({
      repos: repoCount,
      openIssues,
      closedIssues,
      openPrs,
      mergedPrs,
      failedRuns,
      totalRuns,
      knowledgeDocs: docCount,
      pendingDrafts,
      analyses: recentAnalyses,
      recentIssues,
      recentPrs,
      recentFailedRuns,
    });
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
