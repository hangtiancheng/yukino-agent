import {
  upsert,
  deleteByExpr,
  quote,
  MAX_CONTENT_LENGTH,
  type MilvusRow,
} from "./client";
import { embedTexts } from "@/lib/ai/embedder";

export interface IndexChunk {
  id: string;
  content: string;
  embedText?: string;
  metadata: Record<string, unknown>;
}

export async function indexChunks(chunks: IndexChunk[]): Promise<number> {
  if (chunks.length === 0) return 0;
  const vectors = await embedTexts(chunks.map((c) => c.embedText ?? c.content));

  const rows: MilvusRow[] = chunks.map((chunk, i) => ({
    id: chunk.id,
    vector: vectors[i],
    content: chunk.content.slice(0, MAX_CONTENT_LENGTH),
    source: String(chunk.metadata._source ?? ""),
    metadata: JSON.stringify(chunk.metadata).slice(0, 16384),
    created_at: new Date().toISOString(),
  }));
  return upsert(rows);
}

export async function deleteBySource(source: string): Promise<void> {
  await deleteByExpr(`source == ${quote(source)}`);
}

export async function deleteBySourcePrefix(prefix: string): Promise<void> {
  const escaped = prefix.replaceAll("%", "\\%").replaceAll("_", "\\_");
  await deleteByExpr(`source like ${quote(`${escaped}%`)}`);
}
