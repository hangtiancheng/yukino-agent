// DevFlow per-repository knowledge base on Milvus.
// Replaces the Python RAG stack (Milvus + pgvector hybrid): documents are
// chunked, embedded and stored in the shared Milvus collection with a
// source tag "devflow:kb:<repoId>:<docId>", so retrieval is scoped to one
// repository via a filter expression. Document metadata lives in PostgreSQL.
import { createHash } from "node:crypto";
import { generateText } from "ai";
import { z } from "zod/v4";
import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { quickModel, providerOptions } from "@/lib/ai/models";
import { indexChunks, deleteBySource } from "@/lib/milvus/indexer";
import { queryByFilter, quote, count } from "@/lib/milvus/client";
import { observeGeneration } from "@/lib/observability";
import { KNOWLEDGE_QA_PROMPT } from "./agents/prompts";
import { chunkDocument, siblingIdsByParent, type Chunk } from "./chunking";
import { scopedRetrieve } from "./search";

const KB_PREFIX = "devflow:kb";

export function kbSource(repoId: string, docId: string): string {
  return `${KB_PREFIX}:${repoId}:${docId}`;
}

// Milvus filter expression scoping retrieval to one repository's KB.
export function kbFilter(repoId: string): string {
  return `source like "${KB_PREFIX}:${repoId}:%"`;
}

// ---------------------------------------------------------------------------
// Chunking — structure-aware (port of the Python structure_aware_v1
// strategy): markdown sections/fences, CSV header-aware rows, JSON key paths
// and code symbol regions, with stable ids + parent/sibling metadata the
// retrieval pipeline (dedup, per-parent cap, expansion) builds on.
// ---------------------------------------------------------------------------

const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 100;

// Legacy chunk titles (document_processing.py): `${docName} · ${label}` where
// label = section title | Page N | Chunk i.
function chunkLabel(chunk: Chunk, runningIndex: number): string {
  const sectionTitle = chunk.section_title;
  if (typeof sectionTitle === "string" && sectionTitle !== "")
    return sectionTitle;
  if (chunk.page !== null && chunk.page !== undefined)
    return `Page ${chunk.page}`;
  return `Chunk ${runningIndex + 1}`;
}

// Metadata for one indexed chunk: chunk structure fields (minus content and
// nulls, like the legacy payload builder) + document identity + sibling row
// ids for parent expansion.
export function chunkRowMetadata(
  chunk: Chunk,
  docIdentity: Record<string, unknown>,
  siblings: string[],
): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(chunk)) {
    if (key === "content" || value === null || value === undefined) continue;
    meta[key] = value;
  }
  return {
    ...meta,
    ...docIdentity,
    chunk_strategy: "structure_aware_v1",
    sibling_ids: siblings,
  };
}

// Chunk + stamp sibling row ids (row id = `${docId}#${runningIndex}`).
// Optional chunking override lets callers apply the per-repo
// KnowledgeBaseConfig (chunkSize/chunkOverlap); the module constants stay
// the default so existing callers are unchanged.
export function buildChunkRows(
  content: string,
  name: string,
  docId: string,
  docIdentity: Record<string, unknown>,
  chunking?: { chunkSize: number; chunkOverlap: number },
): Array<{
  id: string;
  content: string;
  embedText: string;
  metadata: Record<string, unknown>;
}> {
  const chunks = chunkDocument(
    content,
    name,
    chunking?.chunkSize ?? CHUNK_SIZE,
    chunking?.chunkOverlap ?? CHUNK_OVERLAP,
  );
  const idFor = (i: number) => `${docId}#${i}`;
  const siblings = siblingIdsByParent(chunks, idFor);
  return chunks.map((chunk, i) => {
    const childSuffix =
      chunk.child_index > 0 ? ` (${chunk.child_index + 1})` : "";
    const title = `${name} · ${chunkLabel(chunk, i)}${childSuffix}`;
    return {
      id: idFor(i),
      content: chunk.content,
      embedText: `${title}\n${chunk.content}`,
      metadata: chunkRowMetadata(
        chunk,
        docIdentity,
        siblings[i] ?? ["", idFor(i), ""],
      ),
    };
  });
}

