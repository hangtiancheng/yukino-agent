// GET  /api/devflow/repos/:id/project-index — index state (+ staleness)
// POST /api/devflow/repos/:id/project-index — (re)build the project-doc index.
// Indexing clones/refreshes the checkout, discovers docs/manifests, and embeds
// them into Milvus. It can take a while, so it runs inline and returns counts.
import {
  getProjectIndexState,
  indexProject,
} from "@/lib/devflow/project-index";
import { getRepoOrThrow, WorkspaceError } from "@/lib/devflow/workspace";
import { errorMessage, fail, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const repo = await getRepoOrThrow(id);
    const state = await getProjectIndexState(repo);
    return ok({
      status: state.index?.status ?? "idle",
      fingerprint: state.index?.fingerprint ?? null,
      branch: state.index?.branch ?? null,
      commitSha: state.index?.commitSha ?? null,
      fileCount: state.index?.fileCount ?? 0,
      chunkCount: state.index?.chunkCount ?? 0,
      summary: state.index?.summary ?? null,
      errorMessage: state.index?.errorMessage ?? null,
      lastIndexedAt: state.index?.lastIndexedAt
        ? state.index.lastIndexedAt.toISOString()
        : null,
      stale: state.stale,
      checkoutCloned: state.checkoutCloned,
    });
  } catch (e) {
    if (e instanceof WorkspaceError) return fail(e.status, e.message);
    return fail(500, errorMessage(e));
  }
}

export async function POST(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const repo = await getRepoOrThrow(id);
    const result = await indexProject(repo);
    return ok(result);
  } catch (e) {
    if (e instanceof WorkspaceError) return fail(e.status, e.message);
    return fail(500, errorMessage(e));
  }
}
