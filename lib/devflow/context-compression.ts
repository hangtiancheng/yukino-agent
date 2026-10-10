/**
 * Progressive context compression for DevFlow chat.
 *
 * Port of the legacy Python implementation:
 * - `.legacy/DevFlow-AI/backend/app/services/context_compression.py`
 * - `ProgressiveContextManager` + `ContextAssembler` in
 *   `.legacy/DevFlow-AI/backend/app/services/chat_memory.py`
 *
 * Adaptations to the current architecture:
 * - Legacy fed raw tool messages into the model history and micro-compacted
 *   stale regenerable tool results. The current history is user/assistant text
 *   only (tool traces persist in ChatMessage.toolCalls and are never replayed
 *   to the model), so the microcompact stage has no input and is omitted.
 * - `adjust_keep_start_to_preserve_api_invariants` (tool_use/tool_result
 *   pairing) is unnecessary for text-only history.
 * - Compact boundaries persist as ChatMessage rows with role "system" and
 *   meta.subtype "compact_boundary". History assembly injects the latest
 *   boundary summary into the system prompt; the UI timeline filters system
 *   rows out (same as the legacy GET /chat/history endpoint).
 */
import { generateText } from "ai";
import { z } from "zod/v4";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { providerOptions, quickModel } from "@/lib/ai/models";
import {
  clipToTokenBudget,
  estimateTokens,
  uniquePreserveOrder,
} from "@/lib/devflow/memory";

const asJson = (value: unknown): Prisma.InputJsonValue =>
  value as Prisma.InputJsonValue;

// ---------------------------------------------------------------------------
// Tunables — legacy `app/core/config.py` defaults.
// ---------------------------------------------------------------------------
export const CONTEXT_MAX_INPUT_TOKENS = 24_000;
export const CONTEXT_RESERVED_RESPONSE_TOKENS = 3_000;
export const CONTEXT_COMPACT_RESERVED_OUTPUT_TOKENS = 12_000;
export const CONTEXT_WARNING_BUFFER_TOKENS = 20_000;
export const CONTEXT_AUTO_COMPACT_BUFFER_TOKENS = 13_000;
export const CONTEXT_AGGRESSIVE_BUFFER_TOKENS = 8_000;
export const CONTEXT_MANUAL_BUFFER_TOKENS = 3_000;
export const COMPACT_KEEP_RECENT_MESSAGES = 8;
export const COMPACT_SUMMARY_TOKENS = 1_800;
export const MAX_COMPACTION_FAILURES = 3;
export const CONTEXT_SYSTEM_RATIO = 0.12;
export const CONTEXT_MEMORY_RATIO = 0.22;
export const CONTEXT_EVIDENCE_RATIO = 0.34;
export const CONTEXT_RECENT_RATIO = 0.22;
export const CONTEXT_TOOL_RATIO = 0.1;

export const COMPACT_BOUNDARY_SUBTYPE = "compact_boundary";
export const COMPACTION_FAILURE_SUBTYPE = "compaction_failure";

// ---------------------------------------------------------------------------
// Model context windows (ported tables).
// ---------------------------------------------------------------------------
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "deepseek-v4-pro": 1_000_000,
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-4.1": 1_000_000,
  "gpt-4.1-mini": 1_000_000,
  "gpt-4.1-nano": 1_000_000,
  "gpt-5": 400_000,
  "gpt-5-mini": 400_000,
  "gpt-5-nano": 400_000,
  o1: 200_000,
  "o1-mini": 128_000,
  o3: 200_000,
  "o3-mini": 200_000,
  "o4-mini": 200_000,
  "claude-3-5-sonnet": 200_000,
  "claude-3-7-sonnet": 200_000,
  "claude-sonnet-4": 200_000,
  "claude-opus-4": 200_000,
};

export const MODEL_OUTPUT_WINDOWS: Record<string, number> = {
  "deepseek-v4-pro": 384_000,
  "gpt-4o": 16_384,
  "gpt-4o-mini": 16_384,
  "gpt-4.1": 32_768,
  "gpt-4.1-mini": 32_768,
  "gpt-4.1-nano": 32_768,
  "gpt-5": 128_000,
  "gpt-5-mini": 128_000,
  "gpt-5-nano": 128_000,
  o1: 100_000,
  "o1-mini": 65_536,
  o3: 100_000,
  "o3-mini": 100_000,
  "o4-mini": 100_000,
  "claude-3-5-sonnet": 8_192,
  "claude-3-7-sonnet": 64_000,
  "claude-sonnet-4": 64_000,
  "claude-opus-4": 64_000,
};

