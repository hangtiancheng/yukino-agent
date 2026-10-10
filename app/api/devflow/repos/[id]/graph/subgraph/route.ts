import { prisma } from "@/lib/db";
import { errorMessage, fail, failRaw, ok } from "@/lib/devflow/http";
import {
  SubgraphQuerySchema,
  fetchSubgraph,
} from "@/lib/devflow/knowledge-graph";

export { OPTIONS } from "@/lib/devflow/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const repo = await prisma.repository.findUnique({ where: { id } });
    if (!repo) return fail(404, "repoNotFound");

    const query = Object.fromEntries(new URL(request.url).searchParams);
    const parsed = SubgraphQuerySchema.safeParse(query);
    if (!parsed.success) {
      return fail(400, "invalidQuery", {
        detail: parsed.error.issues.map((i) => i.message).join(", "),
      });
    }
    return ok(await fetchSubgraph(id, parsed.data));
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
