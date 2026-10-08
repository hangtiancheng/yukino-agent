// GET /api/devflow/knowledge/status?repoId= — RAG studio status for one repo
// (legacy routes/rag.py:353-357 get_rag_status → qa.py rag_status): document
// counts by source type, the live indexed chunk count, the embedding model and
// the generation mode.
import { prisma } from "@/lib/db";
import { ragStatus } from "@/lib/devflow/rag";
import { errorMessage, fail, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const repoId = url.searchParams.get("repoId");
    if (!repoId) return fail(400, "repoIdQueryRequired");
    const repo = await prisma.repository.findUnique({ where: { id: repoId } });
    if (!repo) return fail(404, "repoNotFound");
    return ok(await ragStatus(repoId));
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
