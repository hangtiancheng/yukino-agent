// GET  /api/devflow/repos/:id/project-index — index state (+ staleness, snooze)
// POST /api/devflow/repos/:id/project-index — (re)build the project-doc index,
//      or {action:"snooze", days?} to silence the stale/missing reminder for
//      N days (legacy project_index.py:49-57 snooze endpoint).
// Indexing clones/refreshes the checkout, discovers docs/manifests, and embeds
// them into Milvus. It can take a while, so it runs inline and returns counts.
import { prisma } from "@/lib/db";
import {
  getProjectIndexState,
  indexProject,
} from "@/lib/devflow/project-index";
import { ProjectIndexSnoozeSchema } from "@/lib/devflow/schemas";
import { getRepoOrThrow, WorkspaceError } from "@/lib/devflow/workspace";
import { errorMessage, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const repo = await getRepoOrThrow(id);
    const state = await getProjectIndexState(repo);
    // legacy project_indexing.py:342/577-578: state carries snoozed_until and
    // is_snoozed(); a snoozed index must not surface as a reminder, so the
    // stale flag is gated on the snooze window here at the display boundary.
    const snoozedUntil = state.index?.snoozedUntil ?? null;
    const snoozed =
      snoozedUntil !== null && snoozedUntil.getTime() > Date.now();
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
      stale: state.stale && !snoozed,
      snoozed,
      snoozedUntil: snoozedUntil ? snoozedUntil.toISOString() : null,
      checkoutCloned: state.checkoutCloned,
    });
  } catch (e) {
    if (e instanceof WorkspaceError) return failRaw(e.status, e.message);
    return failRaw(500, errorMessage(e));
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const repo = await getRepoOrThrow(id);
    const body = await request.json().catch(() => null);
    const snooze = ProjectIndexSnoozeSchema.safeParse(body);
    if (snooze.success) {
      // legacy project_indexing.snooze_project_index:362-370 — write
      // snoozed_until = now + days on the (created if absent) state row.
      // The legacy status downgrade to "missing" for never-indexed repos is
      // not ported: this stack's "idle" default already reads as not-indexed.
      const snoozedUntil = new Date(Date.now() + snooze.data.days * 86_400_000);
      await prisma.projectIndex.upsert({
        where: { repoId: repo.id },
        create: { repoId: repo.id, snoozedUntil },
        update: { snoozedUntil },
      });
      return ok({
        repoId: repo.id,
        snoozedUntil: snoozedUntil.toISOString(),
        days: snooze.data.days,
      });
    }
    const result = await indexProject(repo);
    return ok(result);
  } catch (e) {
    if (e instanceof WorkspaceError) return failRaw(e.status, e.message);
    return failRaw(500, errorMessage(e));
  }
}
