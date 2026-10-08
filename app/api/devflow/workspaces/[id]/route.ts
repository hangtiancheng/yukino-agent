// GET    /api/devflow/workspaces/:id — workspace detail + aggregated stats.
// PATCH  /api/devflow/workspaces/:id — rename / re-describe / re-pick repos.
// DELETE /api/devflow/workspaces/:id — remove the grouping (repos untouched).
// GET mirrors legacy workspaces.py:73-78 listing semantics for one row; PATCH
// and DELETE are the round-2 CRUD additions (legacy had neither). Mutations
// keep the legacy settings:manage gate and audit naming (workspace.update /
// workspace.delete, modeled on legacy workspace.create).
import { prisma } from "@/lib/db";
import {
  PermissionError,
  requirePermission,
  writeAuditLog,
} from "@/lib/devflow/permissions";
import {
  WorkspaceUpdateSchema,
  WorkspaceError,
  aggregateWorkspaceStats,
  deleteWorkspace,
  toWorkspaceView,
  updateWorkspace,
} from "@/lib/devflow/workspaces";
import { errorMessage, fail, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    await requirePermission("repo:read");
    const { id } = await context.params;
    const workspace = await prisma.workspace.findUnique({ where: { id } });
    if (!workspace) return fail(404, "workspaceNotFound");
    const stats = await aggregateWorkspaceStats(id);
    return ok({ workspace: toWorkspaceView(workspace), stats });
  } catch (e) {
    if (e instanceof PermissionError) return failRaw(403, e.message);
    return failRaw(500, errorMessage(e));
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const parsed = WorkspaceUpdateSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return fail(400, "invalidRequest", {
      detail: parsed.error.issues.map((i) => i.message).join(", "),
    });
  }

  let user;
  try {
    user = await requirePermission("settings:manage");
  } catch (e) {
    if (e instanceof PermissionError) return failRaw(403, e.message);
    return failRaw(500, errorMessage(e));
  }

  try {
    const workspace = await updateWorkspace(id, parsed.data);
    await writeAuditLog({
      user,
      action: "workspace.update",
      targetType: "workspace",
      targetId: workspace.id,
      requestJson: parsed.data,
    }).catch((err) =>
      console.warn(
        "[devflow:audit] failed to record workspace.update:",
        err instanceof Error ? err.message : String(err),
      ),
    );
    return ok(workspace);
  } catch (e) {
    if (e instanceof WorkspaceError) {
      if (e.code === "notFound") return fail(404, "workspaceNotFound");
      if (e.code === "nameTaken") return fail(409, "workspaceNameTaken");
      if (e.code === "reposMissing") {
        return fail(404, "workspaceReposMissing", {
          repos: e.missingRepoIds.join(", "),
        });
      }
    }
    return failRaw(500, errorMessage(e));
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const { id } = await context.params;

  let user;
  try {
    user = await requirePermission("settings:manage");
  } catch (e) {
    if (e instanceof PermissionError) return failRaw(403, e.message);
    return failRaw(500, errorMessage(e));
  }

  try {
    const workspace = await deleteWorkspace(id);
    await writeAuditLog({
      user,
      action: "workspace.delete",
      targetType: "workspace",
      targetId: id,
      requestJson: { name: workspace.name, repoIds: workspace.repoIds },
    }).catch((err) =>
      console.warn(
        "[devflow:audit] failed to record workspace.delete:",
        err instanceof Error ? err.message : String(err),
      ),
    );
    return ok({ deleted: id });
  } catch (e) {
    if (e instanceof WorkspaceError && e.code === "notFound") {
      return fail(404, "workspaceNotFound");
    }
    return failRaw(500, errorMessage(e));
  }
}
