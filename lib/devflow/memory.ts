// DevFlow memory system (#25) — port of the DevFlow-AI memory layer:
//  - services/chat_memory.py SessionSealer.seal / _build_memory_update /
//    _update_thread_memory: conversation sealing → ConversationMemory upsert
//    with the sessions_incorporated counter, model snapshot folded into the
//    existing memory (never replacing it);
//  - services/context_compression.py fallback_memory_update / merge_memory /
//    structured_memory_from_model / render_structured_memory /
//    clip_to_token_budget / _unique_preserve_order: deterministic extraction,
//    incremental list merge with caps, prompt rendering, token budgets;
//  - services/memory_hub.py capture_memory_candidates / list_memory_candidates /
//    approve_memory_candidate / reject_memory_candidate: human-review pipeline
//    where an approved candidate becomes a `memory_note` knowledge document.
// Legacy updated ThreadMemory per turn for repo-global chats; this port merges
// ConversationMemory rows into the per-repo ThreadMemory explicitly
// (mergeThreadMemory) keeping the same counter semantics.
//
// No-LLM degradation: every model call is optional. Without an API key (or on
// any model/schema failure) the deterministic fallback snapshot is used, so
// sealing never throws and never discards accumulated memory.
import { generateText, Output } from "ai";
import { z } from "zod/v4";
import { config } from "@/lib/config";
import { prisma } from "@/lib/db";
import { quickModel, providerOptions } from "@/lib/ai/models";
import { observeGeneration } from "@/lib/observability";
import { addKnowledgeDocument } from "@/lib/devflow/rag";
import { Prisma, type MemoryCandidate } from "@/generated/prisma/client";

// Prisma's InputJsonValue rejects `unknown` leaves; the persisted payloads are
// already JSON-serializable, so assert once at the boundary (same convention
// as lib/devflow/conversations.ts).
const asJson = (value: unknown): Prisma.InputJsonValue =>
  value as Prisma.InputJsonValue;

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// ---------------------------------------------------------------------------
// Snapshot shape + token budgets (context_compression.py)
// ---------------------------------------------------------------------------

// Lenient parse schema for model output and stored rows: every list optional
// (legacy structured_memory_from_model coerced missing keys to []). Normalized
// through normalizeSnapshot before use — all LLM output passes zod safeParse.
export const MemorySnapshotSchema = z.object({
  summary: z.string().optional(),
  facts: z.array(z.string()).optional(),
  decisions: z.array(z.string()).optional(),
  openQuestions: z.array(z.string()).optional(),
  tasks: z.array(z.string()).optional(),
  userPreferences: z.array(z.string()).optional(),
  repoContext: z.array(z.string()).optional(),
});

export interface MemorySnapshot {
  summary: string;
  facts: string[];
  decisions: string[];
  openQuestions: string[];
  tasks: string[];
  userPreferences: string[];
  repoContext: string[];
}

export type MemoryGenerationMode = "llm" | "deterministic";

// Legacy merge_memory caps per list.
export const MEMORY_LIST_LIMITS = {
  facts: 16,
  decisions: 16,
  openQuestions: 12,
  tasks: 16,
  userPreferences: 12,
  repoContext: 16,
} as const;

// Legacy _update_thread_memory: clip_to_token_budget(summary, 1100).
export const SUMMARY_TOKEN_BUDGET = 1100;
// Messages fed to the sealing model (transcript tail, oldest dropped).
export const SEAL_TRANSCRIPT_LIMIT = 120;
// Per-message clip inside the model transcript.
export const SEAL_TRANSCRIPT_MESSAGE_CHARS = 500;
// fallback_snapshot: "最近 N 条消息的 role:content 截断" (spec) — legacy
// fallback_memory_update clipped user/assistant content to 90/140 tokens.
export const FALLBACK_RECENT_MESSAGES = 12;
export const FALLBACK_MESSAGE_CHARS = 160;

// Legacy context_compression.TOKEN_PATTERN + estimate_tokens: CJK chars count
// as 1 token, alphanumeric words as ceil(len/4), any other non-space char as 1.
const TOKEN_PATTERN = /[\u4e00-\u9fff]|[a-zA-Z0-9_-]+|[^\s]/g;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let total = 0;
  for (const token of text.match(TOKEN_PATTERN) ?? []) {
    if (/^[\u4e00-\u9fff]$/.test(token)) total += 1;
    else if (/^[a-zA-Z0-9_-]+$/.test(token)) {
      total += Math.max(1, Math.ceil(token.length / 4));
    } else total += 1;
  }
  return total;
}

