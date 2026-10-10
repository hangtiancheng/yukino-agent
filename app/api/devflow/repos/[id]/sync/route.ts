import { RepoSyncSchema } from "@/lib/devflow/schemas";
import { syncRepository } from "@/lib/devflow/sync";
import { errorMessage, fail, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = await request.json().catch(() => ({}));
    const parsed = RepoSyncSchema.safeParse(body);
    if (!parsed.success) {
      return fail(400, "invalidRequest", {
        detail: parsed.error.issues.map((i) => i.message).join(", "),
      });
    }
    const synced = await syncRepository(id, parsed.data);
    return ok({ repoId: id, status: "completed", synced });
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
