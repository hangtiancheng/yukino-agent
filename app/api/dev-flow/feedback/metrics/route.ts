import { feedbackMetrics } from "@/lib/dev-flow/feedback";
import { errorMessage, fail, failRaw, ok } from "@/lib/dev-flow/http";

export { OPTIONS } from "@/lib/dev-flow/http";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const repoId = url.searchParams.get("repoId");
    if (!repoId) {
      return await fail(400, "repoIdRequired");
    }
    return ok(await feedbackMetrics(repoId));
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