// Port of context_compression.clip_to_token_budget.
export function clipToTokenBudget(
  text: string,
  maxTokens: number,
  suffix = "...",
): string {
  const clean = (text ?? "").trim();
  if (maxTokens <= 0 || !clean) return "";
  if (estimateTokens(clean) <= maxTokens) return clean;
  const approxChars = Math.max(32, maxTokens * 4);
  let clipped = clean.slice(0, approxChars).trimEnd();
  while (clipped && estimateTokens(clipped + suffix) > maxTokens) {
    clipped = clipped.slice(0, Math.max(0, clipped.length - 24)).trimEnd();
  }
  return clipped ? `${clipped}${suffix}` : "";
}

// Port of context_compression._unique_preserve_order: whitespace-collapsed,
// case-insensitive dedupe keeping insertion order, cut at `limit` (first N).
export function uniquePreserveOrder(
  items: readonly string[],
  limit: number,
): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of items) {
    const clean = String(item ?? "")
      .trim()
      .split(/\s+/)
      .join(" ");
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(clean);
    if (output.length >= limit) break;
  }
  return output;
}

// Legacy memory_hub._clip: collapse whitespace then clip with "...".
export function clipInline(text: string, limit: number): string {
  const cleaned = String(text ?? "")
    .split(/\s+/)
    .join(" ")
    .trim();
  return cleaned.length <= limit
    ? cleaned
    : `${cleaned.slice(0, Math.max(0, limit - 1)).trimEnd()}...`;
}

export function emptySnapshot(): MemorySnapshot {
  return {
    summary: "",
    facts: [],
    decisions: [],
    openQuestions: [],
    tasks: [],
    userPreferences: [],
    repoContext: [],
  };
}

// Port of structured_memory_from_model: normalize + cap a parsed snapshot.
export function normalizeSnapshot(
  raw: z.infer<typeof MemorySnapshotSchema> | null | undefined,
): MemorySnapshot {
  return {
    summary: clipToTokenBudget(raw?.summary ?? "", SUMMARY_TOKEN_BUDGET),
    facts: uniquePreserveOrder(raw?.facts ?? [], MEMORY_LIST_LIMITS.facts),
    decisions: uniquePreserveOrder(
      raw?.decisions ?? [],
      MEMORY_LIST_LIMITS.decisions,
    ),
    openQuestions: uniquePreserveOrder(
      raw?.openQuestions ?? [],
      MEMORY_LIST_LIMITS.openQuestions,
    ),
    tasks: uniquePreserveOrder(raw?.tasks ?? [], MEMORY_LIST_LIMITS.tasks),
    userPreferences: uniquePreserveOrder(
      raw?.userPreferences ?? [],
      MEMORY_LIST_LIMITS.userPreferences,
    ),
    repoContext: uniquePreserveOrder(
      raw?.repoContext ?? [],
      MEMORY_LIST_LIMITS.repoContext,
    ),
  };
}

function jsonToStringArray(value: unknown): string[] {
  const parsed = z.array(z.string()).safeParse(value);
  return parsed.success ? parsed.data : [];
}

interface MemoryRowShape {
  summary: string;
  facts: Prisma.JsonValue;
  decisions: Prisma.JsonValue;
  openQuestions: Prisma.JsonValue;
  tasks: Prisma.JsonValue;
  userPreferences: Prisma.JsonValue;
  repoContext: Prisma.JsonValue;
  sessionsIncorporated: number;
  updatedAt: Date;
}

function memoryRowToSnapshot(row: MemoryRowShape): MemorySnapshot {
  return normalizeSnapshot({
    summary: row.summary,
    facts: jsonToStringArray(row.facts),
    decisions: jsonToStringArray(row.decisions),
    openQuestions: jsonToStringArray(row.openQuestions),
    tasks: jsonToStringArray(row.tasks),
    userPreferences: jsonToStringArray(row.userPreferences),
    repoContext: jsonToStringArray(row.repoContext),
  });
}

function snapshotToData(snapshot: MemorySnapshot) {
  return {
    summary: snapshot.summary,
    facts: asJson(snapshot.facts),
    decisions: asJson(snapshot.decisions),
    openQuestions: asJson(snapshot.openQuestions),
    tasks: asJson(snapshot.tasks),
    userPreferences: asJson(snapshot.userPreferences),
    repoContext: asJson(snapshot.repoContext),
  };
}

