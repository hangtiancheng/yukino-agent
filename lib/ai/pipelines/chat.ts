// Chat pipeline: RAG retrieval + system prompt + ReAct agent (streamText/generateText with tools + maxSteps).
//
// Stream protocol (port of legacy agent_py chat/streaming.py): besides text
// chunks the stream forwards model reasoning deltas (`reasoning.delta` →
// {type:"reasoning"}) and tool-call lifecycle events (`tool.call` →
// {type:"tool", name, state}), and every completed tool call is written to
// the Prisma ToolCallAudit table fire-and-forget (GET /api/tool_audits).
// Memory compaction folds window-evicted pairs into a rolling summary
// injected into the system prompt (lib/memory.ts).
import {
  streamText,
  generateText,
  type Tool,
  type ToolSet,
  type ModelMessage,
  type TextStreamPart,
  isStepCount,
} from "ai";
import { quickModel, providerOptions } from "@/lib/ai/models";
import { A2UI_OPEN_TAG, A2UI_PROMPT_SECTION } from "@/lib/ai/a2ui/prompt";
import { correctA2uiBlock } from "@/lib/ai/a2ui/correct";
import {
  createA2uiStreamFilter,
  extractA2ui,
  parseA2uiBlock,
} from "@/lib/ai/a2ui/extract";
import { builtinTools } from "@/lib/ai/tools";
import { getLogMcpTools } from "@/lib/ai/tools/query-log";
import { retrieve, type RetrievedDoc } from "@/lib/milvus/retriever";
import {
  isKnowledgeType,
  type KnowledgeType,
} from "@/lib/ai/pipelines/knowledge-index";
import { getSimpleMemory, summarySection } from "@/lib/memory";
import {
  getSkillCatalogPrompt,
  getChatPromptSection,
} from "@/lib/ai/prompts-skills";
import { prisma } from "@/lib/db";

// P3-5 fix: read log topic config from env vars instead of hardcoding
// region/id in the system prompt.
const LOG_TOPIC_REGION = process.env.LOG_TOPIC_REGION ?? "";
const LOG_TOPIC_ID = process.env.LOG_TOPIC_ID ?? "";
const logTopicLine =
  LOG_TOPIC_REGION && LOG_TOPIC_ID
    ? `  • Log topic region: ${LOG_TOPIC_REGION}; log topic id: ${LOG_TOPIC_ID}`
    : "";

// System prompt for the conversational assistant.
const SYSTEM_PROMPT = `# Role: Conversational Assistant

## Core capabilities

- Context understanding and conversation
- Search the web for information

## Interaction guidelines

- Before replying, ensure you:
  - Fully understand the user's needs and questions; confirm with the user if anything is unclear
  - Consider the most appropriate solution approach
    ${logTopicLine}
- When providing help:
  - Use clear and concise language
  - Provide practical examples when appropriate
  - Reference documentation when helpful
  - Suggest improvements or next steps when applicable
- If a request is beyond your capabilities:
  - Clearly state your limitations and, if possible, suggest alternative approaches
- For complex or compound questions, think step by step and avoid giving low-quality answers directly.

## Output requirements:

- Readable and well-structured, with line breaks when needed
- Output markdown only
  ${A2UI_PROMPT_SECTION}

## Context information

- Current date: {date}
- Relevant documents: |-
  ==== Documents start ====
  {documents}
  ==== Documents end ====
{summary}`;

function buildSystemPrompt(
  documents: string,
  summary = "",
  skillCatalog = "",
  customPrompt = "",
): string {
  return SYSTEM_PROMPT.replace("{date}", new Date().toLocaleString("en-US"))
    .replace("{documents}", documents)
    .replace(
      "{summary}",
      summarySection(summary) +
        skillCatalogSection(skillCatalog) +
        customPrompt.trim(),
    );
}

