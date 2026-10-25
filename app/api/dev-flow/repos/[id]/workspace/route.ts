import { errorMessage, failRaw, ok } from "@/lib/dev-flow/http";
import {
  getRepoOrThrow,
  syncCheckout,
  workspaceStatus,
  WorkspaceError,
} from "@/lib/dev-flow/workspace";

export { OPTIONS } from "@/lib/dev-flow/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const repo = await getRepoOrThrow(id);
    return ok(await workspaceStatus(repo));
  } catch (e) {
    if (e instanceof WorkspaceError) {
      return failRaw(e.status, e.message);
    }
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
    if (e instanceof WorkspaceError) {
      return failRaw(e.status, e.message);
    }
    return failRaw(500, errorMessage(e));
  }
}
