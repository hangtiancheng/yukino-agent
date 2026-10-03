// GET  /api/devflow/repos/:id/conversations — list a repo's chat conversations
// POST /api/devflow/repos/:id/conversations — start a new conversation
import { z } from "zod/v4";
import { prisma } from "@/lib/db";
import {
  createConversation,
  listConversations,
  toConversationSummary,
} from "@/lib/devflow/conversations";
import { errorMessage, fail, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const ConversationCreateSchema = z.object({
  title: z.string().max(200).optional(),
});

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const repo = await prisma.repository.findUnique({ where: { id } });
    if (!repo) return fail(404, "Repository not found");
    const conversations = await listConversations(id);
    return ok(conversations.map(toConversationSummary));
  } catch (e) {
    return fail(500, errorMessage(e));
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const repo = await prisma.repository.findUnique({ where: { id } });
    if (!repo) return fail(404, "Repository not found");

    const parsed = ConversationCreateSchema.safeParse(
      await request.json().catch(() => ({})),
    );
    if (!parsed.success) {
      return fail(
        400,
        `Invalid request: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
      );
    }
    const conversation = await createConversation(id, parsed.data.title);
    return ok(toConversationSummary(conversation), 201);
  } catch (e) {
    return fail(500, errorMessage(e));
  }
}