// Progressive disclosure (legacy agent_py configuration.py:62-76): only
// `name: description` lines ride in the system prompt; the load_skill tool
// (already part of builtinTools) returns the full body on demand.
function skillCatalogSection(catalog: string): string {
  if (catalog.trim() === "") return "";
  return `\n\n## Available skills\n${catalog.trim()}\nUse the load_skill tool with the skill name to read its full instructions before following them.`;
}

// Best-effort skill catalog fetch: storage errors degrade to no catalog,
// never to a failed chat turn.
async function loadSkillCatalog(): Promise<string> {
  try {
    return await getSkillCatalogPrompt();
  } catch {
    return "";
  }
}

// Best-effort custom-instruction fetch: storage errors degrade to no section,
// never to a failed chat turn.
async function loadCustomPrompt(): Promise<string> {
  try {
    return await getChatPromptSection();
  } catch {
    return "";
  }
}

interface ChatTools {
  tools: Record<string, Tool>;
  // MCP-sourced tool names — audited calls are tagged "mcp" vs "builtin".
  mcpNames: Set<string>;
}

async function buildChatTools(): Promise<ChatTools> {
  const mcpTools = await getLogMcpTools();
  return {
    tools: { ...mcpTools, ...builtinTools },
    mcpNames: new Set(Object.keys(mcpTools)),
  };
}

export interface ChatReference {
  title: string;
  source: string;
  score: number;
  excerpt: string;
  /** Document classification from the knowledge index (legacy knowledgeType metadata). */
  knowledgeType?: KnowledgeType;
}

const REFERENCE_EXCERPT_CHARS = 200;

// Port of the Python retrieval tool's citation sources (agent_py
// retrieval/tool.py): the docs that grounded this turn, with title, source
// tag, relevance score, a whitespace-normalized excerpt and the chunk's
// knowledge classification (drives the reference chip label in the UI).
export function toReferences(docs: RetrievedDoc[]): ChatReference[] {
  return docs.map((doc) => {
    const metaTitle = doc.metadata.title;
    const title =
      typeof metaTitle === "string" && metaTitle !== ""
        ? metaTitle
        : doc.source || "knowledge base";
    const normalized = doc.content.split(/\s+/).join(" ").trim();
    const excerpt =
      normalized.length <= REFERENCE_EXCERPT_CHARS
        ? normalized
        : `${normalized.slice(0, REFERENCE_EXCERPT_CHARS - 3)}...`;
    const knowledgeType = isKnowledgeType(doc.metadata.knowledgeType)
      ? doc.metadata.knowledgeType
      : undefined;
    return {
      title,
      source: doc.source,
      score: Number(doc.score.toFixed(4)),
      excerpt,
      ...(knowledgeType ? { knowledgeType } : {}),
    };
  });
}

export interface ChatResult {
  answer: string;
  a2ui?: unknown[];
  references?: ChatReference[];
  /** Model reasoning (extended thinking), when the provider emits any. */
  reasoning?: string;
}

// ============ tool-call audit (legacy _persist_tool_call_audit) ============

// Storage cap for the audit input/result excerpts (legacy resultSummary cut
// at 500 chars too).
export const AUDIT_TEXT_CHARS = 500;

// Pure: normalize any tool input/output value into a single-line, capped
// summary safe for the audit row.
export function summarizeAuditText(value: unknown): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  const normalized = text.split(/\s+/).join(" ").trim();
  if (normalized.length <= AUDIT_TEXT_CHARS) return normalized;
  return `${normalized.slice(0, AUDIT_TEXT_CHARS - 3)}...`;
}

interface ToolAuditInput {
  sessionId: string;
  turnIndex: number;
  toolName: string;
  source: "builtin" | "mcp";
  input: unknown;
  resultText: unknown;
  status: "success" | "error";
  durationMs: number;
}

