// Retrieval post-processing for the shared Milvus collection — port of the
// Python retrieval pipeline stages (Yukino.md #32): fingerprint + Jaccard
// near-duplicate removal, per-parent
// chunk cap, sibling (parent-context) expansion, and the DevFlow heuristic
// reranker (services/rag/rerank.py) used when no rerank API is configured or
// the API fails.
//
// All stages are pure in-process operations on RetrievedDoc values; the
// structure-aware chunker (lib/devflow/chunking.ts) is what stamps the
// parent_id / child_index / sibling_ids metadata they read.
import { createHash } from "node:crypto";
import type { RetrievedDoc } from "@/lib/milvus/retriever";
import { getByIds } from "@/lib/milvus/client";

// Legacy constants (DevFlow-AI services/rag/retrieval.py:22-24,
// rag/rerank.py:114).
export const NEAR_DUPLICATE_JACCARD = 0.9;
export const MAX_CHUNKS_PER_PARENT = 2;
const RERANK_TOP_N = 24;

// --- Tokenization (shared by dedup + heuristic rerank) ----------------------

// Python _tokens: ASCII word tokens + CJK unigrams and adjacent bigrams.
export function tokenize(text: string): string[] {
  const lowered = text.toLowerCase();
  const tokens: string[] = lowered.match(/[a-z0-9_-]+/g) ?? [];
  for (const segment of lowered.match(/[一-鿿]+/g) ?? []) {
    for (const char of segment) tokens.push(char);
    for (let i = 0; i + 1 < segment.length; i++)
      tokens.push(segment.slice(i, i + 2));
  }
  return tokens;
}

// Python _normalised_fingerprint: strip everything outside
// [a-z0-9_-\u4e00-\u9fff], then sha256.
export function fingerprint(text: string): string {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9_\-\u4e00-\u9fff]+/g, "");
  if (normalized === "") return "";
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return intersection / Math.max(union, 1);
}

// --- Scope / parent keys ----------------------------------------------------

function scopeKey(doc: RetrievedDoc): string {
  const docId = String(doc.metadata.doc_id ?? "");
  const parentId = String(doc.metadata.parent_id ?? "");
  if (parentId) return parentId;
  if (docId) return docId;
  return doc.source;
}

function sameScope(left: RetrievedDoc, right: RetrievedDoc): boolean {
  return scopeKey(left) === scopeKey(right);
}

// --- Dedup + parent cap ------------------------------------------------------

// Fingerprint-exact and Jaccard>=0.9 near-duplicates inside the same scope
// (parent, document, or source tag) are dropped, keeping the higher-ranked
// candidate. Mirrors _deduplicate_candidates.
export function dedupeNearDuplicates(docs: RetrievedDoc[]): RetrievedDoc[] {
  const kept: RetrievedDoc[] = [];
  const fingerprints = new Map<string, RetrievedDoc>();
  const termSets = new Map<string, Set<string>>();
  for (const doc of docs) {
    const fp = fingerprint(doc.content);
    let duplicate = fp !== "" ? (fingerprints.get(fp) ?? null) : null;
    if (duplicate && !sameScope(doc, duplicate)) duplicate = null;
    if (!duplicate) {
      const currentTerms = new Set(tokenize(doc.content));
      for (const existing of kept) {
        if (!sameScope(doc, existing)) continue;
        const existingTerms =
          termSets.get(existing.id) ?? new Set(tokenize(existing.content));
        if (currentTerms.size === 0 || existingTerms.size === 0) continue;
        if (jaccard(currentTerms, existingTerms) >= NEAR_DUPLICATE_JACCARD) {
          duplicate = existing;
          break;
        }
      }
      termSets.set(doc.id, currentTerms);
    }
    if (duplicate) continue;
    kept.push(doc);
    if (fp !== "") fingerprints.set(fp, doc);
  }
  return kept;
}

// At most MAX_CHUNKS_PER_PARENT chunks per parent section survive a pass —
// mirrors _limit_parent_occupancy (chunks without a parent_id are untouched).
export function limitPerParent(docs: RetrievedDoc[]): RetrievedDoc[] {
  const counts = new Map<string, number>();
  const kept: RetrievedDoc[] = [];
  for (const doc of docs) {
    const parentId = String(doc.metadata.parent_id ?? "");
    if (parentId !== "" && (counts.get(parentId) ?? 0) >= MAX_CHUNKS_PER_PARENT)
      continue;
    kept.push(doc);
    if (parentId !== "") counts.set(parentId, (counts.get(parentId) ?? 0) + 1);
  }
  return kept;
}

