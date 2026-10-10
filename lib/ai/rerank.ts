import { z } from "zod/v4";
import { config } from "@/lib/config";

export interface RerankItem {
  index: number;
  score: number;
}

export class RerankError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RerankError";
  }
}

const rerankResultSchema = z.object({
  index: z.number().int(),
  relevance_score: z.number(),
});

const rerankResponseSchema = z.object({
  output: z.object({
    results: z.array(rerankResultSchema),
  }),
});

export function rerankEnabled(): boolean {
  return config.rerank.apiKey !== "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseRerankResults(
  payload: unknown,
  documentCount: number,
  topN: number,
): RerankItem[] {
  const parsed = rerankResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new RerankError("Rerank service returned an invalid response.");
  }
  const items: RerankItem[] = [];
  const seen = new Set<number>();
  for (const result of parsed.data.output.results) {
    const index = result.index;
    const score = result.relevance_score;
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= documentCount ||
      seen.has(index) ||
      !Number.isFinite(score) ||
      score < 0 ||
      score > 1
    ) {
      throw new RerankError("Rerank service returned an invalid response.");
    }
    seen.add(index);
    items.push({ index, score });
  }
  items.sort((a, b) => b.score - a.score);
  return items.slice(0, topN);
}

export async function rerankDocuments(
  query: string,
  documents: string[],
  topN: number,
): Promise<RerankItem[]> {
  const normalizedQuery = query.trim();
  if (normalizedQuery === "" || documents.length === 0) return [];
  if (topN < 1 || topN > documents.length) {
    throw new RerankError("Rerank request is invalid.");
  }

  const { apiKey, url, model, timeoutMs, maxRetries } = config.rerank;
  const body = JSON.stringify({
    model,
    input: {
      query: { text: normalizedQuery },
      documents: documents.map((text) => ({ text })),
    },
    parameters: { return_documents: false, top_n: topN },
  });

  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (
        (response.status === 429 || response.status >= 500) &&
        attempt < maxRetries
      ) {
        await sleep(250 * 2 ** attempt);
        continue;
      }
      if (!response.ok) {
        throw new RerankError("Rerank service is temporarily unavailable.");
      }
      return parseRerankResults(await response.json(), documents.length, topN);
    } catch (e) {
      if (e instanceof RerankError) throw e;
      if (attempt < maxRetries) {
        await sleep(250 * 2 ** attempt);
        continue;
      }
      throw new RerankError("Rerank service is temporarily unavailable.");
    }
  }
}

export async function tryRerank(
  query: string,
  documents: string[],
  topN: number,
): Promise<RerankItem[] | null> {
  if (!rerankEnabled()) return null;
  try {
    return await rerankDocuments(query, documents, topN);
  } catch (e) {
    console.warn(
      "[rerank] failed, falling back to fusion order:",
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}
