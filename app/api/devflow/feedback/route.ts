// GET  /api/devflow/feedback?repoId=&conversationId=&limit= — list feedback
// POST /api/devflow/feedback — rate an assistant answer (helpful/unhelpful)
import {
  createFeedback,
  FeedbackNotFoundError,
  listFeedback,
  toFeedbackView,
} from "@/lib/devflow/feedback";
import { FeedbackCreateSchema } from "@/lib/devflow/schemas";
import { errorMessage, fail, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const repoId = url.searchParams.get("repoId");
    if (!repoId) return fail(400, "repoId is required");
    const conversationId = url.searchParams.get("conversationId");
    const limitRaw = Number.parseInt(
      url.searchParams.get("limit") ?? "200",
      10,
    );
    const rows = await listFeedback(
      repoId,
      conversationId,
      Number.isFinite(limitRaw) ? limitRaw : 200,
    );
    return ok(rows.map(toFeedbackView));
  } catch (e) {
    return fail(500, errorMessage(e));
  }
}

export async function POST(request: Request) {
  const parsed = FeedbackCreateSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return fail(
      400,
      `Invalid request: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
    );
  }
  try {
    const feedback = await createFeedback(parsed.data);
    return ok(toFeedbackView(feedback), 201);
  } catch (e) {
    if (e instanceof FeedbackNotFoundError) return fail(404, e.message);
    return fail(500, errorMessage(e));
  }
}
