import { hybridSearch, search, bm25Search, type MilvusHit } from "./client";
import { embedText } from "@/lib/ai/embedder";
import { rerankEnabled, tryRerank } from "@/lib/ai/rerank";

export interface RetrievalStageRanks {
  vectorRank?: number;
  vectorScore?: number;
  bm25Rank?: number;
  bm25Score?: number;
  rerankRank?: number;
  rerankScore?: number;
}

export interface RetrievedDoc {
  id: string;
  content: string;
  source: string;
  metadata: Record<string, unknown>;
  score: number;
  stages?: RetrievalStageRanks;
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

interface StageRankIndex {
  rankById: Map<string, { rank: number; score: number }>;
}

function buildStageIndex(hits: MilvusHit[]): StageRankIndex {
  const rankById = new Map<string, { rank: number; score: number }>();
  hits.forEach((hit, index) => {
    if (!rankById.has(hit.id)) {
      rankById.set(hit.id, { rank: index + 1, score: hit.score });
    }
  });
  return { rankById };
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
  const [hits, denseHits, bm25Hits] = await Promise.all([
    hybridSearch(vector, query, candidateLimit, 50, filter),
    search(vector, candidateLimit, filter).catch(() => [] as MilvusHit[]),
    bm25Search(query, candidateLimit, filter).catch(() => [] as MilvusHit[]),
  ]);
  const denseIndex = buildStageIndex(denseHits);
  const bm25Index = buildStageIndex(bm25Hits);
  let docs = toDocs(hits);
  if (excludeDevflow) {
    docs = docs.filter((d) => !d.source.startsWith(DEVFLOW_SOURCE_PREFIX));
  }
  const withStages = docs.map((doc) => {
    const denseRank = denseIndex.rankById.get(doc.id);
    const bm25Rank = bm25Index.rankById.get(doc.id);
    if (!denseRank && !bm25Rank) return doc;
    return {
      ...doc,
      stages: {
        ...(denseRank
          ? { vectorRank: denseRank.rank, vectorScore: denseRank.score }
          : {}),
        ...(bm25Rank
          ? { bm25Rank: bm25Rank.rank, bm25Score: bm25Rank.score }
          : {}),
      },
    };
  });
  if (rerank && withStages.length > 1) {
    const ranked = await tryRerank(
      query,
      withStages.map((d) => d.content),
      Math.min(topK, withStages.length),
    );
    if (ranked) {
      return ranked.map((r, index) => ({
        ...withStages[r.index],
        score: r.score,
        stages: {
          ...(withStages[r.index]?.stages ?? {}),
          rerankRank: index + 1,
          rerankScore: r.score,
        },
      }));
    }
  }
  return withStages.slice(0, topK);
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
