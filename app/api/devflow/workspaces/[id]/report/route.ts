// POST /api/devflow/workspaces/:id/report — generate the cross-repository
// weekly report for one workspace. Port of legacy workspaces.py:81-162
// (multi_repo_report): agent:run permission, deterministic per-repo metrics +
// risk grading, optional LLM narrative, and the "workspace.multi_repo_report"
// audit action carrying the totals as result (workspaces.py:160). Returns the
// markdown plus repoReportsTriggered — the marker for the fire-and-forget
// per-repo weekly reports landing in each repository's KB.
import {
  PermissionError,
  requirePermission,
  writeAuditLog,
} from "@/lib/devflow/permissions";
import {
  MultiRepoReportSchema,
  WorkspaceError,
  generateMultiRepoReport,
} from "@/lib/devflow/workspaces";
import { errorMessage, fail, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const parsed = MultiRepoReportSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return fail(400, "invalidRequest", {
      detail: parsed.error.issues.map((i) => i.message).join(", "),
    });
  }

  let user;
  try {
    user = await requirePermission("agent:run");
  } catch (e) {
    if (e instanceof PermissionError) return failRaw(403, e.message);
    return failRaw(500, errorMessage(e));
  }

  try {
    const result = await generateMultiRepoReport({
      workspaceId: id,
      ...parsed.data,
    });
    await writeAuditLog({
      user,
      action: "workspace.multi_repo_report",
      targetType: "workspace",
      targetId: id,
      requestJson: parsed.data,
      resultJson: {
        metrics: result.metrics,
        generationMode: result.generationMode,
        repoReportsTriggered: result.repoReportsTriggered,
      },
    }).catch((err) =>
      console.warn(
        "[devflow:audit] failed to record workspace.multi_repo_report:",
        err instanceof Error ? err.message : String(err),
      ),
    );
    return ok(result);
  } catch (e) {
    if (e instanceof WorkspaceError) {
      if (e.code === "notFound") return fail(404, "workspaceNotFound");
      // legacy workspaces.py:88-89 — 400 when the repo set resolves empty.
      if (e.code === "noRepos") return fail(400, "workspaceNoRepos");
    }
    return failRaw(500, errorMessage(e));
  }
}
