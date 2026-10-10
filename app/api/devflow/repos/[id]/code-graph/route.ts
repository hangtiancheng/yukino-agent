import { z } from "zod/v4";
import { rebuildCodeGraph, searchSymbols } from "@/lib/devflow/code-graph";
import { errorMessage, fail, failRaw, ok } from "@/lib/devflow/http";
import { getRepoOrThrow, WorkspaceError } from "@/lib/devflow/workspace";

export { OPTIONS } from "@/lib/devflow/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const SearchQuerySchema = z.object({
  query: z.string().trim().max(200).optional(),
  kind: z.string().trim().max(40).optional(),
  language: z.string().trim().max(40).optional(),
  path: z.string().trim().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const RebuildBodySchema = z.object({ action: z.literal("rebuild") });

export async function GET(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const parsed = SearchQuerySchema.safeParse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    if (!parsed.success) {
      return fail(400, "invalidQuery", {
        detail: parsed.error.issues[0]?.message ?? "invalid parameters",
      });
    }
    await getRepoOrThrow(id);
    const symbols = await searchSymbols(id, parsed.data);
    return ok({
      query: parsed.data.query ?? "",
      count: symbols.length,
      symbols,
    });
  } catch (e) {
    if (e instanceof WorkspaceError) return failRaw(e.status, e.message);
    return failRaw(500, errorMessage(e));
  }
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const parsed = RebuildBodySchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return fail(400, "invalidRequest", {
      detail: 'body must be {"action":"rebuild"}',
    });
  }
  try {
    return ok(await rebuildCodeGraph(id));
  } catch (e) {
    if (e instanceof WorkspaceError) return failRaw(e.status, e.message);
    return failRaw(500, errorMessage(e));
  }
}