export function normalizeModelName(model: string | null | undefined): string {
  let value = String(model ?? "")
    .trim()
    .toLowerCase();
  if (!value) return "unknown";
  value = value.split("/").pop() ?? value;
  return value.replace(
    /-(20\d{2}[-_]\d{2}[-_]\d{2}|\d{4}[-_]\d{2}[-_]\d{2})$/,
    "",
  );
}

function modelLookup(
  model: string | null | undefined,
  table: Record<string, number>,
): number | null {
  const normalized = normalizeModelName(model);
  if (normalized in table) return table[normalized];
  for (const [key, value] of Object.entries(table)) {
    if (normalized.startsWith(key)) return value;
  }
  return null;
}

export function modelContextWindowTokens(
  model: string | null | undefined,
): number {
  const known = modelLookup(model, MODEL_CONTEXT_WINDOWS);
  if (known !== null) return known;
  return Math.max(
    4096,
    CONTEXT_MAX_INPUT_TOKENS + CONTEXT_RESERVED_RESPONSE_TOKENS,
  );
}

export function modelOutputWindowTokens(
  model: string | null | undefined,
): number {
  const known = modelLookup(model, MODEL_OUTPUT_WINDOWS);
  if (known !== null) return known;
  return Math.max(512, CONTEXT_RESERVED_RESPONSE_TOKENS);
}

export function effectiveContextWindowTokens(
  model: string | null | undefined,
  forCompaction = false,
): number {
  const modelWindow = modelContextWindowTokens(model);
  const reserved = forCompaction
    ? Math.min(
        modelOutputWindowTokens(model),
        Math.max(512, CONTEXT_COMPACT_RESERVED_OUTPUT_TOKENS),
      )
    : Math.max(
        512,
        Math.min(CONTEXT_RESERVED_RESPONSE_TOKENS, Math.floor(modelWindow / 2)),
      );
  const dynamicWindow = Math.max(4096, modelWindow - reserved);
  // legacy: context_dynamic_model_window_enabled defaults to true
  return Math.max(CONTEXT_MAX_INPUT_TOKENS, dynamicWindow);
}

// ---------------------------------------------------------------------------
// Context pressure.
// ---------------------------------------------------------------------------
export type PressureStage =
  "normal" | "warning" | "auto_compact" | "aggressive" | "manual_path";

export interface ContextPressure {
  stage: PressureStage;
  tokenUsage: number;
  effectiveWindowTokens: number;
  remainingTokens: number;
  warningThreshold: number;
  autoCompactThreshold: number;
  aggressiveThreshold: number;
  manualThreshold: number;
  utilization: number;
}

export function thresholdsForWindow(window: number): {
  warning: number;
  auto: number;
  aggressive: number;
  manual: number;
} {
  const warningBuffer = Math.min(
    CONTEXT_WARNING_BUFFER_TOKENS,
    Math.max(512, Math.floor(window / 4)),
  );
  const autoBuffer = Math.min(
    CONTEXT_AUTO_COMPACT_BUFFER_TOKENS,
    Math.max(512, Math.floor(window / 5)),
  );
  const aggressiveBuffer = Math.min(
    CONTEXT_AGGRESSIVE_BUFFER_TOKENS,
    Math.max(512, Math.floor(window / 8)),
  );
  const manualBuffer = Math.min(
    CONTEXT_MANUAL_BUFFER_TOKENS,
    Math.max(256, Math.floor(window / 16)),
  );
  const auto = Math.max(1024, window - autoBuffer);
  const warning = Math.max(512, Math.min(auto - 1, auto - warningBuffer));
  const aggressive = Math.max(auto + 1, window - aggressiveBuffer);
  const manual = Math.max(aggressive + 1, window - manualBuffer);
  return { warning, auto, aggressive, manual };
}

