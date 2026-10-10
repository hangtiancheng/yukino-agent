import { z } from "zod/v4";
import { prisma } from "@/lib/db";
import {
  countContentByType,
  indexRepositoryContent,
} from "@/lib/devflow/content-index";
import { errorMessage, fail, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

const PostSchema = z.object({ repoId: z.string().min(1) });

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const repoId = url.searchParams.get("repoId");
    if (!repoId) return fail(400, "repoIdQueryRequired");
    const repo = await prisma.repository.findUnique({ where: { id: repoId } });
    if (!repo) return fail(404, "repoNotFound");
    const started = Date.now();
    const chunksByType = await countContentByType(repoId);
    return ok({
      repoId,
      chunksByType,
      durationMs: Date.now() - started,
    });
  } catch {
    return fail(503, "vectorSearchUnavailable");
  }
}

export async function POST(request: Request) {
  try {
    const parsed = PostSchema.safeParse(await request.json());
    if (!parsed.success) {
      return fail(400, "invalidRequest", {
        detail: parsed.error.issues.map((i) => i.message).join(", "),
      });
    }
    const { repoId } = parsed.data;
    const repo = await prisma.repository.findUnique({ where: { id: repoId } });
    if (!repo) return fail(404, "repoNotFound");
    const result = await indexRepositoryContent(repoId);
    return ok(result);
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
