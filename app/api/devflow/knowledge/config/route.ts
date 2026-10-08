// GET /api/devflow/knowledge/config?repoId= — effective per-repo KB config
// (stored row merged over the code defaults).
// PUT /api/devflow/knowledge/config — upsert KnowledgeBaseConfig
// (retrievalMethod/rerankEnabled/topK/chunkSize/chunkOverlap). Port of the
// legacy routes/rag.py knowledge_base_config slice (§5 minimal face).
//
// What is ACTUALLY applied: topK (search/ask/retrieval-test defaults) and
// chunkSize/chunkOverlap (upload chunking). retrievalMethod/rerankEnabled are
// persisted + echoed, but the live pipeline always runs Milvus hybrid fusion
// and gates rerank on the global RERANK_API_KEY (lib/devflow/search.ts) —
// applying them per repo would require a search.ts change.
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

    // Only carry explicitly provided fields (undefined must not overwrite).
    const patch: Partial<KnowledgeConfigValues> = {};
    if (rest.retrievalMethod !== undefined)
      patch.retrievalMethod = rest.retrievalMethod;
    if (rest.rerankEnabled !== undefined)
      patch.rerankEnabled = rest.rerankEnabled;
    if (rest.topK !== undefined) patch.topK = rest.topK;
    if (rest.chunkSize !== undefined) patch.chunkSize = rest.chunkSize;
    if (rest.chunkOverlap !== undefined) patch.chunkOverlap = rest.chunkOverlap;

    const config = await upsertKnowledgeConfig(repoId, patch);
    return ok({ repoId, config, stored: true });
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
