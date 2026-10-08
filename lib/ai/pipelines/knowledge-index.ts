// Knowledge index pipeline: FileLoader → RecursiveCharacterTextSplitter → MilvusIndexer
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { loadFile } from "@/lib/ai/loader";
import { config } from "@/lib/config";
import {
  indexChunks,
  deleteBySource,
  type IndexChunk,
} from "@/lib/milvus/indexer";

interface MarkdownChunk {
  content: string;
  title: string;
}

// Document classification carried on every chunk as metadata.knowledgeType
// (port of legacy agent_py indexing.py `_knowledge_type`): drives the
// reference chips in the OnCall chat UI (SOP / knowledge doc / diagnostic
// case). Values must stay in sync with the frontend label map.
export const KNOWLEDGE_TYPES = ["sop", "document", "diagnostic-case"] as const;
export type KnowledgeType = (typeof KNOWLEDGE_TYPES)[number];

export function isKnowledgeType(v: unknown): v is KnowledgeType {
  return (
    typeof v === "string" && (KNOWLEDGE_TYPES as readonly string[]).includes(v)
  );
}

// Optional `knowledgeType: <value>` line inside a leading --- frontmatter
// block. Only the first block is scanned; an invalid value is ignored so the
// heuristics below still get a chance.
export function parseFrontmatterKnowledgeType(
  content: string,
): KnowledgeType | undefined {
  const match =
    /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!match) return undefined;
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^\s*knowledgeType\s*:\s*(.+?)\s*$/.exec(line);
    if (!kv) continue;
    const value = kv[1].replaceAll(/^["']|["']$/g, "");
    if (isKnowledgeType(value)) return value;
  }
  return undefined;
}

// Classification order (legacy parity): explicit frontmatter wins, then the
// AI Ops case prefix (legacy source "aiops-diagnostic"), then the sop
// filename/body heuristic, else plain document.
export function classifyKnowledgeType(
  fileName: string,
  content: string,
): KnowledgeType {
  const explicit = parseFrontmatterKnowledgeType(content);
  if (explicit) return explicit;
  const name = fileName.toLowerCase();
  if (name.startsWith("aiops-case-")) return "diagnostic-case";
  if (name.includes("sop")) return "sop";
  if (/standard operating procedure/i.test(content.slice(0, 2000))) {
    return "sop";
  }
  return "document";
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
// _source, split into chunks, embed and insert. `knowledgeTypeOverride` pins
// the classification (diagnostic cases and explicit upload choices) and
// bypasses the filename/content heuristics. PDF/DOCX originals are extracted
// first (unpdf/mammoth, legacy caps) so startup re-indexing stays idempotent.
export async function buildKnowledgeIndex(
  filePath: string,
  knowledgeTypeOverride?: KnowledgeType,
): Promise<number> {
  const ext = path.extname(filePath).toLowerCase();
  let content: string;
  const source = path.basename(filePath);
  if (ext === ".pdf" || ext === ".docx") {
    const { extractBinaryDocumentText } = await import("@/lib/ai/doc-extract");
    const buffer = await readFile(filePath);
    const text = await extractBinaryDocumentText(source, buffer);
    if (text === null || text.trim() === "") {
      throw new Error(
        `${source}: no extractable text (scanned image PDF or empty document)`,
      );
    }
    content = text;
  } else {
    const doc = await loadFile(filePath);
    content = doc.content;
  }
  await deleteBySource(source);
  const parts = await splitMarkdown(content);
  const knowledgeType =
    knowledgeTypeOverride ?? classifyKnowledgeType(source, content);
  const chunks: IndexChunk[] = parts
    .filter((p) => p.content.trim() !== "")
    .map((p) => ({
      id: randomUUID(),
      content: p.content,
      metadata: {
        _source: source,
        title: p.title,
        knowledgeType,
      },
    }));
  return indexChunks(chunks);
}

const SUPPORTED_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".pdf",
  ".docx",
]);

// Read + chunk a knowledge file WITHOUT touching Milvus (legacy chunk
// preview endpoint): returns the first `limit` chunks and the total count.
export async function previewChunks(
  filePath: string,
  limit = 12,
): Promise<{
  total: number;
  chunks: Array<{ content: string; title: string }>;
}> {
  const ext = path.extname(filePath).toLowerCase();
  let content: string;
  if (ext === ".pdf" || ext === ".docx") {
    const { extractBinaryDocumentText } = await import("@/lib/ai/doc-extract");
    const buffer = await readFile(filePath);
    const text = await extractBinaryDocumentText(
      path.basename(filePath),
      buffer,
    );
    if (text === null || text.trim() === "") {
      throw new Error("no extractable text");
    }
    content = text;
  } else {
    const doc = await loadFile(filePath);
    content = doc.content;
  }
  const parts = await splitMarkdown(content);
  return { total: parts.length, chunks: parts.slice(0, limit) };
}

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