export function calculateContextPressure(
  tokenUsage: number,
  model?: string | null,
): ContextPressure {
  const effectiveWindow = effectiveContextWindowTokens(model, true);
  const t = thresholdsForWindow(effectiveWindow);
  let stage: PressureStage;
  if (tokenUsage >= t.manual) stage = "manual_path";
  else if (tokenUsage >= t.aggressive) stage = "aggressive";
  else if (tokenUsage >= t.auto) stage = "auto_compact";
  else if (tokenUsage >= t.warning) stage = "warning";
  else stage = "normal";
  return {
    stage,
    tokenUsage,
    effectiveWindowTokens: effectiveWindow,
    remainingTokens: Math.max(0, effectiveWindow - tokenUsage),
    warningThreshold: t.warning,
    autoCompactThreshold: t.auto,
    aggressiveThreshold: t.aggressive,
    manualThreshold: t.manual,
    utilization: effectiveWindow
      ? Math.round((tokenUsage / effectiveWindow) * 10_000) / 10_000
      : 0,
  };
}

// ---------------------------------------------------------------------------
// Context budget + token-budgeted history compression.
// ---------------------------------------------------------------------------
export interface ContextBudget {
  maxInputTokens: number;
  reservedResponseTokens: number;
  systemTokens: number;
  memoryTokens: number;
  evidenceTokens: number;
  recentTokens: number;
  toolObservationTokens: number;
}

export function defaultContextBudget(model?: string | null): ContextBudget {
  const maxInput = Math.max(
    CONTEXT_MAX_INPUT_TOKENS,
    modelContextWindowTokens(model),
  );
  const reserved = Math.max(
    512,
    Math.min(CONTEXT_RESERVED_RESPONSE_TOKENS, Math.floor(maxInput / 2)),
  );
  const available = maxInput - reserved;
  return {
    maxInputTokens: maxInput,
    reservedResponseTokens: reserved,
    systemTokens: Math.max(512, Math.floor(available * CONTEXT_SYSTEM_RATIO)),
    memoryTokens: Math.max(512, Math.floor(available * CONTEXT_MEMORY_RATIO)),
    evidenceTokens: Math.max(
      512,
      Math.floor(available * CONTEXT_EVIDENCE_RATIO),
    ),
    recentTokens: Math.max(512, Math.floor(available * CONTEXT_RECENT_RATIO)),
    toolObservationTokens: Math.max(
      512,
      Math.floor(available * CONTEXT_TOOL_RATIO),
    ),
  };
}

export interface HistoryMessage {
  role: string;
  content: string;
  toolNames?: string[];
}

export interface CompressionStats {
  inputMessages: number;
  eligibleMessages: number;
  keptMessages: number;
  omittedMessages: number;
  truncatedMessages: number;
  exactSuffixMessages: number;
  estimatedTokens: number;
  budgetTokens: number;
}

export function compressMessages(
  messages: readonly HistoryMessage[],
  maxTokens: number,
): { kept: HistoryMessage[]; stats: CompressionStats } {
  const keptReversed: HistoryMessage[] = [];
  let used = 0;
  let truncatedMessages = 0;
  let exactSuffixMessages = 0;
  let exactSuffixOpen = true;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    const role = String(message.role ?? "");
    const content = String(message.content ?? "");
    if ((role !== "user" && role !== "assistant") || !content.trim()) {
      continue;
    }
    const perMessageBudget = Math.max(
      96,
      Math.min(900, Math.floor(maxTokens / 3)),
    );
    const clipped = clipToTokenBudget(content, perMessageBudget);
    const cost = estimateTokens(role) + estimateTokens(clipped);
    if (keptReversed.length > 0 && used + cost > maxTokens) break;
    keptReversed.push({ role, content: clipped });
    if (clipped === content.trim()) {
      if (exactSuffixOpen) exactSuffixMessages += 1;
    } else {
      truncatedMessages += 1;
      exactSuffixOpen = false;
    }
    used += cost;
    if (used >= maxTokens) break;
  }
  const kept = keptReversed.reverse();
  const eligibleMessages = messages.filter(
    (m) =>
      (m.role === "user" || m.role === "assistant") &&
      String(m.content ?? "").trim(),
  ).length;
  return {
    kept,
    stats: {
      inputMessages: messages.length,
      eligibleMessages,
      keptMessages: kept.length,
      omittedMessages: Math.max(0, eligibleMessages - kept.length),
      truncatedMessages,
      exactSuffixMessages,
      estimatedTokens: used,
      budgetTokens: maxTokens,
    },
  };
}

