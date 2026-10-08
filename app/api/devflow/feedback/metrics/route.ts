// GET /api/devflow/feedback/metrics?repoId= — aggregate feedback metrics.
import { feedbackMetrics } from "@/lib/devflow/feedback";
import { errorMessage, fail, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const repoId = url.searchParams.get("repoId");
    if (!repoId) return fail(400, "repoIdRequired");
    return ok(await feedbackMetrics(repoId));
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