// Fire-and-forget: an audit write must never fail or delay the answer.
function recordToolAudit(input: ToolAuditInput): void {
  prisma.toolCallAudit
    .create({
      data: {
        sessionId: input.sessionId,
        turnIndex: input.turnIndex,
        toolName: input.toolName,
        source: input.source,
        inputJson: { input: summarizeAuditText(input.input) },
        resultText: summarizeAuditText(input.resultText),
        status: input.status,
        durationMs: input.durationMs,
      },
    })
    .catch((e: unknown) => {
      console.warn(
        "[chat] tool-call audit write failed:",
        e instanceof Error ? e.message : String(e),
      );
    });
}

// Non-streaming chat.
export async function chat(id: string, question: string): Promise<ChatResult> {
  const mem = getSimpleMemory(id);
  const history = mem.getMessages();
  const docs = await retrieve(question);
  const documents = docs.map((d) => d.content).join("\n");
  const references = toReferences(docs);
  const { tools, mcpNames } = await buildChatTools();
  const system = buildSystemPrompt(
    documents,
    mem.getSummary(),
    await loadSkillCatalog(),
    await loadCustomPrompt(),
  );

  const result = await generateText({
    model: quickModel,
    system,
    messages: [
      ...history,
      { role: "user", content: question } satisfies ModelMessage,
    ],
    tools,
    stopWhen: isStepCount(25),
    providerOptions,
  });

  // Memory keeps the raw tagged text so the conversation retains what was
  // rendered (surface actions are handled out of band by /api/a2ui_action).
  const raw = result.text;
  mem.setMessages({ role: "user", content: question });
  mem.setMessages({ role: "assistant", content: raw });
  void mem.maybeSummarize();

  // Aggregate reasoning + audit trail from the completed steps. The
  // non-streaming path has no per-tool timing, so durationMs stays 0.
  const reasoningParts: string[] = [];
  let turnIndex = 0;
  for (const step of result.steps) {
    if (step.reasoningText) reasoningParts.push(step.reasoningText);
    for (const call of step.toolCalls) {
      const matched = step.toolResults.find(
        (r) => r.toolCallId === call.toolCallId,
      );
      const failed = step.content.some(
        (p) => p.type === "tool-error" && p.toolCallId === call.toolCallId,
      );
      recordToolAudit({
        sessionId: id,
        turnIndex: turnIndex++,
        toolName: call.toolName,
        source: mcpNames.has(call.toolName) ? "mcp" : "builtin",
        input: call.input,
        resultText: matched ? matched.output : failed ? "tool failed" : "",
        status: failed ? "error" : "success",
        durationMs: 0,
      });
    }
  }
  const reasoning = reasoningParts.join("\n\n");

  const extracted = extractA2ui(raw);
  let a2ui = extracted.messages;
  if (!a2ui && extracted.error) {
    a2ui = await correctA2uiBlock({
      model: quickModel,
      system,
      history,
      question,
      rawAnswer: raw,
      error: extracted.error,
    });
  }
  return {
    answer: extracted.cleanText,
    a2ui,
    ...(references.length > 0 ? { references } : {}),
    ...(reasoning !== "" ? { reasoning } : {}),
  };
}

export type ChatStreamEvent =
  | { type: "text"; content: string }
  | { type: "notice"; content: string }
  | { type: "references"; references: ChatReference[] }
  | { type: "a2ui"; messages: unknown[] }
  /** Reasoning (extended thinking) delta — legacy "reasoning.delta". */
  | { type: "reasoning"; content: string }
  /** Tool-call lifecycle — legacy "tool.call" (state: call → result/error). */
  | {
      type: "tool";
      id: string;
      name: string;
      state: "call" | "result" | "error";
    };

// Completed tool-call info handed to the audit collector (legacy persisted
// the full ChatAgentToolCall payload; here the generator pairs the call with
// its output and wall-clock duration).
export interface ChatToolEvent {
  id: string;
  name: string;
  state: "result" | "error";
  input: unknown;
  resultText: unknown;
  durationMs: number;
}

// Mutable view of the raw assistant text (tags included) for callers that
// need to persist partial output when the stream is cut short.
export interface ChatStreamProgress {
  text: string;
}

