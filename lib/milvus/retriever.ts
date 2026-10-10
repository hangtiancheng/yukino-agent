import { hybridSearch, search, bm25Search, type MilvusHit } from "./client";
import { embedText } from "@/lib/ai/embedder";
import { rerankEnabled, tryRerank } from "@/lib/ai/rerank";

export interface RetrievedDoc {
  id: string;
  content: string;
  source: string;
  metadata: Record<string, unknown>;
  score: number;
}

const DEFAULT_TOP_K = 5;
const RERANK_CANDIDATE_LIMIT = 20;
const MAX_CANDIDATE_LIMIT = 50;

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
    score: hit.score,
  }));
}

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

export async function retrieveDense(
  query: string,
  topK = 1,
  filter?: string,
): Promise<RetrievedDoc[]> {
  const vector = await embedText(query);
  const hits = await search(vector, topK, filter);
  return toDocs(hits);
}
