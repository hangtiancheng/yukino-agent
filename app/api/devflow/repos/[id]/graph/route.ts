// GET  /api/devflow/repos/:id/graph — whole-graph summary: node/edge counts,
//      relation distribution and the most recent edges (legacy GET
//      /{repo_id}/knowledge/graph stats slice, routes/knowledge.py:344-355).
// POST /api/devflow/repos/:id/graph {action:"rebuild"} — full rebuild
//      (legacy POST /{repo_id}/knowledge/graph/rebuild,
//      routes/knowledge.py:358-362).
import { prisma } from "@/lib/db";
import { errorMessage, fail, failRaw, ok } from "@/lib/devflow/http";
import {
  GraphActionSchema,
  graphSummary,
  rebuildGraph,
} from "@/lib/devflow/knowledge-graph";

export { OPTIONS } from "@/lib/devflow/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const repo = await prisma.repository.findUnique({ where: { id } });
    if (!repo) return fail(404, "repoNotFound");
    return ok(await graphSummary(id));
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const repo = await prisma.repository.findUnique({ where: { id } });
    if (!repo) return fail(404, "repoNotFound");

    const parsed = GraphActionSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      return fail(400, "invalidRequest", {
        detail: parsed.error.issues.map((i) => i.message).join(", "),
      });
    }
    const result = await rebuildGraph(id);
    return ok({ repoId: id, ...result });
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