// Port of context_compression.merge_memory: summaries concatenate under the
// token budget; lists merge order-preserving with the legacy caps.
export function mergeSnapshots(
  existing: MemorySnapshot,
  update: MemorySnapshot,
): MemorySnapshot {
  const summaryParts = [existing.summary.trim(), update.summary.trim()].filter(
    Boolean,
  );
  return {
    summary: clipToTokenBudget(summaryParts.join("\n\n"), SUMMARY_TOKEN_BUDGET),
    facts: uniquePreserveOrder(
      [...existing.facts, ...update.facts],
      MEMORY_LIST_LIMITS.facts,
    ),
    decisions: uniquePreserveOrder(
      [...existing.decisions, ...update.decisions],
      MEMORY_LIST_LIMITS.decisions,
    ),
    openQuestions: uniquePreserveOrder(
      [...existing.openQuestions, ...update.openQuestions],
      MEMORY_LIST_LIMITS.openQuestions,
    ),
    tasks: uniquePreserveOrder(
      [...existing.tasks, ...update.tasks],
      MEMORY_LIST_LIMITS.tasks,
    ),
    userPreferences: uniquePreserveOrder(
      [...existing.userPreferences, ...update.userPreferences],
      MEMORY_LIST_LIMITS.userPreferences,
    ),
    repoContext: uniquePreserveOrder(
      [...existing.repoContext, ...update.repoContext],
      MEMORY_LIST_LIMITS.repoContext,
    ),
  };
}

// ---------------------------------------------------------------------------
// Deterministic fallback extraction (context_compression.fallback_memory_update)
// ---------------------------------------------------------------------------

export interface TranscriptMessage {
  role: string;
  content: string;
  toolNames?: string[];
}

// Deterministic no-LLM snapshot: the summary is the recent-message
// "role: content" concatenation (each message clipped), and the list fields
// come from the legacy keyword buckets of fallback_memory_update (questions,
// decision/task/preference markers, long lines as facts).
export function fallbackSnapshot(
  messages: readonly TranscriptMessage[],
): MemorySnapshot {
  const recent = messages.slice(-FALLBACK_RECENT_MESSAGES);
  const summaryLines = recent.map((message) => {
    const body = clipInline(message.content, FALLBACK_MESSAGE_CHARS);
    const tools =
      message.toolNames && message.toolNames.length > 0
        ? ` [tools: ${message.toolNames.join(", ")}]`
        : "";
    return `${message.role}: ${body}${tools}`;
  });

  const decisions: string[] = [];
  const openQuestions: string[] = [];
  const tasks: string[] = [];
  const facts: string[] = [];
  const userPreferences: string[] = [];
  const DECISION_TOKENS = [
    "decide",
    "decision",
    "agreed",
    "chosen",
    "确定",
    "决定",
  ];
  const TASK_TOKENS = [
    "todo",
    "next step",
    "action",
    "fix",
    "implement",
    "待办",
    "下一步",
  ];
  const PREFERENCE_TOKENS = ["prefer", "preference", "喜欢", "偏好"];
  for (const message of messages) {
    for (const rawLine of message.content.split("\n")) {
      const line = rawLine.trim().replace(/^[-*\t ]+/, "");
      if (!line) continue;
      const lower = line.toLowerCase();
      if (
        line.includes("?") ||
        line.includes("？") ||
        /^(why|how|what)\b/.test(lower)
      ) {
        openQuestions.push(line);
      }
      if (DECISION_TOKENS.some((token) => lower.includes(token))) {
        decisions.push(line);
      }
      if (TASK_TOKENS.some((token) => lower.includes(token))) {
        tasks.push(line);
      }
      if (PREFERENCE_TOKENS.some((token) => lower.includes(token))) {
        userPreferences.push(line);
      }
      if (line.length > 20) facts.push(line);
    }
  }
  return normalizeSnapshot({
    summary: summaryLines.join("\n"),
    facts,
    decisions,
    openQuestions,
    tasks,
    userPreferences,
    repoContext: [],
  });
}

// ---------------------------------------------------------------------------
// Optional LLM snapshot extraction
// ---------------------------------------------------------------------------

// Same key check as agents/analysis.llmConfigured, against the quick model
// this module calls (kept local so lib/devflow/memory.ts does not import the
// agents layer). No key → deterministic path only, never a thrown
// LoadAPIKeyError.
export function memoryLlmConfigured(): boolean {
  return config.provider === "anthropic"
    ? Boolean(config.anthropic.quick.apiKey)
    : Boolean(config.openai.quick.apiKey);
}

// Legacy SessionSealer._build_memory_update prompt: return the UPDATED
// COMPLETE snapshot, keep important artifacts, never invent facts.
const SEAL_MEMORY_SYSTEM = `You maintain the long-term memory of a software-engineering agent for one repository conversation.
Given the existing memory snapshot and the conversation transcript, return the UPDATED COMPLETE snapshot (not a diff).
Keep important files, functions, commands, error fixes and user corrections; drop open questions and tasks the transcript shows as resolved; the summary must describe the current working state and the next step. Never invent facts the transcript does not support.`;