export interface ChatStreamPartsHooks {
  /** Called once per completed tool call (result or error). */
  onToolEvent?: (event: ChatToolEvent) => void;
  /** Invalid a2ui block → corrective retry events; default: honest notice. */
  handleInvalidBlock?: (
    block: string,
    rawTextSoFar: string,
  ) => AsyncIterable<ChatStreamEvent>;
  progress?: ChatStreamProgress;
}

export interface ChatStreamPartsResult {
  /** Raw assistant text including any <a2ui-json> tags — the memory body. */
  text: string;
  /** Concatenated reasoning deltas for the turn ("" when none). */
  reasoning: string;
}

// Pure-of-model stream mapping: turns AI SDK fullStream parts into the
// OnCall ChatStreamEvent protocol (text through the a2ui stream filter,
// reasoning deltas, tool lifecycle), so the event ordering is testable with
// a fake part stream. Returns the raw text + reasoning for memory upkeep.
export async function* processChatStreamParts(
  parts: AsyncIterable<TextStreamPart<ToolSet>>,
  hooks: ChatStreamPartsHooks = {},
): AsyncGenerator<ChatStreamEvent, ChatStreamPartsResult> {
  const filter = createA2uiStreamFilter();
  let full = "";
  let reasoning = "";
  // toolCallId → wall-clock start ms, to time completed calls for the audit.
  const startedAt = new Map<string, number>();

  for await (const part of parts) {
    if (part.type === "text-delta") {
      if (part.text === "") continue;
      full += part.text;
      if (hooks.progress) hooks.progress.text = full;
      const out = filter.push(part.text);
      if (out.text) yield { type: "text", content: out.text };
      for (const block of out.blocks) {
        const parsed = parseA2uiBlock(block);
        if (parsed.messages) {
          yield { type: "a2ui", messages: parsed.messages };
          continue;
        }
        if (hooks.handleInvalidBlock) {
          yield* hooks.handleInvalidBlock(block, full);
        } else {
          yield {
            type: "notice",
            content:
              "\n\n> Failed to render the interactive view for this reply.",
          };
        }
      }
    } else if (part.type === "reasoning-delta") {
      if (part.text === "") continue;
      reasoning += part.text;
      yield { type: "reasoning", content: part.text };
    } else if (part.type === "tool-call") {
      startedAt.set(part.toolCallId, Date.now());
      yield {
        type: "tool",
        id: part.toolCallId,
        name: part.toolName,
        state: "call",
      };
    } else if (part.type === "tool-result") {
      const at = startedAt.get(part.toolCallId);
      if (at !== undefined) startedAt.delete(part.toolCallId);
      yield {
        type: "tool",
        id: part.toolCallId,
        name: part.toolName,
        state: "result",
      };
      hooks.onToolEvent?.({
        id: part.toolCallId,
        name: part.toolName,
        state: "result",
        input: part.input,
        resultText: part.output,
        durationMs: at !== undefined ? Date.now() - at : 0,
      });
    } else if (part.type === "tool-error") {
      const at = startedAt.get(part.toolCallId);
      if (at !== undefined) startedAt.delete(part.toolCallId);
      yield {
        type: "tool",
        id: part.toolCallId,
        name: part.toolName,
        state: "error",
      };
      hooks.onToolEvent?.({
        id: part.toolCallId,
        name: part.toolName,
        state: "error",
        input: part.input,
        resultText:
          part.error instanceof Error ? part.error.message : String(part.error),
        durationMs: at !== undefined ? Date.now() - at : 0,
      });
    }
    // Other part types (step boundaries, sources, usage, raw provider
    // metadata) are internal plumbing and never surface as events.
  }

  const rest = filter.flush();
  if (rest.startsWith(A2UI_OPEN_TAG)) {
    // Unterminated block at stream end: treat as an invalid block instead
    // of leaking raw JSON into the visible text.
    const block = rest.slice(A2UI_OPEN_TAG.length);
    const parsed = parseA2uiBlock(block);
    if (parsed.messages) {
      yield { type: "a2ui", messages: parsed.messages };
    } else if (hooks.handleInvalidBlock) {
      yield* hooks.handleInvalidBlock(block, full);
    } else {
      yield {
        type: "notice",
        content: "\n\n> Failed to render the interactive view for this reply.",
      };
    }
  } else if (rest) {
    yield { type: "text", content: rest };
  }

  return { text: full, reasoning };
}

