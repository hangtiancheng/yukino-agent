// Knowledge index pipeline: FileLoader → RecursiveCharacterTextSplitter → RedisIndexer
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { loadFile } from "../loader";
import { config } from "@/lib/config";
import {
  indexChunks,
  deleteBySource,
  type IndexChunk,
} from "@/lib/redis/indexer";

interface MarkdownChunk {
  content: string;
  title: string;
}

// Sizes match the proven yukino-chatbot RAG setup; 1000 chars stays far below
// both the indexer's 8192-char storage cap and embedding-provider input
// limits, so the embedded text is always identical to the stored text.
const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 200;

const splitter = RecursiveCharacterTextSplitter.fromLanguage("markdown", {
  chunkSize: CHUNK_SIZE,
  chunkOverlap: CHUNK_OVERLAP,
});

const HEADING_PATTERN = /^#{1,6} +(.+)$/;

function headingsIn(chunk: string): string[] {
  const titles: string[] = [];
  for (const line of chunk.split("\n")) {
    const match = HEADING_PATTERN.exec(line);
    if (match) {
      titles.push(match[1].trim());
    }
  }
  return titles;
}

// Split markdown into retrieval chunks via LangChain's markdown-aware
// recursive splitter. Each chunk is annotated with a section title: the first
// heading inside the chunk, or the nearest heading carried over from earlier
// chunks (chunks arrive in document order).
async function splitMarkdown(content: string): Promise<MarkdownChunk[]> {
  const parts = await splitter.splitText(content);
  const chunks: MarkdownChunk[] = [];
  let currentTitle = "";
  for (const part of parts) {
    const titles = headingsIn(part);
    chunks.push({ content: part, title: titles[0] ?? currentTitle });
    if (titles.length > 0) {
      currentTitle = titles[titles.length - 1];
    }
  }
  return chunks;
}

// Build the knowledge index for a file: delete old records with the same
// _source, split into chunks, embed and insert.
export async function buildKnowledgeIndex(filePath: string): Promise<number> {
  const doc = await loadFile(filePath);
  await deleteBySource(doc.source);
  const parts = await splitMarkdown(doc.content);
  const chunks: IndexChunk[] = parts
    .filter((p) => p.content.trim() !== "")
    .map((p) => ({
      id: randomUUID(),
      content: p.content,
      metadata: { _source: doc.source, title: p.title },
    }));
  return indexChunks(chunks);
}

const SUPPORTED_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);

// Index every supported document in the knowledge-base directory
// (config.fileDir). Called at server startup from instrumentation.ts.
// Per-file failures are logged and skipped so one bad file doesn't block
// the rest — or the server boot.
export async function indexDataDir(): Promise<void> {
  const dir = path.resolve(config.fileDir);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    console.warn(`[knowledge-index] data dir not found, skipping: ${dir}`);
    return;
  }

  const files = entries
    .filter(
      (e) =>
        e.isFile() &&
        SUPPORTED_EXTENSIONS.has(path.extname(e.name).toLowerCase()),
    )
    .map((e) => e.name);
  console.log(`[knowledge-index] indexing ${files.length} file(s) from ${dir}`);

  for (const file of files) {
    try {
      const count = await buildKnowledgeIndex(path.join(dir, file));
      console.log(`[knowledge-index] indexed ${file}: ${count} chunk(s)`);
    } catch (e) {
      console.error(`[knowledge-index] failed to index ${file}:`, e);
    }
  }
}