// ---------------------------------------------------------------------------
// Text extraction for uploads — text-like files plus PDF/DOCX (unpdf /
// mammoth with the legacy zip-bomb caps; see lib/ai/doc-extract.ts).
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

export async function extractText(
  filename: string,
  buffer: Buffer,
): Promise<string> {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  if (ext === ".pdf" || ext === ".docx") {
    const { extractBinaryDocumentText } = await import("@/lib/ai/doc-extract");
    const text = await extractBinaryDocumentText(filename, buffer);
    if (text === null) {
      throw new Error(`Unsupported file type "${ext || filename}"`);
    }
    if (!text.trim()) {
      throw new Error(
        "PDF/DOCX contains no extractable text (it may be scanned images)",
      );
    }
    return text;
  }
  if (!TEXT_EXTENSIONS.has(ext)) {
    throw new Error(
      `Unsupported file type "${ext || filename}". Supported: ${[...TEXT_EXTENSIONS, ".pdf", ".docx"].join(", ")}.`,
    );
  }
  const { decodeTextBytes } = await import("@/lib/ai/doc-extract");
  return decodeTextBytes(buffer);
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
  sectionTitle?: string;
  rankReason?: string;
  sourceType?: string;
}

export interface AddDocumentResult {
  docId: string;
  status: "ready" | "skipped";
  chunkCount: number;
  existingName?: string;
}

// Index a document: SHA-256 dedup per repository (same as the Python
// original), chunk + embed into Milvus, record metadata in PostgreSQL.
// Optional chunkSize/chunkOverlap carry the per-repo KnowledgeBaseConfig
// (legacy routes/rag.py knowledge_base_config); omitting them keeps the
// module defaults.
export async function addKnowledgeDocument(input: {
  repoId: string;
  name: string;
  content: string;
  sourceType?: string;
  chunkSize?: number;
  chunkOverlap?: number;
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
      // The raw text is kept so a failed index can be retried without
      // re-uploading (legacy routes/rag.py documents/{id}/retry).
      body: { create: { content } },
    },
  });

  return indexDocumentContent(doc.id, {
    repoId,
    name,
    content,
    sourceType: input.sourceType ?? "upload",
    chunkSize: input.chunkSize,
    chunkOverlap: input.chunkOverlap,
  });
}

// Chunk + embed one document's text and settle its status row. Shared by the
// first index (addKnowledgeDocument) and the retry path (retryDocument).
async function indexDocumentContent(
  docId: string,
  input: {
    repoId: string;
    name: string;
    content: string;
    sourceType: string;
    chunkSize?: number;
    chunkOverlap?: number;
  },
): Promise<AddDocumentResult> {
  const { repoId, name, content, sourceType } = input;
  await prisma.knowledgeDocument.update({
    where: { id: docId },
    data: { status: "indexing", errorMessage: null },
  });
  try {
    const rows = buildChunkRows(
      content,
      name,
      docId,
      {
        _source: kbSource(repoId, docId),
        repo_id: repoId,
        doc_id: docId,
        doc_name: name,
        source_type: sourceType,
      },
      input.chunkSize !== undefined && input.chunkOverlap !== undefined
        ? { chunkSize: input.chunkSize, chunkOverlap: input.chunkOverlap }
        : undefined,
    );
    await indexChunks(rows);
    await prisma.knowledgeDocument.update({
      where: { id: docId },
      data: { status: "ready", chunkCount: rows.length },
    });
    return { docId, status: "ready", chunkCount: rows.length };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await prisma.knowledgeDocument.update({
      where: { id: docId },
      data: { status: "failed", errorMessage: message },
    });
    throw e;
  }
}

