// GET /api/devflow/runs/:id/failed-jobs — the failed jobs (with their failed
// steps) of one workflow run (legacy routes/ci.py:511-525 get_failed_jobs).
import { prisma } from "@/lib/db";
import { errorMessage, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface JobShape {
  name?: string;
  conclusion?: string | null;
  steps?: Array<{ name?: string; conclusion?: string | null }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const run = await prisma.workflowRun.findUnique({ where: { id } });
    if (!run) return failRaw(404, "Workflow run not found");
    const jobs = Array.isArray(run.jobs)
      ? (run.jobs as unknown as JobShape[])
      : [];
    const failedJobs = jobs
      .filter((job) => job.conclusion === "failure")
      .map((job) => ({
        ...job,
        failed_steps: (job.steps ?? []).filter(
          (step) => step.conclusion === "failure",
        ),
      }));
    return ok({ runId: run.id, workflow: run.name, failed_jobs: failedJobs });
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
