import { prisma } from "@/lib/db";
import {
  listMemoryCandidates,
  proposeMemoryCandidate,
  MemoryCandidateCreateSchema,
  MemoryCandidateListQuerySchema,
} from "@/lib/devflow/memory";
import { errorMessage, fail, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const repo = await prisma.repository.findUnique({ where: { id } });
    if (!repo) return fail(404, "repoNotFound");
    const url = new URL(request.url);
    const parsed = MemoryCandidateListQuerySchema.safeParse(
      Object.fromEntries(url.searchParams),
    );
    if (!parsed.success) {
      return fail(400, "invalidRequest", {
        detail: parsed.error.issues.map((i) => i.message).join(", "),
      });
    }
    return ok(
      await listMemoryCandidates(id, {
        status: parsed.data.status,
        limit: parsed.data.limit,
      }),
    );
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const repo = await prisma.repository.findUnique({ where: { id } });
    if (!repo) return fail(404, "repoNotFound");
    const parsed = MemoryCandidateCreateSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      return fail(400, "invalidRequest", {
        detail: parsed.error.issues.map((i) => i.message).join(", "),
      });
    }
    const { kind, title, content, conversationId } = parsed.data;
    if (conversationId) {
      const conversation = await prisma.conversation.findFirst({
        where: { id: conversationId, repoId: id },
      });
      if (!conversation) return fail(404, "conversationNotFound");
    }
    const result = await proposeMemoryCandidate({
      repoId: id,
      conversationId,
      kind,
      title,
      content,
      origin: "chat_agent",
    });
    return ok(result, result.deduped ? 200 : 201);
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
