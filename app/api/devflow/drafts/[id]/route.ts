// PATCH  /api/devflow/drafts/:id — { action: "execute" | "reject" }.
// DELETE /api/devflow/drafts/:id — remove a draft.
import { prisma } from "@/lib/db";
import { DraftActionSchema } from "@/lib/devflow/schemas";
import { executeDraft, rejectDraft } from "@/lib/devflow/drafts";
import { errorMessage, fail, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const parsed = DraftActionSchema.safeParse(await request.json());
    if (!parsed.success) {
      return fail(
        400,
        `Invalid request: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
      );
    }
    const draft =
      parsed.data.action === "execute"
        ? await executeDraft(id)
        : await rejectDraft(id);
    return ok({
      id: draft.id,
      status: draft.status,
      executionResult: draft.executionResult,
      errorMessage: draft.errorMessage,
    });
  } catch (e) {
    const message = errorMessage(e);
    return fail(message.includes("not found") ? 404 : 400, message);
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    await prisma.actionDraft.delete({ where: { id } });
    return ok({ deleted: id });
  } catch (e) {
    return fail(500, errorMessage(e));
  }
}
