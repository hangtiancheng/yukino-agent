import { prisma } from "@/lib/db";
import {
  listRecallEvents,
  RecallEventListQuerySchema,
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
    const parsed = RecallEventListQuerySchema.safeParse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    if (!parsed.success) {
      return fail(400, "invalidRequest", {
        detail: parsed.error.issues.map((i) => i.message).join(", "),
      });
    }
    return ok(
      await listRecallEvents(id, {
        ...(parsed.data.conversationId
          ? { conversationId: parsed.data.conversationId }
          : {}),
        limit: parsed.data.limit,
      }),
    );
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
