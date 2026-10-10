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

    for (const doc of repo.knowledgeDocuments) {
      await deleteBySourcePrefix(kbSource(id, doc.id)).catch(() => undefined);
    }
    const milvusErrors: string[] = [];
    for (const prefix of repoMilvusCleanupPrefixes(id)) {
      try {
        await deleteBySourcePrefix(prefix);
      } catch (e) {
        milvusErrors.push(`${prefix}: ${errorMessage(e)}`);
      }
    }
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
