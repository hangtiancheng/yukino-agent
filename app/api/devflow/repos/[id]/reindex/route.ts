// POST /api/devflow/repos/:id/reindex — rebuild the repository's GitHub
// content vectors (legacy POST /rag/{repo_id}/reindex → qa.py:216
// reindex_documents → index_repository_documents): the ITEM indexing stage
// (issues / PRs / failed CI logs). Uploaded KB documents are re-indexed
// individually via POST /api/devflow/knowledge/:docId/retry (their text is
// stored in KnowledgeDocumentBody), not by this repo-wide content rebuild.
import { prisma } from "@/lib/db";
import { indexRepositoryContent } from "@/lib/devflow/content-index";
import { errorMessage, fail, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const repo = await prisma.repository.findUnique({ where: { id } });
    if (!repo) return fail(404, "repoNotFound");
    const result = await indexRepositoryContent(id);
    return ok(result);
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
