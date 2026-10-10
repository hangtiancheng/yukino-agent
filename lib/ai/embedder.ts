import { embed, embedMany, type EmbeddingModel } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { config } from "@/lib/config";

function createEmbeddingProvider(): EmbeddingModel {
  const openai = createOpenAICompatible({
    name: "openai",
    baseURL: config.openaiEmbedding.baseURL,
    apiKey: config.openaiEmbedding.apiKey,
  });
  return openai.embeddingModel(config.openaiEmbedding.model);
}

export const embeddingModel = createEmbeddingProvider();

export async function embedText(text: string): Promise<number[]> {
  const { embedding } = await embed({ model: embeddingModel, value: text });
  return embedding;
}

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
