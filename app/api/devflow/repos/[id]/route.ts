// GET    /api/devflow/repos/:id — repository detail with synced counts.
// DELETE /api/devflow/repos/:id — remove the repo, its synced data (cascade),
//          all of its Milvus vectors (every indexer prefix) and its managed
//          checkout. Port of the legacy repos.py:301-448 delete_repo, whose
//          delete_milvus_documents(repo_id=...) swept the repo's vectors in
//          one shot and whose cleanup summary is mirrored below.
import { prisma } from "@/lib/db";
import { deleteBySourcePrefix } from "@/lib/milvus/indexer";
import { kbSource } from "@/lib/devflow/rag";
import { repoMilvusCleanupPrefixes } from "@/lib/devflow/sync";
import { removeRepoCheckout } from "@/lib/devflow/workspace";
import { errorMessage, fail, failRaw, ok } from "@/lib/devflow/http";

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
    if (!repo) return fail(404, "repoNotFound");
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
      checkoutMode: repo.checkoutMode,
      localPath: repo.localPath,
      cloneParentDir: repo.cloneParentDir,
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
    return failRaw(500, errorMessage(e));
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const repo = await prisma.repository.findUnique({
      where: { id },
      include: { knowledgeDocuments: { select: { id: true } } },
    });
    if (!repo) return fail(404, "repoNotFound");

    // Relational rows cascade; Milvus vectors must be removed explicitly.
    // Per-document KB sources first (kept from the previous port), then a
    // prefix sweep across every DevFlow indexer (kb / project / item) so
    // orphaned vectors from already-deleted rows are caught too — legacy
    // delete_milvus_documents(repo_id=...) removed them all by repo id.
    for (const doc of repo.knowledgeDocuments) {
      await deleteBySourcePrefix(kbSource(id, doc.id)).catch(() => undefined);
    }
    const milvusErrors: string[] = [];
    for (const prefix of repoMilvusCleanupPrefixes(id)) {
      try {
        await deleteBySourcePrefix(prefix);
      } catch (e) {
        // Milvus being down must not block the relational delete; surface
        // the leak in the response instead of swallowing it silently
        // (legacy strict=False + file_errors mirrors this honesty).
        milvusErrors.push(`${prefix}: ${errorMessage(e)}`);
      }
    }
    // Managed clone only; local-mode user working trees are never deleted
    // (legacy semantics: the directory belongs to the user).
    const workspaceRemoved: string[] = await removeRepoCheckout(repo).catch(
      () => [],
    );
    await prisma.repository.delete({ where: { id } });
    return ok({
      deleted: id,
      cleanup: { workspaceRemoved, milvusErrors },
    });
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
