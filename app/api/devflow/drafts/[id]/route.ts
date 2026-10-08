// PATCH  /api/devflow/drafts/:id — { action: "execute" | "reject" }.
// DELETE /api/devflow/drafts/:id — remove a draft.
// Approving/rejecting a draft is the human gate before a real GitHub write, so
// it requires the draft:approve permission and is recorded in the audit log.
import { prisma } from "@/lib/db";
import { DraftActionSchema } from "@/lib/devflow/schemas";
import { executeDraft, rejectDraft } from "@/lib/devflow/drafts";
import {
  PermissionError,
  requirePermission,
  writeAuditLog,
} from "@/lib/devflow/permissions";
import { errorMessage, fail, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const parsed = DraftActionSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return fail(400, "invalidRequest", {
      detail: parsed.error.issues.map((i) => i.message).join(", "),
    });
  }
  const action = parsed.data.action;

  let user;
  try {
    user = await requirePermission("draft:approve");
  } catch (e) {
    if (e instanceof PermissionError) {
      await writeAuditLog({
        action: `draft:${action}`,
        targetType: "action_draft",
        targetId: id,
        status: "denied",
      }).catch(() => {});
      return failRaw(403, e.message);
    }
    return failRaw(500, errorMessage(e));
  }

  try {
    const draft =
      action === "execute" ? await executeDraft(id) : await rejectDraft(id);
    await writeAuditLog({
      user,
      repoId: draft.repoId,
      action: `draft:${action}`,
      targetType: draft.targetType ?? "action_draft",
      targetId: draft.id,
      status: draft.status === "failed" ? "failed" : "success",
      resultJson: {
        status: draft.status,
        executionResult: draft.executionResult ?? null,
        errorMessage: draft.errorMessage ?? null,
      },
    }).catch((e) =>
      console.warn(
        "[devflow:audit] failed to record draft action:",
        e instanceof Error ? e.message : String(e),
      ),
    );
    return ok({
      id: draft.id,
      status: draft.status,
      executionResult: draft.executionResult,
      errorMessage: draft.errorMessage,
    });
  } catch (e) {
    const message = errorMessage(e);
    return failRaw(message.includes("not found") ? 404 : 400, message);
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    await prisma.actionDraft.delete({ where: { id } });
    return ok({ deleted: id });
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