// Retry a failed document — port of routes/rag.py:262-280 retry_document.
// The stored body is re-chunked and re-embedded; only documents that actually
// failed are retriable (legacy raised otherwise).
export async function retryDocument(docId: string): Promise<AddDocumentResult> {
  const doc = await prisma.knowledgeDocument.findUnique({
    where: { id: docId },
    include: { body: true },
  });
  if (!doc) throw new Error(`Knowledge document ${docId} not found`);
  if (doc.status !== "failed") {
    throw new Error(
      `Only failed documents can be retried (status: ${doc.status})`,
    );
  }
  if (!doc.body) {
    throw new Error(
      `Knowledge document ${docId} has no stored content to retry from; re-upload it.`,
    );
  }
  const cfg = await getKnowledgeConfig(doc.repoId);
  return indexDocumentContent(doc.id, {
    repoId: doc.repoId,
    name: doc.name,
    content: doc.body.content,
    sourceType: doc.sourceType,
    chunkSize: cfg.chunkSize,
    chunkOverlap: cfg.chunkOverlap,
  });
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
// Per-repo knowledge-base configuration (legacy routes/rag.py:119-398 —
// the knowledge_base_config + retrieval-tests slice of the RAG studio).
// retrievalMethod/rerankEnabled are honored live by scopedRetrieve (see
// lib/devflow/search.ts): dense/bm25 select single-leg recall and the rerank
// flag gates the API rerank stage (heuristic rerank still runs as the
// no-API-key fallback, same as legacy).
// ---------------------------------------------------------------------------

export const KB_RETRIEVAL_METHODS = ["hybrid", "dense", "bm25"] as const;
export type KbRetrievalMethod = (typeof KB_RETRIEVAL_METHODS)[number];

export interface KnowledgeConfigValues {
  retrievalMethod: KbRetrievalMethod;
  rerankEnabled: boolean;
  topK: number;
  chunkSize: number;
  chunkOverlap: number;
}

// Fallback when no config row exists: the current code constants, so behavior
// stays backward compatible.
export const KB_CONFIG_FALLBACK: KnowledgeConfigValues = {
  retrievalMethod: "hybrid",
  rerankEnabled: true,
  topK: 5,
  chunkSize: CHUNK_SIZE,
  chunkOverlap: CHUNK_OVERLAP,
};

export const KnowledgeConfigUpdateSchema = z
  .object({
    repoId: z.string().min(1),
    retrievalMethod: z.enum(KB_RETRIEVAL_METHODS).optional(),
    rerankEnabled: z.boolean().optional(),
    topK: z.number().int().min(1).max(20).optional(),
    chunkSize: z.number().int().min(100).max(8_000).optional(),
    chunkOverlap: z.number().int().min(0).max(4_000).optional(),
  })
  // Legacy _validate_chunking (routes/rag.py:149-151).
  .refine(
    (v) =>
      v.chunkOverlap === undefined ||
      v.chunkSize === undefined ||
      v.chunkOverlap < v.chunkSize,
    { message: "chunkOverlap must be smaller than chunkSize" },
  );

function isKbRetrievalMethod(value: string): value is KbRetrievalMethod {
  return (KB_RETRIEVAL_METHODS as readonly string[]).includes(value);
}

export async function getKnowledgeConfig(
  repoId: string,
): Promise<KnowledgeConfigValues> {
  const row = await prisma.knowledgeBaseConfig.findUnique({
    where: { repoId },
  });
  if (!row) return { ...KB_CONFIG_FALLBACK };
  return {
    retrievalMethod: isKbRetrievalMethod(row.retrievalMethod)
      ? row.retrievalMethod
      : KB_CONFIG_FALLBACK.retrievalMethod,
    rerankEnabled: row.rerankEnabled,
    topK: row.topK,
    chunkSize: row.chunkSize,
    chunkOverlap: row.chunkOverlap,
  };
}

export async function upsertKnowledgeConfig(
  repoId: string,
  patch: Partial<KnowledgeConfigValues>,
): Promise<KnowledgeConfigValues> {
  const row = await prisma.knowledgeBaseConfig.upsert({
    where: { repoId },
    create: { repoId, ...KB_CONFIG_FALLBACK, ...patch },
    update: patch,
  });
  return {
    retrievalMethod: isKbRetrievalMethod(row.retrievalMethod)
      ? row.retrievalMethod
      : KB_CONFIG_FALLBACK.retrievalMethod,
    rerankEnabled: row.rerankEnabled,
    topK: row.topK,
    chunkSize: row.chunkSize,
    chunkOverlap: row.chunkOverlap,
  };
}

// ---------------------------------------------------------------------------
// Retrieval + QA
// ---------------------------------------------------------------------------

export async function searchKnowledge(
  repoId: string,
  query: string,
  topK = 5,
  opts?: {
    // Overrides the KB-scope filter expression (legacy search.py
    // metadata_filters minimal set: scope/docId select the source slice).
    filter?: string;
    // Post-retrieval filter on chunk metadata.source_type — the metadata JSON
    // is not a filterable Milvus scalar field, so we over-fetch and cut.
    sourceType?: string;
  },
): Promise<KnowledgeHit[]> {
  const filter = opts?.filter ?? kbFilter(repoId);
  const fetchK = opts?.sourceType ? topK * 2 : topK;
  // Per-repo retrieval settings (legacy KnowledgeBaseConfig): method + rerank
  // toggle. A missing row falls back to hybrid + rerank-enabled, matching the
  // previous behavior.
  const cfg = await getKnowledgeConfig(repoId);
  const docs = await scopedRetrieve(query, fetchK, filter, {
    method: cfg.retrievalMethod,
    rerank: cfg.rerankEnabled,
  });
  const hits = docs.map((doc) => ({
    docId: String(doc.metadata.doc_id ?? ""),
    docName: String(doc.metadata.doc_name ?? "unknown"),
    chunkIndex: Number(doc.metadata.chunk_index ?? 0),
    content: doc.content,
    score: doc.score,
    sectionTitle:
      typeof doc.metadata.section_title === "string"
        ? doc.metadata.section_title
        : undefined,
    rankReason:
      typeof doc.metadata.rank_reason === "string"
        ? doc.metadata.rank_reason
        : undefined,
    sourceType:
      typeof doc.metadata.source_type === "string"
        ? doc.metadata.source_type
        : undefined,
  }));
  const kept = opts?.sourceType
    ? hits.filter((hit) => hit.sourceType === opts.sourceType)
    : hits;
  return kept.slice(0, topK);
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
  // Port of the legacy generation_mode (qa.py:190,200): "llm" when a model
  // produced the answer, "extractive" for the no-LLM quote splice, and
  // "no_evidence" for refusals.
  generationMode?: "llm" | "extractive" | "no_evidence";
}

// ---------------------------------------------------------------------------
// Answer gate — port of the Python answer_gate.py (DevFlow-AI), adapted to
// this stack: the legacy absolute score-threshold assumed comparable [0, 1]
// relevance scores, which Milvus RRF fusion ranks do not provide — the
// conflict state therefore treats the top-ranked candidates as the
// high-confidence evidence. The three language-level checks are ported:
// strong-signal evidence matching (anti-fabrication), polarity conflict, and
// ambiguous-query clarification (Chinese markers kept verbatim; explicit
// English phrases added because the legacy Chinese-only list could never
// fire in the now-bilingual product).
// ---------------------------------------------------------------------------

const AMBIGUOUS_MARKERS = [
  "这个",
  "那个",
  "它",
  "这段",
  "这里",
  "怎么办",
  "怎么处理",
];

// Conservative English stand-ins for the Chinese demonstratives — explicit
// phrases only, so ordinary "this function" questions do not trigger.
const AMBIGUOUS_ENGLISH = [
  "this one",
  "that thing",
  "the above",
  "same issue",
  "what should i do",
  "how to handle",
];

// Ported polarity table (answer_gate.py CONFLICT_POLARITIES).
const CONFLICT_POLARITIES: Array<[string, string[], string[]]> = [
  [
    "permission",
    ["允许", "可以", "enabled", "enable"],
    ["禁止", "不允许", "不能", "disabled", "disable"],
  ],
  [
    "outcome",
    ["成功", "通过", "success", "passed"],
    ["失败", "未通过", "failure", "failed"],
  ],
  ["requirement", ["必须", "需要", "required"], ["可选", "无需", "optional"]],
];

const STRONG_SIGNAL_RE = /[A-Za-z][A-Za-z0-9_./-]*|#\d+|\b\d{3,}\b/g;

export type AnswerGateDecision =
  "answer" | "insufficient_evidence" | "conflict" | "ask_clarification";

// Identifiers in the question that any honest answer must be able to point at
// in the evidence (names with separators/digits, #123 refs, long numbers).
export function strongQuerySignals(query: string): string[] {
  const candidates = query.match(STRONG_SIGNAL_RE) ?? [];
  const signals: string[] = [];
  for (const candidate of candidates) {
    if (
      /[_./-]/.test(candidate) ||
      /\d/.test(candidate) ||
      /(Error|Exception)$/.test(candidate)
    ) {
      signals.push(candidate.toLowerCase());
    }
  }
  return [...new Set(signals)];
}

export interface AnswerGate {
  decision: AnswerGateDecision;
  missingSignals?: string[];
}

function evidenceText(hit: { docName: string; content: string }): string {
  return `${hit.docName}\n${hit.content}`.toLowerCase().split(/\s+/).join(" ");
}

// Polarity conflict among the top-ranked (high-confidence) evidence, mirroring
// _detect_conflict: one top source states a positive polarity while another
// states the negative one for the same dimension.
function detectConflict(
  hits: Array<{ docName: string; content: string }>,
): { type: string } | null {
  const highConfidence = hits.slice(0, 2);
  if (highConfidence.length < 2) return null;
  const texts = highConfidence.map(
    (hit, i) => [String(i), evidenceText(hit)] as const,
  );
  for (const [conflictType, positives, negatives] of CONFLICT_POLARITIES) {
    const negativeIds = texts
      .filter(([, text]) => negatives.some((marker) => text.includes(marker)))
      .map(([id]) => id);
    const positiveIds = texts
      .filter(
        ([, text]) =>
          positives.some((marker) => text.includes(marker)) &&
          !negatives.some((marker) => text.includes(marker)),
      )
      .map(([id]) => id);
    // Legacy: `positive_ids && negative_ids && set(pos) != set(neg)`. The
    // positive filter excludes any doc containing a negative marker, so the
    // two id sets can only be equal when one is empty — both non-empty is
    // exactly the legacy conflict condition.
    if (positiveIds.length > 0 && negativeIds.length > 0) {
      return { type: conflictType };
    }
  }
  return null;
}

export function evaluateAnswerGate(
  query: string,
  hits: Array<{ docId: string; docName: string; content: string }>,
): AnswerGate {
  if (hits.length === 0) return { decision: "insufficient_evidence" };

  const evidence = hits.map((h) => evidenceText(h)).join(" ");
  const signals = strongQuerySignals(query);
  const missingSignals = signals.filter((s) => !evidence.includes(s));
  // ALL strong signals absent → the evidence cannot possibly ground an answer
  // naming them; refuse instead of letting the model fabricate.
  if (signals.length > 0 && missingSignals.length === signals.length) {
    return { decision: "insufficient_evidence", missingSignals };
  }

  if (detectConflict(hits)) {
    return { decision: "conflict" };
  }

  const compact = query.replace(/\s+/g, "");
  const lowered = query.toLowerCase();
  const zhAmbiguous = AMBIGUOUS_MARKERS.some((marker) =>
    compact.includes(marker),
  );
  const enAmbiguous = AMBIGUOUS_ENGLISH.some((marker) =>
    lowered.includes(marker),
  );
  if (zhAmbiguous || enAmbiguous) {
    const docIds = new Set(hits.map((h) => h.docId).filter((id) => id !== ""));
    if (docIds.size > 1 || (zhAmbiguous && compact.length <= 8)) {
      return { decision: "ask_clarification" };
    }
  }

  return { decision: "answer" };
}

const NO_EVIDENCE_ANSWER =
  "No relevant evidence was found in this repository's knowledge base. Upload documents first, or rephrase the question.";

const INSUFFICIENT_EVIDENCE_ANSWER =
  "The knowledge base does not have enough evidence to answer this question confidently: the key identifiers in your question do not appear in the retrieved passages. Please add the relevant documents, or rephrase the question more specifically.";

const ASK_CLARIFICATION_ANSWER =
  "The question is too vague to locate a specific subject. Please add the file or module, the error name, or the branch/version and try again.";

const CONFLICT_ANSWER =
  "The top-ranked evidence in this repository's knowledge base contradicts itself, so a confident answer is not possible. Please check the affected sources or versions first.";

// Evidence-grounded QA: retrieve scoped hits, gate them (refuse on missing
// evidence or ambiguity instead of fabricating), then generate an answer that
// cites them by number (same policy as the Python answer gate).
export async function askKnowledge(
  repoId: string,
  question: string,
  topK = 5,
): Promise<KnowledgeAnswer> {
  const hits = await searchKnowledge(repoId, question, topK);
  if (hits.length === 0) {
    return {
      answer: NO_EVIDENCE_ANSWER,
      citations: [],
      generationMode: "no_evidence",
    };
  }

  const gate = evaluateAnswerGate(question, hits);
  if (gate.decision === "insufficient_evidence") {
    return {
      answer: INSUFFICIENT_EVIDENCE_ANSWER,
      citations: [],
      generationMode: "no_evidence",
    };
  }
  if (gate.decision === "ask_clarification") {
    return {
      answer: ASK_CLARIFICATION_ANSWER,
      citations: [],
      generationMode: "no_evidence",
    };
  }
  if (gate.decision === "conflict") {
    return {
      answer: CONFLICT_ANSWER,
      citations: [],
      generationMode: "no_evidence",
    };
  }

  const evidence = hits
    .map((hit, i) => {
      const where = hit.sectionTitle
        ? `document: ${hit.docName} · ${hit.sectionTitle}, chunk ${hit.chunkIndex}`
        : `document: ${hit.docName}, chunk ${hit.chunkIndex}`;
      return `[${i + 1}] (${where})\n${hit.content}`;
    })
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
    generationMode: "llm",
  };
}

