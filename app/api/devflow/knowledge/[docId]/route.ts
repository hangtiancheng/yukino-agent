// GET    /api/devflow/knowledge/:docId — document metadata (identity + index
// status), the lookup companion for the search route's docId filter.
// DELETE /api/devflow/knowledge/:docId — remove a knowledge document and its
// Milvus vectors.
import { prisma } from "@/lib/db";
import { deleteKnowledgeDocument } from "@/lib/devflow/rag";
import { errorMessage, fail, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

interface RouteContext {
  params: Promise<{ docId: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { docId } = await context.params;
    const doc = await prisma.knowledgeDocument.findUnique({
      where: { id: docId },
    });
    if (!doc) return fail(404, "docNotFound");
    return ok({
      id: doc.id,
      repoId: doc.repoId,
      name: doc.name,
      sourceType: doc.sourceType,
      status: doc.status,
      charCount: doc.charCount,
      chunkCount: doc.chunkCount,
      errorMessage: doc.errorMessage,
      createdAt: doc.createdAt,
    });
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const { docId } = await context.params;
    await deleteKnowledgeDocument(docId);
    return ok({ deleted: docId });
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
