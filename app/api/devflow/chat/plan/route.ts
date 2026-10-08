// POST /api/devflow/chat/plan — phase 1 of the two-phase workflow protocol
// (legacy chat.py @router.post("/plan") → _conversation_plan): plan a bounded
// multi-agent workflow for {repoId, goal}, persist an AgentWorkflowRun
// (status "running") plus one pending AgentTaskRun per claim, and return the
// spec so the client can review the claims before executing.
import { prisma } from "@/lib/db";
import {
  WorkflowPlanRequestSchema,
  agentNameForTaskType,
  planWorkflow,
} from "@/lib/devflow/agents/workflow";
import { errorMessage, fail, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

export async function POST(request: Request) {
  try {
    const parsed = WorkflowPlanRequestSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      return fail(400, "invalidRequest", {
        detail: parsed.error.issues.map((i) => i.message).join(", "),
      });
    }
    const { repoId, goal } = parsed.data;
    const repo = await prisma.repository.findUnique({ where: { id: repoId } });
    if (!repo) return fail(404, "repoNotFound");

    const planned = await planWorkflow(repoId, goal);
    if (!planned) return fail(404, "repoNotFound");

    const run = await prisma.agentWorkflowRun.create({
      data: {
        repoId,
        goal,
        specJson: planned.spec as object,
        status: "running",
        tasks: {
          create: planned.spec.claims.map((claim) => ({
            taskId: claim.id,
            agentName: agentNameForTaskType(claim.task_type),
            taskType: claim.task_type,
            claimJson: claim as object,
            status: "pending",
          })),
        },
      },
      include: { tasks: { orderBy: { taskId: "asc" } } },
    });

    return ok(
      {
        runId: run.id,
        spec: planned.spec,
        generationMode: planned.generationMode,
        // Claim-boundary violations the planner dropped (kept for transparency;
        // legacy surfaced planner claim boundaries in agent_events).
        violations: planned.violations,
        tasks: run.tasks.map((task) => ({
          taskId: task.taskId,
          agentName: task.agentName,
          taskType: task.taskType,
          status: task.status,
        })),
      },
      201,
    );
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
