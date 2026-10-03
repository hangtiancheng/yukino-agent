// PATCH /api/devflow/feedback/:id — human review of a feedback record.
import {
  FeedbackNotFoundError,
  reviewFeedback,
  toFeedbackView,
} from "@/lib/devflow/feedback";
import { FeedbackReviewSchema } from "@/lib/devflow/schemas";
import { errorMessage, fail, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const parsed = FeedbackReviewSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return fail(
      400,
      `Invalid request: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
    );
  }
  try {
    const feedback = await reviewFeedback(id, parsed.data);
    return ok(toFeedbackView(feedback));
  } catch (e) {
    if (e instanceof FeedbackNotFoundError) return fail(404, e.message);
    return fail(500, errorMessage(e));
  }
}
