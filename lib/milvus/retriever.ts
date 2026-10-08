// Milvus vector retriever. Replaces lib/redis/retriever.ts.
// Default retrieval is dense + native BM25 hybrid search fused with RRF
// inside Milvus (an upgrade over the former Redis KNN-only search), with an
// optional rerank stage (RERANK_* env) on top of the fused candidates — the
// port of the Python retrieval pipeline's qwen3-vl-rerank pass.
import { hybridSearch, search, bm25Search, type MilvusHit } from "./client";
import { embedText } from "@/lib/ai/embedder";
import { rerankEnabled, tryRerank } from "@/lib/ai/rerank";

export interface RetrievedDoc {
  id: string;
  content: string;
  // Scalar source tag (chunk metadata._source, e.g. a doc filename for OnCall
  // or "devflow:kb:<repoId>:<docId>" for DevFlow KB chunks).
  source: string;
  metadata: Record<string, unknown>;
  score: number;
}

// Legacy agent_py retrieval constants (retrieval/tool.py): default/max topK 5,
// rerank candidate pool 20.
const DEFAULT_TOP_K = 5;
const RERANK_CANDIDATE_LIMIT = 20;
const MAX_CANDIDATE_LIMIT = 50;

// DevFlow writes into the shared collection under "devflow:*" sources. OnCall
// retrieval (the unfiltered path) must not surface those chunks, so they are
// excluded after fusion. Done in-process rather than via a negated Milvus LIKE
// expression to stay independent of filter-expression syntax support.
const DEVFLOW_SOURCE_PREFIX = "devflow:";

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
    source: hit.source,
    metadata: parseMetadata(hit.metadata),
    // Higher is better: RRF fusion score for hybrid, COSINE similarity for
    // dense-only, rerank relevance in [0, 1] when the rerank stage ran.
    // All are relative — use them for ordering, not as absolute relevance
    // probabilities.
    score: hit.score,
  }));
}

// Hybrid (dense + BM25, RRF-fused) retrieval.
//
// Pipeline: fuse in Milvus (over-fetching candidates when a post-fusion stage
// needs them) → drop DevFlow sources for unfiltered (OnCall) queries → rerank
// via the configured rerank endpoint when enabled → cut to topK.
//
// `filter` scopes retrieval to a slice of the shared collection (DevFlow KB /
// project index); when omitted, the OnCall ops-knowledge-base view applies and
// DevFlow chunks are excluded.
export async function retrieve(
  query: string,
  topK = DEFAULT_TOP_K,
  filter?: string,
): Promise<RetrievedDoc[]> {
  const vector = await embedText(query);
  const excludeDevflow = filter === undefined;
  const rerank = rerankEnabled();
  const candidateLimit =
    excludeDevflow || rerank
      ? Math.min(
          Math.max(topK * 4, RERANK_CANDIDATE_LIMIT),
          MAX_CANDIDATE_LIMIT,
        )
      : topK;
  const hits = await hybridSearch(vector, query, candidateLimit, 50, filter);
  let docs = toDocs(hits);
  if (excludeDevflow) {
    docs = docs.filter((d) => !d.source.startsWith(DEVFLOW_SOURCE_PREFIX));
  }
  if (rerank && docs.length > 1) {
    const ranked = await tryRerank(
      query,
      docs.map((d) => d.content),
      Math.min(topK, docs.length),
    );
    if (ranked) {
      return ranked.map((r) => ({ ...docs[r.index], score: r.score }));
    }
  }
  return docs.slice(0, topK);
}

// Raw hybrid candidates with no rerank/cut — the scoped DevFlow pipeline
// (lib/devflow/search.ts) runs its own dedup → rerank → expansion stages
// over these, mirroring the Python pipeline order. `method` selects the
// recall legs (legacy retrieval_method: hybrid | dense | bm25).
export type RetrievalMethod = "hybrid" | "dense" | "bm25";

export async function retrieveRaw(
  query: string,
  limit: number,
  filter?: string,
  method: RetrievalMethod = "hybrid",
): Promise<RetrievedDoc[]> {
  if (method === "bm25") {
    return toDocs(await bm25Search(query, limit, filter));
  }
  const vector = await embedText(query);
  if (method === "dense") {
    return toDocs(await search(vector, limit, filter));
  }
  const hits = await hybridSearch(
    vector,
    query,
    limit,
    Math.max(50, limit),
    filter,
  );
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
