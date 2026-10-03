// DevFlow per-repository knowledge base on Milvus.
// Replaces the Python RAG stack (Milvus + pgvector hybrid): documents are
// chunked, embedded and stored in the shared Milvus collection with a
// source tag "devflow:kb:<repoId>:<docId>", so retrieval is scoped to one
// repository via a filter expression. Document metadata lives in PostgreSQL.
import { createHash } from "node:crypto";
import { generateText } from "ai";
import { prisma } from "@/lib/db";
import { quickModel, providerOptions } from "@/lib/ai/models";
import { indexChunks, deleteBySource } from "@/lib/milvus/indexer";
import { retrieve } from "@/lib/milvus/retriever";
import { observeGeneration } from "@/lib/observability";
import { KNOWLEDGE_QA_PROMPT } from "./agents/prompts";

const KB_PREFIX = "devflow:kb";

export function kbSource(repoId: string, docId: string): string {
  return `${KB_PREFIX}:${repoId}:${docId}`;
}

// Milvus filter expression scoping retrieval to one repository's KB.
export function kbFilter(repoId: string): string {
  return `source like "${KB_PREFIX}:${repoId}:%"`;
}

// ---------------------------------------------------------------------------
// Chunking — paragraph-aware with size cap and tail overlap.
// ---------------------------------------------------------------------------

const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 100;

export function chunkText(content: string): string[] {
  const paragraphs = content
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== "");

  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    // Oversized paragraph: flush and hard-split it.
    if (paragraph.length > CHUNK_SIZE) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let i = 0; i < paragraph.length; i += CHUNK_SIZE - CHUNK_OVERLAP) {
        chunks.push(paragraph.slice(i, i + CHUNK_SIZE));
      }
      continue;
    }
    if (current.length + paragraph.length + 2 > CHUNK_SIZE) {
      chunks.push(current);
      // Carry the tail of the previous chunk as overlap context.
      current =
        current.slice(Math.max(0, current.length - CHUNK_OVERLAP)) +
        "\n\n" +
        paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// ---------------------------------------------------------------------------
// Text extraction for uploads — text-like files only; binaries get a clear,
// honest rejection instead of garbled content.
// ---------------------------------------------------------------------------

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".json",
  ".csv",
  ".tsv",
  ".log",
  ".yml",
  ".yaml",
  ".xml",
  ".html",
  ".htm",
  ".rst",
  ".adoc",
  ".py",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".h",
  ".cpp",
  ".sh",
  ".sql",
  ".toml",
  ".ini",
  ".conf",
  ".env",
  ".properties",
]);

export function extractText(filename: string, buffer: Buffer): string {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  if (!TEXT_EXTENSIONS.has(ext)) {
    throw new Error(
      `Unsupported file type "${ext || filename}". Supported: ${[...TEXT_EXTENSIONS].join(", ")}. PDF/DOCX extraction is not available in this deployment.`,
    );
  }
  return buffer.toString("utf8");
}

// ---------------------------------------------------------------------------
// Document lifecycle
// ---------------------------------------------------------------------------

export interface KnowledgeHit {
  docId: string;
  docName: string;
  chunkIndex: number;
  content: string;
  score: number;
}

export interface AddDocumentResult {
  docId: string;
  status: "ready" | "skipped";
  chunkCount: number;
  existingName?: string;
}

