// GET /api/devflow/repos/:id/code-graph/impact?files=a.ts,b.ts — one-hop
// change-impact report: symbols defined in the changed files plus the other
// files/symbols that depend on them (task spec endpoint).
// Legacy ports: pull_requests.py:269-308 _pr_code_graph_impact and
// ci.py:231-270 _ci_code_graph_impact — legacy returned changed-file
// symbols plus ALL surrounding relations; this endpoint narrows to
// dependents (computeImpact in lib/devflow/code-graph.ts documents the
// difference).
import { z } from "zod/v4";
import { impactForFiles } from "@/lib/devflow/code-graph";
import { errorMessage, fail, failRaw, ok } from "@/lib/devflow/http";
import { getRepoOrThrow, WorkspaceError } from "@/lib/devflow/workspace";

export { OPTIONS } from "@/lib/devflow/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const ImpactQuerySchema = z.object({
  files: z.string().trim().min(1).max(4000),
});

export async function GET(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const parsed = ImpactQuerySchema.safeParse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    if (!parsed.success) {
      return fail(400, "invalidQuery", {
        detail: "files must be a comma-separated list of repo-relative paths",
      });
    }
    const files = parsed.data.files
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    if (files.length === 0) {
      return fail(400, "invalidQuery", {
        detail: "files must contain at least one path",
      });
    }
    await getRepoOrThrow(id);
    return ok(await impactForFiles(id, files));
  } catch (e) {
    if (e instanceof WorkspaceError) return failRaw(e.status, e.message);
    return failRaw(500, errorMessage(e));
  }
}
