import {
  feedbackTrace,
  FeedbackNotFoundError,
  toFeedbackView,
} from "@/lib/devflow/feedback";
import { errorMessage, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

interface RouteContext {
  params: Promise<{ messageId: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { messageId } = await context.params;
    const trace = await feedbackTrace(messageId);
    return ok({
      ...trace,
      feedback: trace.feedback ? toFeedbackView(trace.feedback) : null,
    });
  } catch (e) {
    if (e instanceof FeedbackNotFoundError) return failRaw(404, e.message);
    return failRaw(500, errorMessage(e));
  }
}
