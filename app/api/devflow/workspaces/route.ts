// GET  /api/devflow/workspaces — list workspaces with per-repo counts.
// POST /api/devflow/workspaces — create a workspace (repo ids validated).
// Port of legacy workspaces.py:50-78 (create_workspace / list_workspaces),
// including the permission split: creation is settings:manage, listing is
// repo:read. Creation is audited as "workspace.create" (legacy action name).
import {
  PermissionError,
  requirePermission,
  writeAuditLog,
} from "@/lib/devflow/permissions";
import {
  WorkspaceCreateSchema,
  WorkspaceError,
  createWorkspace,
  listWorkspaces,
} from "@/lib/devflow/workspaces";
import { errorMessage, fail, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

export async function GET() {
  try {
    await requirePermission("repo:read");
    const items = await listWorkspaces();
    return ok(items);
  } catch (e) {
    if (e instanceof PermissionError) return failRaw(403, e.message);
    return failRaw(500, errorMessage(e));
  }
}

export async function POST(request: Request) {
  const parsed = WorkspaceCreateSchema.safeParse(
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
    const workspace = await createWorkspace(parsed.data);
    // legacy workspaces.py:67 — audit the create with the request payload.
    await writeAuditLog({
      user,
      action: "workspace.create",
      targetType: "workspace",
      targetId: workspace.id,
      requestJson: parsed.data,
    }).catch((err) =>
      console.warn(
        "[devflow:audit] failed to record workspace.create:",
        err instanceof Error ? err.message : String(err),
      ),
    );
    return ok(workspace, 201);
  } catch (e) {
    if (e instanceof WorkspaceError) {
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
