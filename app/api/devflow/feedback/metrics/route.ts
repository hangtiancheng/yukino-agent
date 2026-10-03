// GET /api/devflow/feedback/metrics?repoId= — aggregate feedback metrics.
import { feedbackMetrics } from "@/lib/devflow/feedback";
import { errorMessage, fail, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const repoId = url.searchParams.get("repoId");
    if (!repoId) return fail(400, "repoId is required");
    return ok(await feedbackMetrics(repoId));
  } catch (e) {
    return fail(500, errorMessage(e));
  }
}
