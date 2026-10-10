import { prisma } from "@/lib/db";
import {
  deleteConversation,
  listConversations,
  toConversationSummary,
} from "@/lib/devflow/conversations";
import { errorMessage, fail, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const target = await prisma.conversation.findUnique({ where: { id } });
    if (!target || target.status !== "active") {
      return fail(404, "conversationNotFound");
    }
    const replacement = await deleteConversation(target.repoId, id);
    const conversations = await listConversations(target.repoId);
    return ok({
      deleted: id,
      activeConversationId: replacement.id,
      conversations: conversations.map(toConversationSummary),
    });
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
