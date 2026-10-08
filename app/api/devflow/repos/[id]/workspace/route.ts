// GET  /api/devflow/repos/:id/workspace — clone status (cloned?, branch, commit)
// POST /api/devflow/repos/:id/workspace — clone or refresh the managed checkout
import {
  getRepoOrThrow,
  syncCheckout,
  workspaceStatus,
  WorkspaceError,
} from "@/lib/devflow/workspace";
import { errorMessage, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const repo = await getRepoOrThrow(id);
    return ok(await workspaceStatus(repo));
  } catch (e) {
    if (e instanceof WorkspaceError) return failRaw(e.status, e.message);
    return failRaw(500, errorMessage(e));
  }
}

export async function POST(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const repo = await getRepoOrThrow(id);
    const result = await syncCheckout(repo);
    return ok({
      path: result.path,
      branch: result.branch,
      commitSha: result.commitSha,
      cloned: result.cloned,
    });
  } catch (e) {
    if (e instanceof WorkspaceError) return failRaw(e.status, e.message);
    return failRaw(500, errorMessage(e));
  }
}
