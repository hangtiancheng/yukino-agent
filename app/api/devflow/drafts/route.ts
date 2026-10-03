// GET  /api/devflow/drafts?repoId=&status= — list action drafts.
// POST /api/devflow/drafts — create a draft manually (agents create their own).
import { prisma } from "@/lib/db";
import { DraftCreateSchema } from "@/lib/devflow/schemas";
import { errorMessage, fail, ok } from "@/lib/devflow/http";

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
    return fail(500, errorMessage(e));
  }
}

export async function POST(request: Request) {
  try {
    const parsed = DraftCreateSchema.safeParse(await request.json());
    if (!parsed.success) {
      return fail(
        400,
        `Invalid request: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
      );
    }
    const input = parsed.data;
    const repo = await prisma.repository.findUnique({
      where: { id: input.repoId },
    });
    if (!repo) return fail(404, "Repository not found");

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
    return ok({ id: draft.id, status: draft.status }, 201);
  } catch (e) {
    return fail(500, errorMessage(e));
  }
}
