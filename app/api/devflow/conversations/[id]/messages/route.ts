// GET /api/devflow/conversations/:id/messages — a conversation's transcript.
import { prisma } from "@/lib/db";
import { listMessages, toMessageView } from "@/lib/devflow/conversations";
import { errorMessage, fail, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const conversation = await prisma.conversation.findUnique({
      where: { id },
    });
    if (!conversation || conversation.status !== "active") {
      return fail(404, "Conversation not found");
    }
    const url = new URL(request.url);
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "200", 10);
    const messages = await listMessages(
      id,
      Number.isFinite(limit) ? limit : 200,
    );
    return ok(
      messages.map((m) => ({
        ...toMessageView(m),
        // Surface the existing rating (if any) so the client renders it.
        feedback: m.feedback
          ? { rating: m.feedback.rating, reviewStatus: m.feedback.reviewStatus }
          : null,
      })),
    );
  } catch (e) {
    return fail(500, errorMessage(e));
  }
}
