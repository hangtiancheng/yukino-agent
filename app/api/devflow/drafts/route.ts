// GET  /api/devflow/drafts?repoId=&status= — list action drafts.
// POST /api/devflow/drafts — create a draft manually (agents create their own).
// legacy action_drafts.py:66-97 also records an audit row on manual creation.
import { prisma } from "@/lib/db";
import { DraftCreateSchema } from "@/lib/devflow/schemas";
import { ensureDemoUser, writeAuditLog } from "@/lib/devflow/permissions";
import { errorMessage, fail, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const repoId = url.searchParams.get("repoId");
    const status = url.searchParams.get("status");
    const drafts = await prisma.actionDraft.findMany({
      where: {
        ...(repoId ? { repoId } : {}),
        ...(status ? { status } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { repo: { select: { fullName: true } } },
    });
    return ok(
      drafts.map((draft) => ({
        id: draft.id,
        repoId: draft.repoId,
        repoFullName: draft.repo.fullName,
        draftType: draft.draftType,
        targetType: draft.targetType,
        targetNumber: draft.targetNumber,
        title: draft.title,
        content: draft.content,
        labels: draft.labels,
        riskLevel: draft.riskLevel,
        status: draft.status,
        executionResult: draft.executionResult,
        errorMessage: draft.errorMessage,
        createdAt: draft.createdAt,
        updatedAt: draft.updatedAt,
      })),
    );
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}

export async function POST(request: Request) {
  try {
    const parsed = DraftCreateSchema.safeParse(await request.json());
    if (!parsed.success) {
      return fail(400, "invalidRequest", {
        detail: parsed.error.issues.map((i) => i.message).join(", "),
      });
    }
    const input = parsed.data;
    const repo = await prisma.repository.findUnique({
      where: { id: input.repoId },
    });
    if (!repo) return fail(404, "repoNotFound");

    const draft = await prisma.actionDraft.create({
      data: {
        repoId: input.repoId,
        draftType: input.draftType,
        targetType: input.targetType ?? null,
        targetNumber: input.targetNumber ?? null,
        title: input.title,
        content: input.content,
        labels: input.labels,
        riskLevel: input.riskLevel,
      },
    });
    // legacy action_drafts.py:86-94 (action_draft.create + request_json).
    // Named `draft:create` to match this port's draft:<action> convention
    // (see drafts/[id]); auditing must not break the create itself.
    const user = await ensureDemoUser().catch(() => null);
    await writeAuditLog({
      user,
      repoId: input.repoId,
      action: "draft:create",
      targetType: input.targetType ?? "action_draft",
      targetId: draft.id,
      requestJson: {
        draftType: input.draftType,
        targetNumber: input.targetNumber ?? null,
        title: input.title,
        riskLevel: input.riskLevel,
      },
    }).catch((e) =>
      console.warn(
        "[devflow:audit] failed to record draft creation:",
        e instanceof Error ? e.message : String(e),
      ),
    );
    return ok({ id: draft.id, status: draft.status }, 201);
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