// Thread-level consolidation prompt (legacy used the same snapshot contract
// with _update_mode "snapshot" in SessionSealer._update_thread_memory).
const MERGE_MEMORY_SYSTEM = `You consolidate the per-conversation memories of one repository into a single repository-level thread memory.
Given the current thread snapshot, the conversation snapshots and their deterministic merge, return the consolidated COMPLETE snapshot.
Prefer recent, still-relevant items; fold duplicates; the summary must describe the overall repository working state. Never invent facts.`;

async function generateSnapshot(
  name: string,
  system: string,
  payload: Record<string, unknown>,
): Promise<MemorySnapshot | null> {
  try {
    const prompt = JSON.stringify(payload, null, 2);
    const result = await observeGeneration(name, async (generation) => {
      const res = await generateText({
        model: quickModel,
        system,
        prompt,
        output: Output.object({ schema: MemorySnapshotSchema }),
        providerOptions,
      });
      generation?.update({ input: prompt, output: res.text });
      return res;
    });
    // AGENTS.md quality bar: every LLM payload passes zod safeParse before
    // use; anything invalid degrades to the deterministic snapshot.
    const parsed = MemorySnapshotSchema.safeParse(result.output ?? null);
    if (!parsed.success) return null;
    return normalizeSnapshot(parsed.data);
  } catch {
    return null;
  }
}

function transcriptForPrompt(messages: readonly TranscriptMessage[]): string {
  return messages
    .map((message) => {
      const tools =
        message.toolNames && message.toolNames.length > 0
          ? ` [tools: ${message.toolNames.join(", ")}]`
          : "";
      return `${message.role}${tools}: ${clipInline(message.content, SEAL_TRANSCRIPT_MESSAGE_CHARS)}`;
    })
    .join("\n");
}

function toolNamesOf(toolCalls: unknown): string[] {
  const parsed = z.array(z.object({ name: z.string() })).safeParse(toolCalls);
  return parsed.success ? parsed.data.map((entry) => entry.name) : [];
}

// ---------------------------------------------------------------------------
// Sealing (chat_memory.py SessionSealer)
// ---------------------------------------------------------------------------

export interface SealResult {
  conversationId: string;
  repoId: string;
  generationMode: MemoryGenerationMode;
  snapshot: MemorySnapshot;
  sessionsIncorporated: number;
  candidatesCreated: number;
}

// Seal a conversation: fold its transcript into the ConversationMemory row
// (sessionsIncorporated + 1) and capture pending review candidates from the
// update's list items (legacy capture_memory_candidates with source
// "session_sealer"). Returns null when the conversation is missing or empty.
export async function sealConversation(
  conversationId: string,
): Promise<SealResult | null> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
  });
  if (!conversation) return null;

  const rows = await prisma.chatMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: SEAL_TRANSCRIPT_LIMIT,
    select: { role: true, content: true, toolCalls: true },
  });
  if (rows.length === 0) return null;
  const messages: TranscriptMessage[] = rows.reverse().map((row) => ({
    role: row.role,
    content: row.content,
    toolNames: toolNamesOf(row.toolCalls),
  }));

  const existing = await prisma.conversationMemory.findUnique({
    where: { conversationId },
  });
  const existingSnapshot = existing
    ? memoryRowToSnapshot(existing)
    : emptySnapshot();

  // Legacy SessionSealer.seal: the deterministic fallback is computed first
  // and only replaced when the model returns a schema-valid snapshot.
  const fallback = fallbackSnapshot(messages);
  let update = fallback;
  let generationMode: MemoryGenerationMode = "deterministic";
  if (memoryLlmConfigured()) {
    const llmSnapshot = await generateSnapshot(
      "devflow-memory-seal",
      SEAL_MEMORY_SYSTEM,
      {
        existing_memory: existingSnapshot,
        conversation_title: conversation.title,
        transcript: transcriptForPrompt(messages),
      },
    );
    if (llmSnapshot) {
      update = llmSnapshot;
      generationMode = "llm";
    }
  }

  // Legacy _update_thread_memory merge path: the update folds into the
  // existing snapshot, so a degraded seal never discards accumulated memory.
  const merged = mergeSnapshots(existingSnapshot, update);
  const sessionsIncorporated = (existing?.sessionsIncorporated ?? 0) + 1;
  await prisma.conversationMemory.upsert({
    where: { conversationId },
    create: {
      repoId: conversation.repoId,
      conversationId,
      ...snapshotToData(merged),
      sessionsIncorporated,
    },
    update: { ...snapshotToData(merged), sessionsIncorporated },
  });

  const candidatesCreated = await captureCandidatesFromSnapshot(
    conversation.repoId,
    conversationId,
    update,
    "session_sealer",
  );
  return {
    conversationId,
    repoId: conversation.repoId,
    generationMode,
    snapshot: merged,
    sessionsIncorporated,
    candidatesCreated,
  };
}