// ---------------------------------------------------------------------------
// Key-fact preservation (ported).
// ---------------------------------------------------------------------------
const PATH_LIKE_PATTERN =
  /(?:[A-Za-z]:[\\/])?(?:[\w.@()+\- ]+[\\/])+[\w.@()+\- ]+\.[A-Za-z0-9_]+(?::\d+)?/g;
const COMMAND_HINT_PATTERN =
  /\b(pytest|npm|pnpm|yarn|git|docker|uvicorn|alembic|python|pip|ruff|mypy)\b/i;
const PRESERVE_LINE_HINTS = [
  "error",
  "failed",
  "failure",
  "exception",
  "traceback",
  "decision",
  "decide",
  "agreed",
  "todo",
  "next step",
  "决定",
  "确定",
  "待办",
  "下一步",
  "错误",
  "失败",
];

export function mustPreserveCandidates(
  messages: readonly HistoryMessage[],
  limit = 18,
): string[] {
  const candidates: string[] = [];
  for (const message of messages) {
    const content = String(message.content ?? "");
    if (!content) continue;
    for (const match of content.matchAll(PATH_LIKE_PATTERN)) {
      candidates.push(match[0].trim());
    }
    for (const rawLine of content.split(/[\r\n]+/)) {
      const line = rawLine
        .trim()
        .replace(/^[-\t ]+/, "")
        .split(/\s+/)
        .join(" ");
      if (!line) continue;
      const lower = line.toLowerCase();
      if (
        COMMAND_HINT_PATTERN.test(line) ||
        PRESERVE_LINE_HINTS.some((hint) => lower.includes(hint))
      ) {
        candidates.push(clipToTokenBudget(line, 120));
      }
    }
  }
  return uniquePreserveOrder(candidates, limit);
}

export interface PreservationReport {
  requiredCount: number;
  missingCount: number;
  required: string[];
  missing: string[];
  appendedMissingCount?: number;
}

export function compactionPreservationReport(
  messages: readonly HistoryMessage[],
  summary: string,
): PreservationReport {
  const required = mustPreserveCandidates(messages);
  const summaryLower = String(summary ?? "").toLowerCase();
  const missing = required.filter(
    (item) => !summaryLower.includes(item.toLowerCase()),
  );
  return {
    requiredCount: required.length,
    missingCount: missing.length,
    required,
    missing,
  };
}

export function ensureCompactionSummaryPreservesKeyFacts(
  messages: readonly HistoryMessage[],
  summary: string,
  maxTokens: number,
): { summary: string; report: PreservationReport } {
  const report = compactionPreservationReport(messages, summary);
  const missing = report.missing;
  if (missing.length === 0) {
    return { summary: clipToTokenBudget(summary, maxTokens), report };
  }
  const appendix = [
    "保真补充：",
    ...missing.slice(0, 12).map((item) => `- ${clipToTokenBudget(item, 96)}`),
  ].join("\n");
  const bodyBudget = Math.max(160, maxTokens - estimateTokens(appendix) - 12);
  const combined = clipToTokenBudget(
    [clipToTokenBudget(summary, bodyBudget), appendix]
      .filter(Boolean)
      .join("\n\n")
      .trim(),
    maxTokens,
  );
  const finalReport = compactionPreservationReport(messages, combined);
  finalReport.appendedMissingCount = missing.length;
  return { summary: combined, report: finalReport };
}

// ---------------------------------------------------------------------------
// Compaction summary building (ported).
// ---------------------------------------------------------------------------
export const COMPACT_SUMMARY_SYSTEM_PROMPT = `请在上下文压缩后，为 DevFlow AI 创建一份可延续工作的摘要。
目标不是单纯减少 token，而是为软件工程 Agent 保留工作连续性。

请用纯文本返回以下部分：
1. 用户意图和明确要求。
2. 当前工作面：现在正在处理什么；如相关，请包含仓库、文件、函数、命令、测试和 UI 状态。
3. 持久决策和约束。
4. 重要事实、代码引用、错误和修复。
5. 待办任务和下一步，并以最近一次用户请求为依据。

当文件路径、标识符、日期、命令、错误消息和用户偏好很重要时，请保留原文。
不要编造细节。如果某个细节只存在于可以重新生成的工具输出中，请说明它可以通过相关工具恢复。`;

