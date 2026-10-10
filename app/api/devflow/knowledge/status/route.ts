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