// Legacy sealed every turn; this port seals once enough NEW messages have
// accumulated since the last seal (spec: ≥ 8). "New" = created after the
// ConversationMemory row's updatedAt (all messages when never sealed).
export const SEAL_MESSAGE_THRESHOLD = 8;

export function shouldSeal(
  newMessageCount: number,
  threshold: number = SEAL_MESSAGE_THRESHOLD,
): boolean {
  return newMessageCount >= threshold;
}

export async function newMessagesSinceSeal(
  conversationId: string,
): Promise<number> {
  const memory = await prisma.conversationMemory.findUnique({
    where: { conversationId },
    select: { updatedAt: true },
  });
  return prisma.chatMessage.count({
    where: {
      conversationId,
      ...(memory ? { createdAt: { gt: memory.updatedAt } } : {}),
    },
  });
}

// Fire-and-forget hook for the chat agent: seal + merge when the threshold is
// reached. Any failure is the caller's to swallow — memory must never affect
// the chat stream.
export async function maybeSealAndMerge(
  repoId: string,
  conversationId: string,
): Promise<boolean> {
  const newMessages = await newMessagesSinceSeal(conversationId);
  if (!shouldSeal(newMessages)) return false;
  const sealed = await sealConversation(conversationId);
  if (!sealed) return false;
  await mergeThreadMemory(repoId);
  return true;
}

// ---------------------------------------------------------------------------
// Thread memory merge (repo-level consolidation of ConversationMemory rows)
// ---------------------------------------------------------------------------

export interface ThreadMergePlan {
  shouldMerge: boolean;
  newSessions: number;
  totalSessions: number;
}

// Counter semantics: ThreadMemory.sessionsIncorporated is the total number of
// sealed conversation sessions already folded in; the repo's conversation
// memories each count their own seals. Only the delta above the thread's
// counter triggers a merge (spec: 只合并 sessionsIncorporated 大于 thread
// 已计数的), and the merge itself is idempotent thanks to uniquePreserveOrder.
export function planThreadMerge(
  threadSessionsIncorporated: number,
  conversationSessions: readonly number[],
): ThreadMergePlan {
  const totalSessions = conversationSessions.reduce(
    (sum, count) => sum + Math.max(0, count),
    0,
  );
  const newSessions = Math.max(
    0,
    totalSessions - Math.max(0, threadSessionsIncorporated),
  );
  return {
    shouldMerge: newSessions > 0,
    newSessions,
    totalSessions,
  };
}

export interface ThreadMergeResult {
  repoId: string;
  skipped: boolean;
  mergedSessions: number;
  sessionsIncorporated: number;
  conversationCount: number;
  generationMode: MemoryGenerationMode;
  snapshot: MemorySnapshot;
}

export async function mergeThreadMemory(
  repoId: string,
): Promise<ThreadMergeResult> {
  const [conversations, thread] = await Promise.all([
    prisma.conversationMemory.findMany({
      where: { repoId },
      orderBy: { updatedAt: "asc" },
    }),
    prisma.threadMemory.findUnique({ where: { repoId } }),
  ]);
  const threadSnapshot = thread ? memoryRowToSnapshot(thread) : emptySnapshot();
  const plan = planThreadMerge(
    thread?.sessionsIncorporated ?? 0,
    conversations.map((row) => row.sessionsIncorporated),
  );
  if (!plan.shouldMerge) {
    return {
      repoId,
      skipped: true,
      mergedSessions: 0,
      sessionsIncorporated: thread?.sessionsIncorporated ?? 0,
      conversationCount: conversations.length,
      generationMode: "deterministic",
      snapshot: threadSnapshot,
    };
  }

  // Deterministic fold in seal order (legacy merge_memory), newer sessions
  // land at the tail of the merged summary.
  let merged = conversations.reduce(
    (acc, row) => mergeSnapshots(acc, memoryRowToSnapshot(row)),
    threadSnapshot,
  );
  let generationMode: MemoryGenerationMode = "deterministic";
  if (memoryLlmConfigured()) {
    const consolidated = await generateSnapshot(
      "devflow-memory-thread-merge",
      MERGE_MEMORY_SYSTEM,
      {
        thread_memory: threadSnapshot,
        conversation_memories: conversations.map((row) =>
          memoryRowToSnapshot(row),
        ),
        merged_snapshot: merged,
      },
    );
    if (consolidated) {
      merged = consolidated;
      generationMode = "llm";
    }
  }

  const saved = await prisma.threadMemory.upsert({
    where: { repoId },
    create: {
      repoId,
      ...snapshotToData(merged),
      sessionsIncorporated: plan.totalSessions,
    },
    update: {
      ...snapshotToData(merged),
      sessionsIncorporated: plan.totalSessions,
    },
  });
  return {
    repoId,
    skipped: false,
    mergedSessions: plan.newSessions,
    sessionsIncorporated: saved.sessionsIncorporated,
    conversationCount: conversations.length,
    generationMode,
    snapshot: merged,
  };
}

