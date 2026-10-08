// GET /api/devflow/knowledge/:docId/chunks — preview the exact chunks of one
// knowledge document as stored in Milvus (legacy routes/rag.py
// repositories/{repo_id}/documents/{document_id}/chunks).
import { prisma } from "@/lib/db";
import { listDocumentChunks } from "@/lib/devflow/rag";
import { errorMessage, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

interface RouteContext {
  params: Promise<{ docId: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { docId } = await context.params;
    const doc = await prisma.knowledgeDocument.findUnique({
      where: { id: docId },
      select: { id: true, repoId: true },
    });
    if (!doc) return failRaw(404, "Knowledge document not found");
    const chunks = await listDocumentChunks(doc.repoId, doc.id);
    return ok({ docId: doc.id, count: chunks.length, chunks });
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
