// POST /api/devflow/knowledge/:docId/retry — re-chunk + re-embed a FAILED
// knowledge document from its stored content (legacy routes/rag.py
// repositories/{repo_id}/documents/{document_id}/retry).
import { retryDocument } from "@/lib/devflow/rag";
import { errorMessage, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

interface RouteContext {
  params: Promise<{ docId: string }>;
}

export async function POST(_request: Request, context: RouteContext) {
  try {
    const { docId } = await context.params;
    const result = await retryDocument(docId);
    return ok(result);
  } catch (e) {
    const message = errorMessage(e);
    return failRaw(message.includes("not found") ? 404 : 400, message);
  }
}