export function buildCompactionSummaryPayload(
  messages: readonly HistoryMessage[],
  maxTokens = 6000,
): string {
  const lines: string[] = [];
  for (const message of messages) {
    const role = String(message.role ?? "unknown");
    const perMessage = Math.max(
      160,
      Math.floor(maxTokens / Math.max(messages.length, 1)),
    );
    const content = clipToTokenBudget(
      String(message.content ?? ""),
      perMessage,
    );
    if (!content) continue;
    const toolNames = message.toolNames ?? [];
    const suffix = toolNames.length > 0 ? ` tools=${toolNames.join(",")}` : "";
    lines.push(`${role}${suffix}: ${content}`);
  }
  return clipToTokenBudget(lines.join("\n\n"), maxTokens);
}

export function formatCompactionSummary(summary: string): string {
  let formatted = String(summary ?? "").trim();
  formatted = formatted.replace(/<analysis>[\s\S]*?<\/analysis>/gi, "").trim();
  const match = /<summary>([\s\S]*?)<\/summary>/i.exec(formatted);
  if (match) formatted = `摘要：\n${match[1].trim()}`;
  return formatted.replace(/\n{3,}/g, "\n\n").trim();
}

export function fallbackCompactionSummary(
  messages: readonly HistoryMessage[],
  maxTokens: number = COMPACT_SUMMARY_TOKENS,
): string {
  const userMessages = messages
    .filter((m) => m.role === "user")
    .map((m) => String(m.content ?? ""));
  const assistantMessages = messages
    .filter((m) => m.role === "assistant")
    .map((m) => String(m.content ?? ""));
  const decisions: string[] = [];
  const tasks: string[] = [];
  const facts: string[] = [];
  for (const content of [...userMessages, ...assistantMessages]) {
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim().replace(/^[-\t ]+/, "");
      if (!line) continue;
      const lower = line.toLowerCase();
      if (
        ["decision", "decide", "agreed", "决定", "确定"].some((token) =>
          lower.includes(token),
        )
      ) {
        decisions.push(line);
      }
      if (
        ["todo", "next step", "implement", "fix", "待办", "下一步"].some(
          (token) => lower.includes(token),
        )
      ) {
        tasks.push(line);
      }
      if (line.length > 20 && facts.length < 10) facts.push(line);
    }
  }
  const summary = [
    "This conversation was compacted. Continue from the preserved recent messages and this summary.",
    `User intent:\n${userMessages
      .slice(-8)
      .map((item) => `- ${clipToTokenBudget(item, 120)}`)
      .join("\n")}`,
    `Assistant context:\n${assistantMessages
      .slice(-5)
      .map((item) => `- ${clipToTokenBudget(item, 120)}`)
      .join("\n")}`,
    `Durable decisions:\n${uniquePreserveOrder(decisions, 12)
      .map((item) => `- ${item}`)
      .join("\n")}`,
    `Pending tasks:\n${uniquePreserveOrder(tasks, 12)
      .map((item) => `- ${item}`)
      .join("\n")}`,
    `Important facts:\n${uniquePreserveOrder(facts, 12)
      .map((item) => `- ${item}`)
      .join("\n")}`,
  ].join("\n\n");
  return clipToTokenBudget(summary, maxTokens);
}

// ---------------------------------------------------------------------------
// Stage plans (ported `_compaction_plan_for_stage`).
// ---------------------------------------------------------------------------
export interface CompactionPlan {
  keepRecent: number;
  summaryTokens: number;
  modePrefix: string;
}

export function compactionPlanForStage(stage: PressureStage): CompactionPlan {
  const defaultKeep = Math.max(2, COMPACT_KEEP_RECENT_MESSAGES);
  const defaultSummaryTokens = Math.max(256, COMPACT_SUMMARY_TOKENS);
  if (stage === "manual_path") {
    return {
      keepRecent: Math.max(
        2,
        Math.min(defaultKeep, Math.max(2, Math.floor(defaultKeep / 3))),
      ),
      summaryTokens: Math.min(
        defaultSummaryTokens,
        Math.max(256, Math.floor(defaultSummaryTokens * 0.5)),
      ),
      modePrefix: "manual_path",
    };
  }
  if (stage === "aggressive") {
    return {
      keepRecent: Math.max(
        2,
        Math.min(defaultKeep, Math.max(3, Math.floor(defaultKeep / 2))),
      ),
      summaryTokens: Math.min(
        defaultSummaryTokens,
        Math.max(256, Math.floor(defaultSummaryTokens * 0.67)),
      ),
      modePrefix: "aggressive",
    };
  }
  return {
    keepRecent: defaultKeep,
    summaryTokens: defaultSummaryTokens,
    modePrefix: "",
  };
}

