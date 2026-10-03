// Milvus vector retriever. Replaces lib/redis/retriever.ts.
// Default retrieval is dense + native BM25 hybrid search fused with RRF
// inside Milvus (an upgrade over the former Redis KNN-only search).
import { hybridSearch, search, type MilvusHit } from "./client";
import { embedText } from "@/lib/ai/embedder";

export interface RetrievedDoc {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  score: number;
}

function parseMetadata(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function toDocs(hits: MilvusHit[]): RetrievedDoc[] {
  return hits.map((hit) => ({
    id: hit.id,
    content: hit.content,
    metadata: parseMetadata(hit.metadata),
    // Higher is better: RRF fusion score for hybrid, COSINE similarity for
    // dense-only. Both are relative — use them for ordering, not as absolute
    // relevance probabilities.
    score: hit.score,
  }));
}

// Hybrid (dense + BM25, RRF-fused) retrieval over the whole collection.
export async function retrieve(
  query: string,
  topK = 1,
  filter?: string,
): Promise<RetrievedDoc[]> {
  const vector = await embedText(query);
  const hits = await hybridSearch(vector, query, topK, 50, filter);
  return toDocs(hits);
}

// Dense-only COSINE retrieval. Scores are cosine similarities in [0, 1] —
// use this when an absolute score threshold is needed (RRF fusion scores are
// rank-based and not comparable against a fixed threshold).
export async function retrieveDense(
  query: string,
  topK = 1,
  filter?: string,
): Promise<RetrievedDoc[]> {
  const vector = await embedText(query);
  const hits = await search(vector, topK, filter);
  return toDocs(hits);
}