// ---------------------------------------------------------------------------
// Extractive fallback (port of qa.py:96-148 + the qa.py:197-202 degradation:
// when no LLM is configured — or the call fails — the answer is built by
// splicing the query's best-matching sentences out of the evidence, with the
// same numbered citations. Pure quoting, so it cannot fabricate; that is also
// why the answer gate is not re-applied here).
// ---------------------------------------------------------------------------

// Python _answer_terms (qa.py:96-104): ASCII words + CJK segments (whole
// segment when ≤3 chars, plus every 2-gram and 3-gram).
export function answerTerms(text: string): Set<string> {
  const lowered = text.toLowerCase();
  const terms = new Set<string>(lowered.match(/[a-z0-9_-]+/g) ?? []);
  for (const segment of lowered.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (segment.length <= 3) terms.add(segment);
    for (let i = 0; i + 1 < segment.length; i++)
      terms.add(segment.slice(i, i + 2));
    for (let i = 0; i + 2 < segment.length; i++)
      terms.add(segment.slice(i, i + 3));
  }
  for (const term of [...terms]) {
    if (term.trim() === "") terms.delete(term);
  }
  return terms;
}

export interface ExtractiveSource {
  title: string;
  snippet: string;
}

export interface ExtractiveSelection {
  answer: string;
  selected: Array<{ citation: number; sentence: string }>;
}

