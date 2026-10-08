// Milvus vector indexer. Replaces lib/redis/indexer.ts with an identical
// public API: embeds chunks and upserts them into the Milvus collection.
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
  // Optional embedding input distinct from the stored content (legacy
  // document_processing embedded `${title}\n${content}` while storing the
  // bare chunk text).
  embedText?: string;
  metadata: Record<string, unknown>;
}

// Upsert document chunks. Milvus upsert is idempotent on the primary key, so
// re-indexing the same id is safe. `metadata._source` is promoted to the
// dedicated `source` scalar field for filtered search/delete.
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

// Delete all chunks whose source matches exactly.
export async function deleteBySource(source: string): Promise<void> {
  await deleteByExpr(`source == ${quote(source)}`);
}

// Delete all chunks whose source starts with the given prefix (used by the
// DevFlow per-repo knowledge base, source = "devflow:kb:<repoId>:<docId>").
export async function deleteBySourcePrefix(prefix: string): Promise<void> {
  // Escape the LIKE wildcards inside the prefix, then append our own %.
  const escaped = prefix.replaceAll("%", "\\%").replaceAll("_", "\\_");
  await deleteByExpr(`source like ${quote(`${escaped}%`)}`);
}
