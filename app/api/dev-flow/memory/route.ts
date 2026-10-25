import { prisma } from "@/lib/db";
import { errorMessage, fail, failRaw, ok } from "@/lib/dev-flow/http";
import {
  getRepoMemoryOverview,
  mergeThreadMemory,
  MemoryRepoQuerySchema,
} from "@/lib/dev-flow/memory";

export { OPTIONS } from "@/lib/dev-flow/http";

async function resolveRepoId(request: Request): Promise<string | null> {
  const url = new URL(request.url);
  const fromQuery = MemoryRepoQuerySchema.safeParse(
    Object.fromEntries(url.searchParams),
  );
  if (fromQuery.success) {
    return fromQuery.data.repoId;
  }
  const body: unknown = await request.json().catch(() => null);
  const fromBody = MemoryRepoQuerySchema.safeParse(body);
  return fromBody.success ? fromBody.data.repoId : null;
}

export async function GET(request: Request) {
  try {
    const repoId = await resolveRepoId(request);
    if (!repoId) {
      return await fail(400, "repoIdQueryRequired");
    }
    const repo = await prisma.repository.findUnique({ where: { id: repoId } });
    if (!repo) {
      return await fail(404, "repoNotFound");
    }
    return ok(await getRepoMemoryOverview(repoId));
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}

export async function PUT(request: Request) {
  try {
    const repoId = await resolveRepoId(request);
    if (!repoId) {
      return await fail(400, "repoIdQueryRequired");
    }
    const repo = await prisma.repository.findUnique({ where: { id: repoId } });
    if (!repo) {
      return await fail(404, "repoNotFound");
    }
    return ok(await mergeThreadMemory(repoId));
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
