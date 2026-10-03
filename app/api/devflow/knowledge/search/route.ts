// POST /api/devflow/knowledge/search — retrieval test over a repo's KB.
import { KnowledgeSearchSchema } from "@/lib/devflow/schemas";
import { searchKnowledge } from "@/lib/devflow/rag";
import { errorMessage, fail, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

export async function POST(request: Request) {
  try {
    const parsed = KnowledgeSearchSchema.safeParse(await request.json());
    if (!parsed.success) {
      return fail(
        400,
        `Invalid request: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
      );
    }
    const { repoId, query, topK } = parsed.data;
    const started = Date.now();
    const hits = await searchKnowledge(repoId, query, topK);
    return ok({
      query,
      durationMs: Date.now() - started,
      hits: hits.map((hit) => ({
        docId: hit.docId,
        docName: hit.docName,
        chunkIndex: hit.chunkIndex,
        score: Number(hit.score.toFixed(4)),
        content: hit.content,
      })),
    });
  } catch (e) {
    return fail(500, errorMessage(e));
  }
}
