import { errorMessage, fail, failRaw, ok } from "@/lib/dev-flow/http";
import { RepoSyncSchema } from "@/lib/dev-flow/schemas";
import { syncRepository } from "@/lib/dev-flow/sync";

export { OPTIONS } from "@/lib/dev-flow/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body: unknown = await request.json().catch(() => ({}));
    const parsed = RepoSyncSchema.safeParse(body);
    if (!parsed.success) {
      return await fail(400, "invalidRequest", {
        detail: parsed.error.issues.map((i) => i.message).join(", "),
      });
    }
    const synced = await syncRepository(id, parsed.data);
    return ok({ repoId: id, status: "completed", synced });
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
