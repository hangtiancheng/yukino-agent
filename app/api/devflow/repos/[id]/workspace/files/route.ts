// GET /api/devflow/repos/:id/workspace/files?path=&limit= — bounded file listing
import {
  getRepoOrThrow,
  listFiles,
  requireCheckout,
  WorkspaceError,
} from "@/lib/devflow/workspace";
import { errorMessage, fail, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const repo = await getRepoOrThrow(id);
    const url = new URL(request.url);
    const relPath = url.searchParams.get("path") ?? ".";
    const limitRaw = Number.parseInt(
      url.searchParams.get("limit") ?? "200",
      10,
    );
    const checkout = await requireCheckout(repo);
    const entries = await listFiles(
      checkout,
      relPath,
      Number.isFinite(limitRaw) ? limitRaw : 200,
    );
    return ok({ path: relPath, count: entries.length, entries });
  } catch (e) {
    if (e instanceof WorkspaceError) return fail(e.status, e.message);
    return fail(500, errorMessage(e));
  }
}
