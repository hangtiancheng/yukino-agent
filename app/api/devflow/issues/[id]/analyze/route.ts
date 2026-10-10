import { analyzeIssue } from "@/lib/devflow/agents/analysis";
import { errorMessage, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const record = await analyzeIssue(id);
    return ok(record);
  } catch (e) {
    const message = errorMessage(e);
    return failRaw(message.includes("not found") ? 404 : 500, message);
  }
}
