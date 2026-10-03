// POST /api/devflow/repos/:id/workspace/search — lexical code search over the
// managed checkout. Body: { query, path?, limit? }.
import { z } from "zod/v4";
import {
  getRepoOrThrow,
  requireCheckout,
  searchCode,
  WorkspaceError,
} from "@/lib/devflow/workspace";
import { errorMessage, fail, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const CodeSearchSchema = z.object({
  query: z.string().min(1).max(500),
  path: z.string().max(500).optional(),
  limit: z.number().int().min(1).max(50).default(12),
});

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const parsed = CodeSearchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return fail(
      400,
      `Invalid request: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
    );
  }
  try {
    const repo = await getRepoOrThrow(id);
    const checkout = await requireCheckout(repo);
    const hits = await searchCode(
      checkout,
      parsed.data.query,
      parsed.data.path,
      parsed.data.limit,
    );
    return ok({ query: parsed.data.query, count: hits.length, hits });
  } catch (e) {
    if (e instanceof WorkspaceError) return fail(e.status, e.message);
    return fail(500, errorMessage(e));
  }
}