// Port of extractive_answer (qa.py:107-148): sentence-split each snippet,
// score by query-term overlap, prefer earlier sentences within a source and
// later sources on ties (legacy sorts the (overlap, -position, citation)
// tuples descending), drop near-identical sentences, keep at most 4.
export function buildExtractiveAnswer(
  question: string,
  sources: ExtractiveSource[],
): ExtractiveSelection {
  if (sources.length === 0) {
    return {
      answer:
        "The knowledge base did not retrieve enough evidence to answer this question. Upload the relevant documents first, or rephrase the question.",
      selected: [],
    };
  }
  const queryTerms = answerTerms(question);
  interface Candidate {
    overlap: number;
    position: number;
    citation: number;
    sentence: string;
  }
  const candidates: Candidate[] = [];
  sources.forEach((source, sourceIndex) => {
    const citation = sourceIndex + 1;
    const sentences = String(source.snippet ?? "").split(
      /(?<=[。！？.!?])\s+|\n+/,
    );
    sentences.forEach((sentence, position) => {
      let cleaned = sentence.trim().split(/\s+/).join(" ");
      cleaned = cleaned.replace(/(^|\s)#{1,6}\s*/g, "$1");
      cleaned = cleaned.replace(/^[-\s]+|[-\s]+$/g, "");
      if (cleaned.length < 8) return;
      let overlap = 0;
      for (const term of answerTerms(cleaned)) {
        if (queryTerms.has(term)) overlap++;
      }
      candidates.push({
        overlap,
        position,
        citation,
        sentence: cleaned.slice(0, 420),
      });
    });
  });

  candidates.sort(
    (a, b) =>
      b.overlap - a.overlap ||
      a.position - b.position ||
      b.citation - a.citation ||
      b.sentence.localeCompare(a.sentence),
  );

  const bestOverlap = candidates.length > 0 ? candidates[0].overlap : 0;
  const minimumOverlap = Math.max(1, Math.round(bestOverlap * 0.6));
  const selected: Array<{ citation: number; sentence: string }> = [];
  const seen = new Set<string>();
  const usedCitations = new Set<number>();
  for (const candidate of candidates) {
    if (bestOverlap > 0 && candidate.overlap < minimumOverlap) continue;
    const fingerprint = candidate.sentence.replace(/\s+/g, "").toLowerCase();
    if (seen.has(fingerprint)) continue;
    if (usedCitations.has(candidate.citation) && selected.length >= 2) continue;
    selected.push({
      citation: candidate.citation,
      sentence: candidate.sentence,
    });
    seen.add(fingerprint);
    usedCitations.add(candidate.citation);
    if (selected.length === 4) break;
  }

  if (selected.length === 0) {
    // Legacy fallback: quote the first source verbatim.
    const first = sources[0];
    selected.push({
      citation: 1,
      sentence: first.snippet.trim() !== "" ? first.snippet : first.title,
    });
  }

  const bullets = selected
    .map((s) => `- ${s.sentence} [${s.citation}]`)
    .join("\n");
  return {
    answer: `Based on the evidence retrieved from the knowledge base:\n\n${bullets}`,
    selected,
  };
}

export async function askKnowledgeExtractive(
  repoId: string,
  question: string,
  topK = 5,
): Promise<KnowledgeAnswer> {
  const hits = await searchKnowledge(repoId, question, topK);
  if (hits.length === 0) {
    return {
      answer: NO_EVIDENCE_ANSWER,
      citations: [],
      generationMode: "no_evidence",
    };
  }
  const { answer } = buildExtractiveAnswer(
    question,
    hits.map((hit) => ({ title: hit.docName, snippet: hit.content })),
  );
  return {
    answer,
    citations: hits.map((hit, i) => ({
      index: i + 1,
      docName: hit.docName,
      snippet: hit.content.slice(0, 200),
      score: hit.score,
    })),
    generationMode: "extractive",
  };
}

// ---------------------------------------------------------------------------
// Document-level surfaces from the legacy RAG studio (routes/rag.py) that the
// per-repo KB page needs on top of list/upload/delete:
//   - chunk preview   GET  documents/{document_id}/chunks
//   - retry failed    POST documents/{document_id}/retry  (content re-index)
//   - memory note     POST /knowledge/notes
//   - rag status      GET  /knowledge/status
// ---------------------------------------------------------------------------

export interface KnowledgeChunkView {
  id: string;
  position: number;
  title: string;
  content: string;
  characterCount: number;
}

// Chunk preview — port of routes/rag.py:237-258 list_document_chunks. Chunks
// live in Milvus (PostgreSQL keeps only document metadata in this stack), so
// the preview reads the exact indexed rows for the document via a scalar
// source filter instead of the legacy SQL Document rows. Ordered by
// chunk_index; `position` is 1-based like the legacy response.
export async function listDocumentChunks(
  repoId: string,
  docId: string,
): Promise<KnowledgeChunkView[]> {
  const rows = await queryByFilter(
    `source == ${quote(kbSource(repoId, docId))}`,
    10_000,
  );
  const parsed = rows.map((row) => {
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(row.metadata || "{}") as Record<string, unknown>;
    } catch {
      meta = {};
    }
    return {
      id: row.id,
      chunkIndex: Number(meta.chunk_index ?? 0),
      title:
        typeof meta.section_title === "string" && meta.section_title !== ""
          ? meta.section_title
          : String(meta.doc_name ?? ""),
      content: row.content,
    };
  });
  parsed.sort((a, b) => a.chunkIndex - b.chunkIndex);
  return parsed.map((row, i) => ({
    id: row.id,
    position: i + 1,
    title: row.title,
    content: row.content,
    characterCount: row.content.length,
  }));
}