// --- Heuristic rerank (DevFlow-AI services/rag/rerank.py) -------------------

function clip01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function normalizeScores(docs: RetrievedDoc[]): number[] {
  // Python _normalise_scores: min-max across the candidate list.
  if (docs.length === 0) return [];
  let min = Infinity;
  let max = -Infinity;
  for (const doc of docs) {
    if (doc.score < min) min = doc.score;
    if (doc.score > max) max = doc.score;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max - min < 1e-12) {
    return docs.map(() => (Number.isFinite(max) && max > 0 ? 1 : 0));
  }
  return docs.map((doc) => (doc.score - min) / (max - min));
}

// Candidate text = title + path + content (Python _candidate_text uses
// title/path/snippet; here doc_name or path stand in for title/path).
function candidateFields(doc: RetrievedDoc): {
  title: string;
  path: string;
  text: string;
} {
  const title = String(
    doc.metadata.doc_name ?? doc.metadata.display_title ?? "",
  );
  const path = String(doc.metadata.path ?? "");
  const section = Array.isArray(doc.metadata.section_path)
    ? (doc.metadata.section_path as unknown[]).join(" › ")
    : "";
  const text = [title, path, section, doc.content].join("\n").toLowerCase();
  return { title: title.toLowerCase(), path: path.toLowerCase(), text };
}

export interface HeuristicRanked {
  doc: RetrievedDoc;
  rerankScore: number;
  rankReason: string;
}

// Port of _heuristic_score. The Python weights assume separate vector/keyword
// scores from the weighted fusion pipeline; Milvus returns a single fused
// (RRF rank) score, which carries far less information than a calibrated
// relevance score — so the vector/keyword weights are folded into the
// content-coverage component (0.20+0.16 → coverage 0.33) and only the 0.31
// `base` term keeps the normalized fusion order as a tie-breaker. Everything
// else (coverage math, title/path hits, phrase 0.12, source 0.08, dual-recall
// 0.05, freshness, source-type 0.03, rank_reason) is ported 1:1.
export function heuristicScore(
  query: string,
  doc: RetrievedDoc,
  normalizedScore: number,
): { score: number; reason: string } {
  const terms = tokenize(query);
  const { title, path, text } = candidateFields(doc);
  const uniqueTerms = new Set(terms);
  if (uniqueTerms.size === 0) {
    return { score: clip01(doc.score), reason: "base score only" };
  }
  let matchedCount = 0;
  const matched = new Set<string>();
  for (const term of uniqueTerms) {
    if (text.includes(term)) {
      matchedCount++;
      matched.add(term);
    }
  }
  const coverage = matchedCount / uniqueTerms.size;
  let titleHits = 0;
  let pathHits = 0;
  for (const term of terms) {
    if (title.includes(term)) titleHits++;
    if (path.includes(term)) pathHits++;
  }
  const compactQuery = query.toLowerCase().trim();
  const phraseBonus =
    compactQuery !== "" && text.includes(compactQuery) ? 0.12 : 0;
  const sourceBonus = new Set(matched).size >= 2 ? 0.08 : 0;
  const base = clip01(normalizedScore);
  const dualRecallBonus = 0.05; // fused candidates are dual-recall by construction
  const freshnessBonus = freshness(doc);
  const sourceType = String(doc.metadata.source_type ?? "").toLowerCase();
  const sourceTypeBonus =
    sourceType !== "" && terms.some((term) => sourceType.includes(term))
      ? 0.03
      : 0;

  const score = clip01(
    0.31 * base +
      0.33 * coverage +
      (0.04 * Math.min(titleHits, 3)) / 3 +
      (0.02 * Math.min(pathHits, 3)) / 3 +
      phraseBonus +
      sourceBonus +
      dualRecallBonus +
      freshnessBonus +
      sourceTypeBonus,
  );
  const reasons: string[] = [];
  if (coverage > 0)
    reasons.push(`matched ${matchedCount}/${uniqueTerms.size} query terms`);
  if (titleHits > 0) reasons.push("title match");
  if (pathHits > 0) reasons.push("path match");
  reasons.push("fused candidate");
  if (dualRecallBonus > 0) reasons.push("dual recall");
  if (freshnessBonus > 0) reasons.push("fresh evidence");
  if (sourceTypeBonus > 0) reasons.push("source type match");
  return { score, reason: reasons.join(", ") };
}

