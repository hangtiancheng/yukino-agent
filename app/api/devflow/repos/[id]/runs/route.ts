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
    const conclusion = url.searchParams.get("conclusion");

    const runs = await prisma.workflowRun.findMany({
      where: { repoId: id, ...(conclusion ? { conclusion } : {}) },
      orderBy: { githubCreatedAt: "desc" },
      take: 100,
    });

    const analyses = await prisma.analysisResult.findMany({
      where: {
        targetType: "workflow_run",
        targetId: { in: runs.map((r) => r.id) },
      },
      orderBy: { createdAt: "desc" },
      select: { targetId: true, id: true, createdAt: true },
    });
    const latestByRun = new Map<string, { id: string; createdAt: Date }>();
    for (const a of analyses) {
      if (!latestByRun.has(a.targetId)) {
        latestByRun.set(a.targetId, { id: a.id, createdAt: a.createdAt });
      }
    }

    return ok(
      runs.map((run) => ({
        id: run.id,
        githubRunId: run.githubRunId?.toString() ?? null,
        name: run.name,
        headBranch: run.headBranch,
        status: run.status,
        conclusion: run.conclusion,
        htmlUrl: run.htmlUrl,
        hasLogs: run.logsText !== null,
        jobs: run.jobs,
        githubCreatedAt: run.githubCreatedAt,
        latestAnalysis: latestByRun.get(run.id) ?? null,
      })),
    );
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
