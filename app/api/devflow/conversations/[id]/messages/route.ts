// GET /api/devflow/conversations/:id/messages — a conversation's transcript.
// ?limit= bounds the page; ?beforeMessageId= is the history cursor from
// legacy chat.py:140-158 / chat_memory.MessageStore.timeline — returns the
// page of messages strictly BEFORE the anchor, still ascending.
import { prisma } from "@/lib/db";
import { listMessages, toMessageView } from "@/lib/devflow/conversations";
import { ConversationMessagesQuerySchema } from "@/lib/devflow/schemas";
import { errorMessage, fail, failRaw, ok } from "@/lib/devflow/http";

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
      return fail(404, "conversationNotFound");
    }
    const url = new URL(request.url);
    const parsed = ConversationMessagesQuerySchema.safeParse(
      Object.fromEntries(url.searchParams),
    );
    if (!parsed.success) {
      return fail(400, "invalidRequest", {
        detail: parsed.error.issues.map((i) => i.message).join(", "),
      });
    }
    const messages = await listMessages(
      id,
      parsed.data.limit,
      parsed.data.beforeMessageId,
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
    const message = errorMessage(e);
    // Unknown / foreign cursor anchor is a client error, not a 500.
    if (message.includes("not found in conversation")) {
      return fail(400, "invalidRequest", { detail: message });
    }
    return failRaw(500, message);
  }
}