// ---------------------------------------------------------------------------
// Prompt injection (context_compression.render_structured_memory)
// ---------------------------------------------------------------------------

// Item caps for the injected system-prompt section (legacy sliced each list
// at 12; the conversation section is tighter per spec 各限条目数).
export const MEMORY_CONTEXT_LIMITS = {
  threadSummaryTokens: 400,
  threadDecisions: 4,
  threadFacts: 4,
  conversationDecisions: 5,
  conversationOpenQuestions: 4,
  conversationTasks: 5,
} as const;

// Pure renderer so tests can exercise truncation without a database. English
// section labels: this text is model-facing (the chat system prompt is
// English), not UI copy.
export function renderMemoryContext(input: {
  thread: MemorySnapshot | null;
  conversation: MemorySnapshot | null;
}): string {
  const sections: string[] = [];
  const thread = input.thread;
  if (thread) {
    const lines: string[] = [];
    const summary = clipToTokenBudget(
      thread.summary,
      MEMORY_CONTEXT_LIMITS.threadSummaryTokens,
    );
    if (summary) lines.push(summary);
    const decisions = thread.decisions.slice(
      0,
      MEMORY_CONTEXT_LIMITS.threadDecisions,
    );
    if (decisions.length > 0) {
      lines.push(
        ["Key decisions:", ...decisions.map((item) => `- ${item}`)].join("\n"),
      );
    }
    const facts = thread.facts.slice(0, MEMORY_CONTEXT_LIMITS.threadFacts);
    if (facts.length > 0) {
      lines.push(
        ["Key facts:", ...facts.map((item) => `- ${item}`)].join("\n"),
      );
    }
    if (lines.length > 0) {
      sections.push(["## Repository memory (long-term)", ...lines].join("\n"));
    }
  }
  const conversation = input.conversation;
  if (conversation) {
    const lines: string[] = [];
    const pushList = (
      label: string,
      items: readonly string[],
      limit: number,
    ) => {
      const sliced = items.slice(0, limit);
      if (sliced.length > 0) {
        lines.push(
          [`${label}:`, ...sliced.map((item) => `- ${item}`)].join("\n"),
        );
      }
    };
    pushList(
      "Decisions",
      conversation.decisions,
      MEMORY_CONTEXT_LIMITS.conversationDecisions,
    );
    pushList(
      "Open questions",
      conversation.openQuestions,
      MEMORY_CONTEXT_LIMITS.conversationOpenQuestions,
    );
    pushList(
      "Tasks",
      conversation.tasks,
      MEMORY_CONTEXT_LIMITS.conversationTasks,
    );
    if (lines.length > 0) {
      sections.push(["## Current conversation memory", ...lines].join("\n"));
    }
  }
  return sections.join("\n\n");
}

// Memory section injected into the chat system prompt (failure is the
// caller's to swallow — chat must work without memory).
export async function buildMemoryContext(
  repoId: string,
  conversationId?: string | null,
): Promise<string> {
  const [thread, conversation] = await Promise.all([
    prisma.threadMemory.findUnique({ where: { repoId } }),
    conversationId
      ? prisma.conversationMemory.findFirst({
          where: { repoId, conversationId },
        })
      : Promise.resolve(null),
  ]);
  return renderMemoryContext({
    thread: thread ? memoryRowToSnapshot(thread) : null,
    conversation: conversation ? memoryRowToSnapshot(conversation) : null,
  });
}

// ---------------------------------------------------------------------------
// Memory candidates (memory_hub.py)
// ---------------------------------------------------------------------------

export const MEMORY_CANDIDATE_KINDS = [
  "decision",
  "fact",
  "task",
  "preference",
  "repo_context",
] as const;
export type MemoryCandidateKind = (typeof MEMORY_CANDIDATE_KINDS)[number];

export const MEMORY_CANDIDATE_ORIGINS = [
  "session_sealer",
  "chat_agent",
  "workflow",
] as const;
export type MemoryCandidateOrigin = (typeof MEMORY_CANDIDATE_ORIGINS)[number];

export const MEMORY_CANDIDATE_STATUSES = [
  "pending",
  "approved",
  "rejected",
] as const;

