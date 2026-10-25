import { errorMessage, failRaw, ok } from "@/lib/dev-flow/http";
import { retryDocument } from "@/lib/dev-flow/rag";

export { OPTIONS } from "@/lib/dev-flow/http";

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