// ---------------------------------------------------------------------------
// Boundary persistence helpers.
// ---------------------------------------------------------------------------
interface MetaShape {
  role: string;
  meta: unknown;
}

export function isCompactBoundaryMessage(message: MetaShape): boolean {
  if (message.role !== "system") return false;
  const parsed = z
    .object({ subtype: z.string().optional() })
    .safeParse(message.meta);
  return parsed.success && parsed.data.subtype === COMPACT_BOUNDARY_SUBTYPE;
}

function isCompactionFailureMessage(message: MetaShape): boolean {
  if (message.role !== "system") return false;
  const parsed = z
    .object({ subtype: z.string().optional() })
    .safeParse(message.meta);
  return parsed.success && parsed.data.subtype === COMPACTION_FAILURE_SUBTYPE;
}

export async function latestCompactBoundary(
  conversationId: string,
): Promise<{ id: string; content: string; createdAt: Date } | null> {
  const rows = await prisma.chatMessage.findMany({
    where: { conversationId, role: "system" },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      content: true,
      meta: true,
      createdAt: true,
      role: true,
    },
  });
  for (const row of rows) {
    if (isCompactBoundaryMessage(row)) return row;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Structured session memory rendering (ported `render_structured_memory`).
// ---------------------------------------------------------------------------
const stringList = (value: unknown): string[] => {
  const parsed = z.array(z.string()).safeParse(value);
  return parsed.success ? parsed.data : [];
};

export function renderStructuredMemory(
  memory: {
    summary: string;
    facts: unknown;
    decisions: unknown;
    openQuestions: unknown;
    tasks: unknown;
    userPreferences: unknown;
    repoContext: unknown;
  },
  maxTokens?: number,
): string {
  const sections: string[] = [];
  const summary = String(memory.summary ?? "").trim();
  if (summary) sections.push(`摘要：\n${summary}`);
  const groups: Array<[string, string[]]> = [
    ["事实", stringList(memory.facts)],
    ["决策", stringList(memory.decisions)],
    ["未决问题", stringList(memory.openQuestions)],
    ["任务", stringList(memory.tasks)],
    ["用户偏好", stringList(memory.userPreferences)],
    ["仓库上下文", stringList(memory.repoContext)],
  ];
  for (const [label, values] of groups) {
    if (values.length > 0) {
      sections.push(
        `${label}:\n${values
          .slice(0, 12)
          .map((item) => `- ${item}`)
          .join("\n")}`,
      );
    }
  }
  const text = sections.join("\n\n");
  return maxTokens ? clipToTokenBudget(text, maxTokens) : text;
}

// ---------------------------------------------------------------------------
// Orchestrator (ported `ProgressiveContextManager.ensure_headroom`).
// ---------------------------------------------------------------------------
export interface CompactionOutcome {
  attempted: boolean;
  compacted?: boolean;
  reason?: string;
  mode?: string;
  stage?: PressureStage;
  boundaryId?: string;
  messagesSummarized?: number;
  messagesPreserved?: number;
  postCompactEstimatedTokens?: number;
  consecutiveFailures?: number;
  error?: string;
  pressure: ContextPressure;
}

async function llmCompactionSummary(
  payload: string,
  currentMessage: string,
): Promise<string> {
  const res = await generateText({
    model: quickModel,
    system: COMPACT_SUMMARY_SYSTEM_PROMPT,
    prompt: `Current user request that triggered pressure:\n${currentMessage}\n\nConversation segment to compact:\n${payload}`,
    providerOptions,
  });
  return res.text;
}

async function summaryFor(params: {
  repoId: string;
  conversationId: string;
  messages: HistoryMessage[];
  currentMessage: string;
  maxSummaryTokens: number;
}): Promise<{ summary: string; mode: string; report: PreservationReport }> {
  const memory = await prisma.conversationMemory.findUnique({
    where: { conversationId: params.conversationId },
  });
  if (memory) {
    const memoryText = renderStructuredMemory(memory);
    if (memoryText.trim()) {
      const rendered = renderStructuredMemory(memory, params.maxSummaryTokens);
      const continuation = `This conversation was compacted using structured session memory. Continue from the preserved recent messages and the current user request.\n\n${rendered}`;
      const ensured = ensureCompactionSummaryPreservesKeyFacts(
        params.messages,
        continuation,
        params.maxSummaryTokens,
      );
      return {
        summary: ensured.summary,
        mode: "session_memory",
        report: ensured.report,
      };
    }
  }

  const payload = buildCompactionSummaryPayload(params.messages);
  let llmSummary = "";
  try {
    llmSummary = formatCompactionSummary(
      await llmCompactionSummary(payload, params.currentMessage),
    );
  } catch (e) {
    // Faithful to legacy: an LLM failure aborts this compaction attempt and is
    // recorded by the caller's circuit breaker (the deterministic fallback is
    // only used for an *empty* model reply).
    throw e;
  }
  if (!llmSummary) {
    const fallback = fallbackCompactionSummary(
      params.messages,
      params.maxSummaryTokens,
    );
    const ensured = ensureCompactionSummaryPreservesKeyFacts(
      params.messages,
      fallback,
      params.maxSummaryTokens,
    );
    return {
      summary: ensured.summary,
      mode: "fallback_extractive",
      report: ensured.report,
    };
  }
  const ensured = ensureCompactionSummaryPreservesKeyFacts(
    params.messages,
    llmSummary,
    params.maxSummaryTokens,
  );
  return {
    summary: ensured.summary,
    mode: "full_compaction",
    report: ensured.report,
  };
}

function messagesToKeep(
  rows: HistoryMessage[],
  keepCount: number,
): HistoryMessage[] {
  const keep = Math.max(2, keepCount);
  const startIndex = Math.max(0, rows.length - keep);
  const keepRows = rows.slice(startIndex);
  // Legacy invariant: never start the kept window on an assistant reply whose
  // user prompt was summarized away.
  if (
    keepRows.length > 0 &&
    keepRows[0].role === "assistant" &&
    startIndex > 0 &&
    rows[startIndex - 1].role === "user"
  ) {
    return [rows[startIndex - 1], ...keepRows];
  }
  return keepRows;
}

export async function ensureContextHeadroom(params: {
  repoId: string;
  conversationId: string;
  currentMessage: string;
  model?: string | null;
  enabled?: boolean;
}): Promise<CompactionOutcome> {
  const { repoId, conversationId, currentMessage } = params;
  const enabled = params.enabled ?? true;

  const boundary = await latestCompactBoundary(conversationId);
  const rows = await prisma.chatMessage.findMany({
    where: {
      conversationId,
      ...(boundary ? { createdAt: { gt: boundary.createdAt } } : {}),
    },
    orderBy: { createdAt: "asc" },
    take: 500,
    select: {
      id: true,
      role: true,
      content: true,
      toolCalls: true,
      meta: true,
      createdAt: true,
    },
  });

  const contextRows = rows.filter(
    (row) => row.role === "user" || row.role === "assistant",
  );
  // The current user message is already persisted, so it is part of the
  // segment; do not double count it (legacy added it separately because the
  // message was not yet in the store at that point).
  const rawTokens = contextRows.reduce(
    (sum, row) => sum + estimateTokens(row.content),
    0,
  );
  const pressure = calculateContextPressure(rawTokens, params.model);

  if (!enabled) {
    return { attempted: false, reason: "auto_compact_disabled", pressure };
  }
  if (pressure.stage === "normal" || pressure.stage === "warning") {
    return { attempted: false, reason: pressure.stage, pressure };
  }

  const failures = rows.filter((row) => isCompactionFailureMessage(row)).length;
  if (failures >= MAX_COMPACTION_FAILURES) {
    return {
      attempted: false,
      reason: "circuit_breaker_open",
      consecutiveFailures: failures,
      pressure,
    };
  }

  try {
    return await compactSegment({
      repoId,
      conversationId,
      currentMessage,
      rows: contextRows,
      pressure,
      model: params.model ?? null,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await prisma.chatMessage
      .create({
        data: {
          conversationId,
          repoId,
          role: "system",
          content: "",
          meta: asJson({
            subtype: COMPACTION_FAILURE_SUBTYPE,
            stage: pressure.stage,
            error: message.slice(0, 500),
          }),
        },
      })
      .catch(() => {});
    return {
      attempted: true,
      compacted: false,
      reason: "compaction_failed",
      error: message,
      consecutiveFailures: failures + 1,
      pressure,
    };
  }
}

async function compactSegment(params: {
  repoId: string;
  conversationId: string;
  currentMessage: string;
  rows: Array<{
    id: string;
    role: string;
    content: string;
    toolCalls: unknown;
  }>;
  pressure: ContextPressure;
  model: string | null;
}): Promise<CompactionOutcome> {
  const { repoId, conversationId, currentMessage, pressure } = params;
  const messages: HistoryMessage[] = params.rows.map((row) => ({
    role: row.role,
    content: row.content,
    toolNames: toolNamesOf(row.toolCalls),
  }));

  const planStages: PressureStage[] = [pressure.stage];
  if (pressure.stage === "auto_compact") {
    planStages.push("aggressive", "manual_path");
  } else if (pressure.stage === "aggressive") {
    planStages.push("manual_path");
  }
  const plans = planStages.map((stage) => ({
    stage,
    plan: compactionPlanForStage(stage),
  }));
  const minKeep = Math.min(...plans.map((item) => item.plan.keepRecent));
  if (messages.length <= minKeep + 1) {
    return {
      attempted: true,
      compacted: false,
      reason: "not_enough_messages",
      pressure,
    };
  }

  let selected: {
    stage: PressureStage;
    plan: CompactionPlan;
    keep: HistoryMessage[];
    summarize: HistoryMessage[];
    summary: string;
    mode: string;
    report: PreservationReport;
    postCompactTokens: number;
  } | null = null;

  for (const { stage, plan } of plans) {
    const keep = messagesToKeep(messages, plan.keepRecent);
    const summarize = messages.slice(
      0,
      Math.max(0, messages.length - keep.length),
    );
    if (summarize.length === 0) continue;
    const { summary, mode, report } = await summaryFor({
      repoId,
      conversationId,
      messages: summarize,
      currentMessage,
      maxSummaryTokens: plan.summaryTokens,
    });
    const fullMode = plan.modePrefix ? `${plan.modePrefix}_${mode}` : mode;
    const postCompactTokens =
      estimateTokens(summary) +
      keep.reduce((sum, m) => sum + estimateTokens(m.content), 0) +
      estimateTokens(currentMessage);
    const postPressure = calculateContextPressure(
      postCompactTokens,
      params.model,
    );
    selected = {
      stage,
      plan,
      keep,
      summarize,
      summary,
      mode: fullMode,
      report,
      postCompactTokens,
    };
    if (postPressure.stage === "normal" || postPressure.stage === "warning") {
      break;
    }
  }

  if (!selected) {
    return {
      attempted: true,
      compacted: false,
      reason: "nothing_to_summarize",
      pressure,
    };
  }

  const boundaryRow = await prisma.chatMessage.create({
    data: {
      conversationId,
      repoId,
      role: "system",
      content: selected.summary,
      meta: asJson({
        subtype: COMPACT_BOUNDARY_SUBTYPE,
        trigger: "auto",
        mode: selected.mode,
        stage: selected.stage,
        pressure: {
          stage: pressure.stage,
          tokenUsage: pressure.tokenUsage,
          effectiveWindowTokens: pressure.effectiveWindowTokens,
          utilization: pressure.utilization,
        },
        messagesSummarized: selected.summarize.length,
        messagesPreserved: selected.keep.length,
        summaryEstimatedTokens: estimateTokens(selected.summary),
        preservation: selected.report,
      }),
    },
  });

  return {
    attempted: true,
    compacted: true,
    mode: selected.mode,
    stage: selected.stage,
    boundaryId: boundaryRow.id,
    messagesSummarized: selected.summarize.length,
    messagesPreserved: selected.keep.length,
    postCompactEstimatedTokens: selected.postCompactTokens,
    consecutiveFailures: 0,
    pressure,
  };
}

function toolNamesOf(toolCalls: unknown): string[] {
  const parsed = z
    .array(z.object({ name: z.string().catch("") }))
    .safeParse(toolCalls);
  if (!parsed.success) return [];
  return parsed.data.map((item) => item.name).filter((name) => name !== "");
}