export interface MemoryCandidateView {
  id: string;
  repoId: string;
  conversationId: string | null;
  kind: string;
  title: string;
  content: string;
  status: string;
  origin: string;
  meta: Record<string, unknown>;
  createdAt: string;
  reviewedAt: string | null;
}

export function toMemoryCandidateView(
  row: MemoryCandidate,
): MemoryCandidateView {
  return {
    id: row.id,
    repoId: row.repoId,
    conversationId: row.conversationId,
    kind: row.kind,
    title: row.title,
    content: row.content,
    status: row.status,
    origin: row.origin,
    meta: asRecord(row.meta),
    createdAt: row.createdAt.toISOString(),
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
  };
}

// Legacy memory_hub._candidate_title (the zh label table there is UI copy;
// the stored title stays locale-neutral with the kind slug as prefix).
export function candidateTitle(kind: string, content: string): string {
  return `${kind}: ${clipInline(content, 80)}`;
}

export interface ProposeCandidateInput {
  repoId: string;
  conversationId?: string | null;
  kind: MemoryCandidateKind;
  title?: string | null;
  content: string;
  origin?: MemoryCandidateOrigin;
  meta?: Record<string, unknown>;
}

export interface ProposeCandidateResult {
  candidate: MemoryCandidateView;
  deduped: boolean;
}

// Create a pending candidate. Legacy memory_hub._candidate_exists: an
// identical (repo, kind, content) candidate that is still pending or already
// approved short-circuits creation.
export async function proposeMemoryCandidate(
  input: ProposeCandidateInput,
): Promise<ProposeCandidateResult> {
  const content = input.content.trim();
  const existing = await prisma.memoryCandidate.findFirst({
    where: {
      repoId: input.repoId,
      kind: input.kind,
      content,
      status: { in: ["pending", "approved"] },
    },
    orderBy: { createdAt: "desc" },
  });
  if (existing) {
    return { candidate: toMemoryCandidateView(existing), deduped: true };
  }
  const title =
    (input.title ?? "").trim() || candidateTitle(input.kind, content);
  const created = await prisma.memoryCandidate.create({
    data: {
      repoId: input.repoId,
      conversationId: input.conversationId ?? null,
      kind: input.kind,
      title,
      content,
      status: "pending",
      origin: input.origin ?? "chat_agent",
      meta: asJson({ ...(input.meta ?? {}) }),
    },
  });
  return { candidate: toMemoryCandidateView(created), deduped: false };
}

// Legacy memory_hub.capture_memory_candidates: fold a snapshot's list items
// into pending candidates (spec order: decision/fact/task/preference/repo).
const CANDIDATE_KIND_BY_FIELD: Array<
  [MemoryCandidateKind, keyof Omit<MemorySnapshot, "summary">]
> = [
  ["decision", "decisions"],
  ["fact", "facts"],
  ["task", "tasks"],
  ["preference", "userPreferences"],
  ["repo_context", "repoContext"],
];

export async function captureCandidatesFromSnapshot(
  repoId: string,
  conversationId: string | null,
  snapshot: MemorySnapshot,
  origin: MemoryCandidateOrigin,
): Promise<number> {
  let created = 0;
  for (const [kind, field] of CANDIDATE_KIND_BY_FIELD) {
    for (const value of snapshot[field]) {
      const content = value.trim();
      if (!content) continue;
      const result = await proposeMemoryCandidate({
        repoId,
        conversationId,
        kind,
        content,
        origin,
        meta: { memoryUpdateKey: field },
      });
      if (!result.deduped) created += 1;
    }
  }
  return created;
}

