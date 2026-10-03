// GET    /api/devflow/repos/:id — repository detail with synced counts.
// DELETE /api/devflow/repos/:id — remove the repo, its synced data (cascade)
//          and its knowledge-base vectors.
import { prisma } from "@/lib/db";
import { deleteBySourcePrefix } from "@/lib/milvus/indexer";
import { kbSource } from "@/lib/devflow/rag";
import { errorMessage, fail, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const repo = await prisma.repository.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            issues: true,
            pullRequests: true,
            workflowRuns: true,
            knowledgeDocuments: true,
            actionDrafts: true,
          },
        },
      },
    });
    if (!repo) return fail(404, "Repository not found");
    return ok({
      id: repo.id,
      owner: repo.owner,
      name: repo.name,
      fullName: repo.fullName,
      provider: repo.provider,
      apiBaseUrl: repo.apiBaseUrl,
      description: repo.description,
      defaultBranch: repo.defaultBranch,
      lastSyncAt: repo.lastSyncAt,
      lastSyncError: repo.lastSyncError,
      hasToken: repo.tokenEncrypted !== null,
      createdAt: repo.createdAt,
      counts: {
        issues: repo._count.issues,
        pullRequests: repo._count.pullRequests,
        workflowRuns: repo._count.workflowRuns,
        knowledgeDocuments: repo._count.knowledgeDocuments,
        actionDrafts: repo._count.actionDrafts,
      },
    });
  } catch (e) {
    return fail(500, errorMessage(e));
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const repo = await prisma.repository.findUnique({
      where: { id },
      include: { knowledgeDocuments: { select: { id: true } } },
    });
    if (!repo) return fail(404, "Repository not found");

    // Relational rows cascade; Milvus vectors must be removed per document.
    for (const doc of repo.knowledgeDocuments) {
      await deleteBySourcePrefix(kbSource(id, doc.id)).catch(() => undefined);
    }
    await prisma.repository.delete({ where: { id } });
    return ok({ deleted: id });
  } catch (e) {
    return fail(500, errorMessage(e));
  }
}