// Memory note — port of routes/knowledge.py:234-256 create_memory_note:
// a user-authored note lands directly in the repo KB as a `memory_note`
// document (the candidate-approval path in memory.ts uses the same
// source_type). Title or content must be non-empty.
export async function addMemoryNote(input: {
  repoId: string;
  title: string;
  content: string;
}): Promise<AddDocumentResult> {
  const title = input.title.trim();
  const content = input.content.trim();
  if (title === "" && content === "") {
    throw new Error("Memory note title or content must be provided.");
  }
  const name = title !== "" ? title : "Untitled memory";
  const chunkConfig = await getKnowledgeConfig(input.repoId);
  return addKnowledgeDocument({
    repoId: input.repoId,
    name,
    content: content !== "" ? content : title,
    sourceType: "memory_note",
    chunkSize: chunkConfig.chunkSize,
    chunkOverlap: chunkConfig.chunkOverlap,
  });
}

export interface RagStatusView {
  repoId: string;
  documentCount: number;
  chunkCount: number;
  sourceTypes: Record<string, number>;
  embedding: { provider: string; model: string };
  generation: { llmConfigured: boolean; fallback: string };
  supportedFiles: string[];
}

// RAG status — port of qa.py:278-309 rag_status reduced to what this stack
// can honestly report: per-source-type document counts + the total indexed
// chunk count from Milvus, the configured embedding provider/model, and the
// generation mode (LLM vs extractive fallback). The legacy vector-store
// runtime probe is replaced by the readiness endpoint (GET /api/ready).
export async function ragStatus(repoId: string): Promise<RagStatusView> {
  const docs = await prisma.knowledgeDocument.findMany({
    where: { repoId },
    select: { sourceType: true, chunkCount: true },
  });
  const sourceTypes: Record<string, number> = {};
  let chunkCount = 0;
  for (const doc of docs) {
    sourceTypes[doc.sourceType] = (sourceTypes[doc.sourceType] ?? 0) + 1;
    chunkCount += doc.chunkCount;
  }
  // Live chunk total actually present in Milvus for this repo's KB (may lag
  // the metadata counts if an index was swept out of band).
  let milvusChunks = 0;
  try {
    milvusChunks = await count(kbFilter(repoId));
  } catch {
    milvusChunks = chunkCount;
  }
  return {
    repoId,
    documentCount: docs.length,
    chunkCount: milvusChunks,
    sourceTypes,
    embedding: {
      provider: config.embeddingProvider,
      model: config.openaiEmbedding.model,
    },
    generation: {
      llmConfigured:
        config.provider === "anthropic"
          ? Boolean(config.anthropic.quick.apiKey)
          : Boolean(config.openai.quick.apiKey),
      fallback: "extractive evidence answer",
    },
    supportedFiles: [
      ".txt",
      ".md",
      ".markdown",
      ".pdf",
      ".docx",
      ".json",
      ".csv",
      ".log",
    ],
  };
}
