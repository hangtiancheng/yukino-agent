import { prisma } from "@/lib/db";
import { errorMessage, fail, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const repoId = url.searchParams.get("repoId");
    if (!repoId) return fail(400, "repoIdQueryRequired");
    const runs = await prisma.agentWorkflowRun.findMany({
      where: { repoId },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { tasks: { select: { status: true } } },
    });
    return ok(
      runs.map((run) => ({
        id: run.id,
        goal: run.goal,
        status: run.status,
        createdAt: run.createdAt,
        completedAt: run.completedAt,
        taskCount: run.tasks.length,
        successCount: run.tasks.filter((t) => t.status === "success").length,
        failedCount: run.tasks.filter((t) => t.status === "failed").length,
        skippedCount: run.tasks.filter((t) => t.status === "skipped").length,
      })),
    );
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
