import { prisma } from "@/lib/db";
import { errorMessage, fail, failRaw, ok } from "@/lib/dev-flow/http";
import { getRepoMemoryOverview } from "@/lib/dev-flow/memory";

export { OPTIONS } from "@/lib/dev-flow/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const repo = await prisma.repository.findUnique({ where: { id } });
    if (!repo) {
      return await fail(404, "repoNotFound");
    }
    return ok(await getRepoMemoryOverview(id));
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
