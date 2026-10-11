import { prisma } from "@/lib/db";
import { errorMessage, fail, failRaw, ok } from "@/lib/devflow/http";
import {
  MemorySearchQuerySchema,
  searchRepoMemory,
} from "@/lib/devflow/memory";

export { OPTIONS } from "@/lib/devflow/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const repo = await prisma.repository.findUnique({ where: { id } });
    if (!repo) {
      return await fail(404, "repoNotFound");
    }
    const parsed = MemorySearchQuerySchema.safeParse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    if (!parsed.success) {
      return await fail(400, "invalidRequest", {
        detail: parsed.error.issues.map((i) => i.message).join(", "),
      });
    }
    const query = parsed.data.q.trim();
    const results =
      query === "" ? [] : await searchRepoMemory(id, query, parsed.data.limit);
    return ok({ query, results, resultCount: results.length });
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
