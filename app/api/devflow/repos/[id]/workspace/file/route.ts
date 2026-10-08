// GET /api/devflow/repos/:id/workspace/file?path=&startLine=&lineCount= — read a
// text file (or a line range) from the managed checkout.
import {
  getRepoOrThrow,
  readCodeFile,
  requireCheckout,
  WorkspaceError,
} from "@/lib/devflow/workspace";
import { errorMessage, fail, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

function intParam(value: string | null): number | undefined {
  if (value === null) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const repo = await getRepoOrThrow(id);
    const url = new URL(request.url);
    const relPath = url.searchParams.get("path");
    if (!relPath) return fail(400, "pathRequired");
    const checkout = await requireCheckout(repo);
    const file = await readCodeFile(checkout, relPath, {
      startLine: intParam(url.searchParams.get("startLine")),
      lineCount: intParam(url.searchParams.get("lineCount")),
    });
    return ok(file);
  } catch (e) {
    if (e instanceof WorkspaceError) return failRaw(e.status, e.message);
    return failRaw(500, errorMessage(e));
  }
}
