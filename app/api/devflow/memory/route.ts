import { prisma } from "@/lib/db";
import {
  getRepoMemoryOverview,
  mergeThreadMemory,
  MemoryRepoQuerySchema,
} from "@/lib/devflow/memory";
import { errorMessage, fail, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

async function resolveRepoId(request: Request): Promise<string | null> {
  const url = new URL(request.url);
  const fromQuery = MemoryRepoQuerySchema.safeParse(
    Object.fromEntries(url.searchParams),
  );
  if (fromQuery.success) return fromQuery.data.repoId;
  const body = await request.json().catch(() => null);
  const fromBody = MemoryRepoQuerySchema.safeParse(body);
  return fromBody.success ? fromBody.data.repoId : null;
}

export async function GET(request: Request) {
  try {
    const repoId = await resolveRepoId(request);
    if (!repoId) return fail(400, "repoIdQueryRequired");
    const repo = await prisma.repository.findUnique({ where: { id: repoId } });
    if (!repo) return fail(404, "repoNotFound");
    return ok(await getRepoMemoryOverview(repoId));
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}

export async function PUT(request: Request) {
  try {
    const repoId = await resolveRepoId(request);
    if (!repoId) return fail(400, "repoIdQueryRequired");
    const repo = await prisma.repository.findUnique({ where: { id: repoId } });
    if (!repo) return fail(404, "repoNotFound");
    return ok(await mergeThreadMemory(repoId));
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