export async function listMemoryCandidates(
  repoId: string,
  opts?: { status?: string; limit?: number },
): Promise<MemoryCandidateView[]> {
  const status = opts?.status ?? "pending";
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 100);
  const rows = await prisma.memoryCandidate.findMany({
    where: { repoId, ...(status !== "all" ? { status } : {}) },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map(toMemoryCandidateView);
}

export interface ApproveCandidateResult {
  candidate: MemoryCandidateView;
  documentId: string | null;
  // "ready"/"skipped" from addKnowledgeDocument; "failed" when KB indexing
  // threw (e.g. no embedding key) — the approval itself still stands.
  kbStatus: "ready" | "skipped" | "failed";
  kbError: string | null;
}

// Legacy memory_hub.approve_memory_candidate: status → approved and the
// content lands in the KB as a `memory_note` document (routes/knowledge.py
// create_memory_note uses the same source_type). KB indexing is best-effort
// here: without an embedding key the approval decision persists with the
// error recorded in meta, mirroring "KB failure never discards the result".
export async function approveMemoryCandidate(
  repoId: string,
  candidateId: string,
): Promise<ApproveCandidateResult | null> {
  const candidate = await prisma.memoryCandidate.findFirst({
    where: { id: candidateId, repoId },
  });
  if (!candidate) return null;

  if (candidate.status === "approved") {
    // Idempotent re-approval (legacy early-return).
    const meta = asRecord(candidate.meta);
    const kbStatus = meta.kbStatus;
    return {
      candidate: toMemoryCandidateView(candidate),
      documentId:
        typeof meta.approvedDocumentId === "string"
          ? meta.approvedDocumentId
          : null,
      kbStatus:
        kbStatus === "ready" || kbStatus === "skipped" || kbStatus === "failed"
          ? kbStatus
          : "ready",
      kbError: typeof meta.kbError === "string" ? meta.kbError : null,
    };
  }

  let documentId: string | null = null;
  let kbStatus: "ready" | "skipped" | "failed" = "failed";
  let kbError: string | null = null;
  try {
    const doc = await addKnowledgeDocument({
      repoId,
      name: candidate.title,
      content: `${candidate.title}\n\n${candidate.content}`,
      sourceType: "memory_note",
    });
    documentId = doc.docId;
    kbStatus = doc.status;
  } catch (e) {
    kbError = e instanceof Error ? e.message : String(e);
  }

  const meta: Record<string, unknown> = {
    ...asRecord(candidate.meta),
    approvedDocumentId: documentId,
    kbStatus,
    approvedAt: new Date().toISOString(),
    ...(kbError ? { kbError } : {}),
  };
  const updated = await prisma.memoryCandidate.update({
    where: { id: candidate.id },
    data: {
      status: "approved",
      reviewedAt: new Date(),
      meta: asJson(meta),
    },
  });
  return {
    candidate: toMemoryCandidateView(updated),
    documentId,
    kbStatus,
    kbError,
  };
}

// Legacy memory_hub.reject_memory_candidate.
export async function rejectMemoryCandidate(
  repoId: string,
  candidateId: string,
): Promise<MemoryCandidateView | null> {
  const candidate = await prisma.memoryCandidate.findFirst({
    where: { id: candidateId, repoId },
  });
  if (!candidate) return null;
  if (candidate.status === "rejected") {
    return toMemoryCandidateView(candidate);
  }
  const updated = await prisma.memoryCandidate.update({
    where: { id: candidate.id },
    data: { status: "rejected", reviewedAt: new Date() },
  });
  return toMemoryCandidateView(updated);
}

// ---------------------------------------------------------------------------
// Read views for the API routes
// ---------------------------------------------------------------------------

export interface MemoryStateView extends MemorySnapshot {
  sessionsIncorporated: number;
  updatedAt: string;
}

export interface ConversationMemoryView extends MemoryStateView {
  conversationId: string;
  conversationTitle: string | null;
}

export interface RepoMemoryOverview {
  thread: MemoryStateView | null;
  conversations: ConversationMemoryView[];
}

function toMemoryStateView(row: MemoryRowShape): MemoryStateView {
  return {
    ...memoryRowToSnapshot(row),
    sessionsIncorporated: row.sessionsIncorporated,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getRepoMemoryOverview(
  repoId: string,
): Promise<RepoMemoryOverview> {
  const [thread, conversations] = await Promise.all([
    prisma.threadMemory.findUnique({ where: { repoId } }),
    prisma.conversationMemory.findMany({
      where: { repoId },
      orderBy: { updatedAt: "desc" },
      take: 50,
    }),
  ]);
  const titles = await prisma.conversation.findMany({
    where: { id: { in: conversations.map((row) => row.conversationId) } },
    select: { id: true, title: true },
  });
  const titleById = new Map(titles.map((row) => [row.id, row.title]));
  return {
    thread: thread ? toMemoryStateView(thread) : null,
    conversations: conversations.map((row) => ({
      ...toMemoryStateView(row),
      conversationId: row.conversationId,
      conversationTitle: titleById.get(row.conversationId) ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Request schemas for the memory routes (colocated here because
// lib/devflow/schemas.ts is out of this task's edit scope)
// ---------------------------------------------------------------------------

export const MemoryRepoQuerySchema = z.object({
  repoId: z.string().min(1),
});

export const MemoryCandidateCreateSchema = z.object({
  kind: z.enum(MEMORY_CANDIDATE_KINDS),
  title: z.string().max(200).optional(),
  content: z.string().min(1).max(20_000),
  conversationId: z.string().min(1).optional(),
});

export const MemoryCandidateActionSchema = z.object({
  action: z.enum(["approve", "reject"]),
});

export const MemoryCandidateListQuerySchema = z.object({
  status: z.enum([...MEMORY_CANDIDATE_STATUSES, "all"]).default("pending"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
