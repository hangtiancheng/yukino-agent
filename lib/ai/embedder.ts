// Embedding via @ai-sdk/openai-compatible; provider selected by EMBEDDING_PROVIDER:
//   "openai" (default, text-embedding-v4)
import { embed, embedMany, type EmbeddingModel } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { config } from "@/lib/config";

// Provider factory — symmetric with resolveThinkModel/resolveQuickModel in models.ts
function createEmbeddingProvider(): EmbeddingModel {
  // Default: openai (text-embedding-v4, OpenAI compatible)
  const openai = createOpenAICompatible({
    name: "openai",
    baseURL: config.openaiEmbedding.baseURL,
    apiKey: config.openaiEmbedding.apiKey,
  });
  return openai.embeddingModel(config.openaiEmbedding.model);
}

export const embeddingModel = createEmbeddingProvider();

// Get float embedding for a single text (dimension depends on the active provider)
export async function embedText(text: string): Promise<number[]> {
  const { embedding } = await embed({ model: embeddingModel, value: text });
  return embedding;
}

// Batch get embeddings.
// OpenAI-compatible endpoints cap inputs per request (text-embedding-v4 allows 10), while the SDK default is 2048 per call —
// large documents would fail with "batch size is invalid" without splitting.
const EMBED_BATCH_SIZE = 10;

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const { embeddings } = await embedMany({
      model: embeddingModel,
      values: texts.slice(i, i + EMBED_BATCH_SIZE),
    });
    results.push(...embeddings);
  }
  return results;
}
