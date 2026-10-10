import { prisma } from "@/lib/db";
import {
  KnowledgeConfigUpdateSchema,
  getKnowledgeConfig,
  upsertKnowledgeConfig,
} from "@/lib/devflow/rag";
import type { KnowledgeConfigValues } from "@/lib/devflow/rag";
import { errorMessage, fail, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const repoId = url.searchParams.get("repoId");
    if (!repoId) return fail(400, "repoIdQueryRequired");
    const repo = await prisma.repository.findUnique({ where: { id: repoId } });
    if (!repo) return fail(404, "repoNotFound");
    const config = await getKnowledgeConfig(repoId);
    return ok({ repoId, config, stored: await hasStoredConfig(repoId) });
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}

async function hasStoredConfig(repoId: string): Promise<boolean> {
  const row = await prisma.knowledgeBaseConfig.findUnique({
    where: { repoId },
  });
  return row !== null;
}

export async function PUT(request: Request) {
  try {
    const parsed = KnowledgeConfigUpdateSchema.safeParse(await request.json());
    if (!parsed.success) {
      return fail(400, "invalidRequest", {
        detail: parsed.error.issues.map((i) => i.message).join(", "),
      });
    }
    const { repoId, ...rest } = parsed.data;
    const repo = await prisma.repository.findUnique({ where: { id: repoId } });
    if (!repo) return fail(404, "repoNotFound");

    const patch: Partial<KnowledgeConfigValues> = {};
    if (rest.retrievalMethod !== undefined)
      patch.retrievalMethod = rest.retrievalMethod;
    if (rest.rerankEnabled !== undefined)
      patch.rerankEnabled = rest.rerankEnabled;
    if (rest.topK !== undefined) patch.topK = rest.topK;
    if (rest.scoreThresholdEnabled !== undefined)
      patch.scoreThresholdEnabled = rest.scoreThresholdEnabled;
    if (rest.scoreThreshold !== undefined)
      patch.scoreThreshold = rest.scoreThreshold;
    if (rest.chunkSize !== undefined) patch.chunkSize = rest.chunkSize;
    if (rest.chunkOverlap !== undefined) patch.chunkOverlap = rest.chunkOverlap;

    const config = await upsertKnowledgeConfig(repoId, patch);
    return ok({ repoId, config, stored: true });
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
