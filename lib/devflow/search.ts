// DevFlow scoped retrieval pipeline. Mirrors the Python
// knowledge_base.search_documents stage order over the shared Milvus
// collection:
//
//   over-fetch → near-duplicate removal → per-parent cap →
//   rerank (qwen API when configured, heuristic fallback on failure —
//   heuristic only when no API is configured) → topK cut → sibling expansion.
//
// The recall legs (hybrid/dense/bm25) and the rerank gate are per-repo
// overridable via KnowledgeBaseConfig (legacy retrieval_method/rerank_enabled).
// OnCall keeps its own lighter path in lib/milvus/retriever.ts (retrieve()).
import {
  retrieveRaw,
  type RetrievedDoc,
  type RetrievalMethod,
} from "@/lib/milvus/retriever";
import { rerankEnabled, tryRerank } from "@/lib/ai/rerank";
import {
  dedupeNearDuplicates,
  limitPerParent,
  heuristicRerank,
  expandSiblings,
} from "./retrieval-post";

export interface ScopedRetrieveOptions {
  // Recall legs (legacy retrieval_method); default hybrid.
  method?: RetrievalMethod;
  // Per-repo rerank toggle (legacy rerank_enabled). The global RERANK_API_KEY
  // gate still applies: without a key the heuristic reranker runs instead.
  rerank?: boolean;
}

export async function scopedRetrieve(
  query: string,
  topK: number,
  filter: string,
  opts: ScopedRetrieveOptions = {},
): Promise<RetrievedDoc[]> {
  const useApiRerank = (opts.rerank ?? true) && rerankEnabled();
  // Legacy candidate_limit: min(max(top_k * 8 when rerank else *2, 20), 100).
  const candidateLimit = Math.min(
    Math.max(topK * (useApiRerank ? 8 : 2), 20),
    100,
  );
  const raw = await retrieveRaw(
    query,
    candidateLimit,
    filter,
    opts.method ?? "hybrid",
  );
  const pool = limitPerParent(dedupeNearDuplicates(raw));

  let ranked: RetrievedDoc[] = [];
  const reasons = new Map<string, string>();
  if (useApiRerank && pool.length > 1) {
    const items = await tryRerank(
      query,
      pool.map((d) => d.content),
      Math.min(topK, pool.length),
    );
    if (items && items.length > 0) {
      ranked = items.map((r) => ({ ...pool[r.index]!, score: r.score }));
    }
  }
  if (ranked.length === 0) {
    // Heuristic reranker (also the API-failure fallback, as in legacy).
    const heuristic = heuristicRerank(query, pool, topK);
    ranked = heuristic.ranked;
    for (const doc of ranked) {
      const reason = heuristic.reasons.get(doc.id);
      if (reason) reasons.set(doc.id, reason);
    }
  }

  const expanded = await expandSiblings(ranked.slice(0, topK));
  return expanded.map((doc) => {
    const reason = reasons.get(doc.id);
    return reason
      ? { ...doc, metadata: { ...doc.metadata, rank_reason: reason } }
      : doc;
  });
}