// Index a document: SHA-256 dedup per repository (same as the Python
// original), chunk + embed into Milvus, record metadata in PostgreSQL.
export async function addKnowledgeDocument(input: {
  repoId: string;
  name: string;
  content: string;
  sourceType?: string;
}): Promise<AddDocumentResult> {
  const { repoId, name, content } = input;
  const contentHash = createHash("sha256").update(content).digest("hex");

  const existing = await prisma.knowledgeDocument.findUnique({
    where: { repoId_contentHash: { repoId, contentHash } },
  });
  if (existing) {
    return {
      docId: existing.id,
      status: "skipped",
      chunkCount: existing.chunkCount,
      existingName: existing.name,
    };
  }

  const doc = await prisma.knowledgeDocument.create({
    data: {
      repoId,
      name,
      sourceType: input.sourceType ?? "upload",
      status: "indexing",
      contentHash,
      charCount: content.length,
    },
  });

  try {
    const chunks = chunkText(content);
    await indexChunks(
      chunks.map((text, i) => ({
        id: `${doc.id}#${i}`,
        content: text,
        metadata: {
          _source: kbSource(repoId, doc.id),
          repo_id: repoId,
          doc_id: doc.id,
          doc_name: name,
          chunk_index: i,
        },
      })),
    );
    await prisma.knowledgeDocument.update({
      where: { id: doc.id },
      data: { status: "ready", chunkCount: chunks.length },
    });
    return { docId: doc.id, status: "ready", chunkCount: chunks.length };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await prisma.knowledgeDocument.update({
      where: { id: doc.id },
      data: { status: "failed", errorMessage: message },
    });
    throw e;
  }
}

export async function deleteKnowledgeDocument(docId: string): Promise<void> {
  const doc = await prisma.knowledgeDocument.findUnique({
    where: { id: docId },
  });
  if (!doc) return;
  await deleteBySource(kbSource(doc.repoId, docId));
  await prisma.knowledgeDocument.delete({ where: { id: docId } });
}

export async function listKnowledgeDocuments(repoId: string) {
  return prisma.knowledgeDocument.findMany({
    where: { repoId },
    orderBy: { createdAt: "desc" },
  });
}

// ---------------------------------------------------------------------------
// Retrieval + QA
// ---------------------------------------------------------------------------

export async function searchKnowledge(
  repoId: string,
  query: string,
  topK = 5,
): Promise<KnowledgeHit[]> {
  const docs = await retrieve(query, topK, kbFilter(repoId));
  return docs.map((doc) => ({
    docId: String(doc.metadata.doc_id ?? ""),
    docName: String(doc.metadata.doc_name ?? "unknown"),
    chunkIndex: Number(doc.metadata.chunk_index ?? 0),
    content: doc.content,
    score: doc.score,
  }));
}

export interface KnowledgeCitation {
  index: number;
  docName: string;
  snippet: string;
  score: number;
}

export interface KnowledgeAnswer {
  answer: string;
  citations: KnowledgeCitation[];
}

// Evidence-grounded QA: retrieve scoped hits, then generate an answer that
// cites them by number. Insufficient evidence yields an honest "not found"
// answer instead of fabrication (same policy as the Python answer gate).
export async function askKnowledge(
  repoId: string,
  question: string,
  topK = 5,
): Promise<KnowledgeAnswer> {
  const hits = await searchKnowledge(repoId, question, topK);
  if (hits.length === 0) {
    return {
      answer:
        "No relevant evidence was found in this repository's knowledge base. Upload documents first, or rephrase the question.",
      citations: [],
    };
  }

  const evidence = hits
    .map(
      (hit, i) =>
        `[${i + 1}] (document: ${hit.docName}, chunk ${hit.chunkIndex})\n${hit.content}`,
    )
    .join("\n\n---\n\n");
  const prompt = `Question: ${question}\n\nEvidence passages:\n\n${evidence}`;

  const answer = await observeGeneration(
    "devflow-knowledge-ask",
    async (generation) => {
      const res = await generateText({
        model: quickModel,
        system: KNOWLEDGE_QA_PROMPT,
        prompt,
        providerOptions,
      });
      generation?.update({ input: prompt, output: res.text });
      return res.text;
    },
  );

  return {
    answer,
    citations: hits.map((hit, i) => ({
      index: i + 1,
      docName: hit.docName,
      snippet: hit.content.slice(0, 200),
      score: hit.score,
    })),
  };
}
