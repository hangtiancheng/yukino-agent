import { prisma } from "@/lib/db";
import { errorMessage, fail, failRaw, ok } from "@/lib/dev-flow/http";
import { ragStatus } from "@/lib/dev-flow/rag";

export { OPTIONS } from "@/lib/dev-flow/http";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const repoId = url.searchParams.get("repoId");
    if (!repoId) {
      return await fail(400, "repoIdQueryRequired");
    }
    const repo = await prisma.repository.findUnique({ where: { id: repoId } });
    if (!repo) {
      return await fail(404, "repoNotFound");
    }
    return ok(await ragStatus(repoId));
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
