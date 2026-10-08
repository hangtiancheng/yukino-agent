// GET /api/devflow/repos/:id/memory — thread memory + per-conversation memory
// list for the repo memory panel (#25; legacy routes/knowledge.py
// /{repo_id}/memory/* surface, reduced to the models this stack persists).
import { prisma } from "@/lib/db";
import { getRepoMemoryOverview } from "@/lib/devflow/memory";
import { errorMessage, fail, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const repo = await prisma.repository.findUnique({ where: { id } });
    if (!repo) return fail(404, "repoNotFound");
    return ok(await getRepoMemoryOverview(id));
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
