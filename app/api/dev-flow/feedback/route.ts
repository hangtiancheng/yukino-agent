import {
  createFeedback,
  FeedbackNotFoundError,
  listFeedback,
  toFeedbackView,
} from "@/lib/dev-flow/feedback";
import { errorMessage, fail, failRaw, ok } from "@/lib/dev-flow/http";
import { FeedbackCreateSchema } from "@/lib/dev-flow/schemas";

export { OPTIONS } from "@/lib/dev-flow/http";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const repoId = url.searchParams.get("repoId");
    if (!repoId) {
      return await fail(400, "repoIdRequired");
    }
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
    return failRaw(500, errorMessage(e));
  }
}

export async function POST(request: Request) {
  const parsed = FeedbackCreateSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return fail(400, "invalidRequest", {
      detail: parsed.error.issues.map((i) => i.message).join(", "),
    });
  }
  try {
    const feedback = await createFeedback(parsed.data);
    return ok(toFeedbackView(feedback), 201);
  } catch (e) {
    if (e instanceof FeedbackNotFoundError) {
      return failRaw(404, e.message);
    }
    return failRaw(500, errorMessage(e));
  }
}