// Streaming chat. Yields pass-through text chunks immediately; <a2ui-json>
// blocks are buffered by the stream filter, validated, and yielded as a
// single a2ui event (invalid blocks get one corrective retry, then degrade
// to a notice). Reasoning deltas and tool-call lifecycle events stream as
// their own event types; completed tool calls are audit-logged
// fire-and-forget. Memory is persisted after the stream completes.
export async function* chatStream(
  id: string,
  question: string,
): AsyncGenerator<ChatStreamEvent> {
  const mem = getSimpleMemory(id);
  const history = mem.getMessages();
  const docs = await retrieve(question);
  const documents = docs.map((d) => d.content).join("\n");
  const references = toReferences(docs);
  const { tools, mcpNames } = await buildChatTools();
  const system = buildSystemPrompt(
    documents,
    mem.getSummary(),
    await loadSkillCatalog(),
    await loadCustomPrompt(),
  );

  // Grounding sources for this turn, emitted before any text so the client
  // can render them while the reply streams in.
  if (references.length > 0) {
    yield { type: "references", references };
  }

  // streamText swallows errors into onError by default and just ends the
  // text stream, which the client would see as an empty reply — capture and
  // rethrow so the SSE route emits a real error event.
  let streamError: unknown;
  const result = streamText({
    model: quickModel,
    system,
    messages: [
      ...history,
      { role: "user", content: question } satisfies ModelMessage,
    ],
    tools,
    stopWhen: isStepCount(25),
    providerOptions,
    onError: ({ error }) => {
      streamError = error;
    },
  });

  let turnIndex = 0;
  const onToolEvent = (ev: ChatToolEvent): void => {
    recordToolAudit({
      sessionId: id,
      turnIndex: turnIndex++,
      toolName: ev.name,
      source: mcpNames.has(ev.name) ? "mcp" : "builtin",
      input: ev.input,
      resultText: ev.resultText,
      status: ev.state === "error" ? "error" : "success",
      durationMs: ev.durationMs,
    });
  };

  // Invalid a2ui blocks get exactly one corrective model retry, then the
  // generator's own honest-notice fallback.
  const handleInvalidBlock = async function* (
    block: string,
    rawTextSoFar: string,
  ): AsyncGenerator<ChatStreamEvent> {
    const parsed = parseA2uiBlock(block);
    const corrected = await correctA2uiBlock({
      model: quickModel,
      system,
      history,
      question,
      rawAnswer: rawTextSoFar,
      error: parsed.error ?? "unknown validation error",
    });
    if (corrected) {
      yield { type: "a2ui", messages: corrected };
    } else {
      yield {
        type: "notice",
        content: "\n\n> Failed to render the interactive view for this reply.",
      };
    }
  };

  const progress: ChatStreamProgress = { text: "" };
  try {
    yield* processChatStreamParts(result.fullStream, {
      onToolEvent,
      handleInvalidBlock,
      progress,
    });
    if (streamError !== undefined) {
      throw streamError instanceof Error
        ? streamError
        : new Error(String(streamError));
    }
  } finally {
    // Persist when the generator ran to completion OR was cut short by the
    // consumer (client abort), as long as any text arrived — the legacy
    // behavior kept the partial answer too.
    if (progress.text) {
      mem.setMessages({ role: "user", content: question });
      mem.setMessages({ role: "assistant", content: progress.text });
      void mem.maybeSummarize();
    }
  }
}
