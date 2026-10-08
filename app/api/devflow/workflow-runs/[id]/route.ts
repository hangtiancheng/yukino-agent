// GET /api/devflow/workflow-runs/:id — workflow run detail: the (possibly
// replanned) spec, the observation, the synthesized decision memo, metrics
// and every AgentTaskRun row.
import { prisma } from "@/lib/db";
import { errorMessage, fail, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const run = await prisma.agentWorkflowRun.findUnique({
      where: { id },
      include: {
        tasks: { orderBy: { startedAt: "asc" } },
        repo: { select: { fullName: true } },
      },
    });
    if (!run) return fail(404, "workflowRunNotFound");
    return ok({
      id: run.id,
      repoId: run.repoId,
      repoFullName: run.repo?.fullName ?? null,
      goal: run.goal,
      status: run.status,
      spec: run.specJson,
      observation: run.observationJson,
      finalAnswer: run.finalAnswer,
      metrics: run.metrics,
      createdAt: run.createdAt,
      completedAt: run.completedAt,
      tasks: run.tasks.map((task) => ({
        id: task.id,
        taskId: task.taskId,
        agentName: task.agentName,
        taskType: task.taskType,
        claim: task.claimJson,
        result: task.resultJson,
        status: task.status,
        error: task.error,
        startedAt: task.startedAt,
        completedAt: task.completedAt,
      })),
    });
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