function freshness(doc: RetrievedDoc): number {
  for (const key of ["updated_at", "created_at", "merged_at", "closed_at"]) {
    const value = doc.metadata[key];
    if (value === undefined || value === null || value === "") continue;
    const parsed = Date.parse(String(value));
    if (Number.isNaN(parsed)) continue;
    const ageDays = Math.max(0, (Date.now() - parsed) / 86_400_000);
    if (ageDays <= 30) return 0.04;
    if (ageDays <= 180) return 0.02;
    return 0;
  }
  return 0;
}

// Port of rerank_documents: rerank the head (top RERANK_TOP_N or limit), keep
// the tail in fusion order, cut to limit. Returns docs with score replaced by
// the heuristic score; rank_reason is stamped into a side map the callers can
// surface.
export function heuristicRerank(
  query: string,
  docs: RetrievedDoc[],
  limit: number,
): { ranked: RetrievedDoc[]; reasons: Map<string, string> } {
  if (docs.length === 0) return { ranked: [], reasons: new Map() };
  const normalized = normalizeScores(docs);
  const topN = Math.min(Math.max(RERANK_TOP_N, limit), docs.length);
  const head = docs.slice(0, topN);
  const tail = docs.slice(topN);
  const reasons = new Map<string, string>();
  const scored = head.map((doc, i) => {
    const { score, reason } = heuristicScore(query, doc, normalized[i] ?? 0);
    reasons.set(doc.id, reason);
    return { doc, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const rankedHead = scored.map(({ doc, score }) => ({
    ...doc,
    score: Number(score.toFixed(4)),
  }));
  return { ranked: [...rankedHead, ...tail].slice(0, limit), reasons };
}

// --- Sibling expansion -------------------------------------------------------

// Port of expand_parent_context (neighbor_window=1). The chunker stamps each
// indexed chunk with its parent's neighboring chunk ids in child order
// (metadata.sibling_ids = [prevId | "", currentId, nextId | ""]); a hit is
// replaced by the concatenation of itself + its immediate siblings, ordered
// and deduped by fingerprint. Best-effort: fetch failures leave hits untouched.
export async function expandSiblings(
  docs: RetrievedDoc[],
): Promise<RetrievedDoc[]> {
  const need = new Set<string>();
  for (const doc of docs) {
    const siblings = doc.metadata.sibling_ids;
    if (!Array.isArray(siblings)) continue;
    for (const id of siblings) {
      if (typeof id === "string" && id !== "" && id !== doc.id) need.add(id);
    }
  }
  if (need.size === 0) return docs;
  let contentById: Map<string, string>;
  try {
    const hits = await getByIds([...need]);
    contentById = new Map(hits.map((hit) => [hit.id, hit.content]));
  } catch (e) {
    console.warn(
      "[retrieval-post] sibling fetch failed:",
      e instanceof Error ? e.message : e,
    );
    return docs;
  }
  const expanded: RetrievedDoc[] = [];
  for (const doc of docs) {
    const ids = doc.metadata.sibling_ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      expanded.push(doc);
      continue;
    }
    const parts: string[] = [];
    const seen = new Set<string>();
    const fetchedIds: string[] = [];
    for (const id of ids) {
      if (typeof id !== "string" || id === "") continue;
      const isCurrent = id === doc.id;
      const content = isCurrent ? doc.content : contentById.get(id);
      if (!content) continue;
      const fp = fingerprint(content);
      const dedupeKey = fp !== "" ? fp : content;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      parts.push(content);
      if (!isCurrent) fetchedIds.push(id);
    }
    if (fetchedIds.length === 0 || parts.length === 0) {
      expanded.push(doc);
      continue;
    }
    expanded.push({
      ...doc,
      content: parts.join("\n\n"),
      metadata: { ...doc.metadata, expanded_chunk_ids: fetchedIds },
    });
  }
  return expanded;
}
