import { z } from "zod/v4";
import { prisma } from "@/lib/db";
import { kbFilter, getKnowledgeConfig } from "@/lib/devflow/rag";
import { scopedRetrieve } from "@/lib/devflow/search";
import { errorMessage, fail, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

const PostSchema = z.object({
  repoId: z.string().min(1),
  query: z.string().min(1).max(2000),
  topK: z.number().int().min(1).max(20).optional(),
});

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const repoId = url.searchParams.get("repoId");
    if (!repoId) return fail(400, "repoIdQueryRequired");
    const limitParam = Number(url.searchParams.get("limit") ?? "20");
    const limit = Number.isFinite(limitParam)
      ? Math.min(Math.max(Math.trunc(limitParam), 1), 100)
      : 20;
    const runs = await prisma.retrievalTestRun.findMany({
      where: { repoId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return ok(
      runs.map((run) => ({
        id: run.id,
        query: run.query,
        resultCount: Array.isArray(run.results) ? run.results.length : 0,
        durationMs: run.durationMs,
        createdAt: run.createdAt,
      })),
    );
  } catch (e) {
    return failRaw(500, errorMessage(e));
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
    const { repoId, query, topK } = parsed.data;
    const repo = await prisma.repository.findUnique({ where: { id: repoId } });
    if (!repo) return fail(404, "repoNotFound");

    const config = await getKnowledgeConfig(repoId);
    const effectiveTopK = topK ?? config.topK;

    const started = Date.now();
    let docs;
    try {
      docs = await scopedRetrieve(query, effectiveTopK, kbFilter(repoId));
    } catch {
      return fail(503, "vectorSearchUnavailable");
    }
    const durationMs = Date.now() - started;

    const results = docs.map((doc) => ({
      docId: String(doc.metadata.doc_id ?? ""),
      docName: String(doc.metadata.doc_name ?? "unknown"),
      chunkIndex: Number(doc.metadata.chunk_index ?? 0),
      sourceType:
        typeof doc.metadata.source_type === "string"
          ? doc.metadata.source_type
          : undefined,
      sectionTitle:
        typeof doc.metadata.section_title === "string"
          ? doc.metadata.section_title
          : undefined,
      rankReason:
        typeof doc.metadata.rank_reason === "string"
          ? doc.metadata.rank_reason
          : undefined,
      score: Number(doc.score.toFixed(4)),
      excerpt: doc.content.slice(0, 500),
    }));

    const retrievalConfig = {
      scope: "knowledge_base",
      retrievalMethod: config.retrievalMethod,
      rerankEnabled: config.rerankEnabled,
      topK: effectiveTopK,
      chunkSize: config.chunkSize,
      chunkOverlap: config.chunkOverlap,
    };

    const run = await prisma.retrievalTestRun.create({
      data: { repoId, query, retrievalConfig, results, durationMs },
    });
    return ok({
      id: run.id,
      query: run.query,
      results,
      resultCount: results.length,
      durationMs: run.durationMs,
      retrievalConfig,
      createdAt: run.createdAt,
    });
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
