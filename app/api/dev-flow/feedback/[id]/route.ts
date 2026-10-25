import {
  FeedbackNotFoundError,
  reviewFeedback,
  toFeedbackView,
} from "@/lib/dev-flow/feedback";
import { errorMessage, fail, failRaw, ok } from "@/lib/dev-flow/http";
import { FeedbackReviewSchema } from "@/lib/dev-flow/schemas";

export { OPTIONS } from "@/lib/dev-flow/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const parsed = FeedbackReviewSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return fail(400, "invalidRequest", {
      detail: parsed.error.issues.map((i) => i.message).join(", "),
    });
  }
  try {
    const feedback = await reviewFeedback(id, parsed.data);
    return ok(toFeedbackView(feedback));
  } catch (e) {
    if (e instanceof FeedbackNotFoundError) {
      return failRaw(404, e.message);
    }
    return failRaw(500, errorMessage(e));
  }
}
