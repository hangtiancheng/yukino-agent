import { prisma } from "@/lib/db";
import { errorMessage, fail, failRaw, ok } from "@/lib/dev-flow/http";
import { ensureDemoUser, writeAuditLog } from "@/lib/dev-flow/permissions";
import { DraftCreateSchema } from "@/lib/dev-flow/schemas";

export { OPTIONS } from "@/lib/dev-flow/http";

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
      return await fail(400, "invalidRequest", {
        detail: parsed.error.issues.map((i) => i.message).join(", "),
      });
    }
    const input = parsed.data;
    const repo = await prisma.repository.findUnique({
      where: { id: input.repoId },
    });
    if (!repo) {
      return await fail(404, "repoNotFound");
    }

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
    }).catch((e: unknown) => {
      console.warn(
        "[dev_flow:audit] failed to record draft creation:",
        e instanceof Error ? e.message : String(e),
      );
    });
    return ok({ id: draft.id, status: draft.status }, 201);
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
