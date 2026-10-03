// DELETE /api/devflow/knowledge/:docId — remove a knowledge document and its
// Milvus vectors.
import { deleteKnowledgeDocument } from "@/lib/devflow/rag";
import { errorMessage, fail, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

interface RouteContext {
  params: Promise<{ docId: string }>;
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const { docId } = await context.params;
    await deleteKnowledgeDocument(docId);
    return ok({ deleted: docId });
  } catch (e) {
    return fail(500, errorMessage(e));
  }
}
