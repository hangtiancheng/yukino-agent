import { prisma } from "@/lib/db";
import { indexRepositoryContent } from "@/lib/devflow/content-index";
import { errorMessage, fail, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const repo = await prisma.repository.findUnique({ where: { id } });
    if (!repo) return fail(404, "repoNotFound");
    const result = await indexRepositoryContent(id);
    return ok(result);
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
