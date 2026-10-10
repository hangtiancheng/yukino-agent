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

const LOG_TOPIC_REGION = process.env.LOG_TOPIC_REGION ?? "";
const LOG_TOPIC_ID = process.env.LOG_TOPIC_ID ?? "";
const logTopicLine =
  LOG_TOPIC_REGION && LOG_TOPIC_ID
    ? `  • Log topic region: ${LOG_TOPIC_REGION}; log topic id: ${LOG_TOPIC_ID}`
    : "";

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

function skillCatalogSection(catalog: string): string {
  if (catalog.trim() === "") return "";
  return `\n\n## Available skills\n${catalog.trim()}\nUse the load_skill tool with the skill name to read its full instructions before following them.`;
}

async function loadSkillCatalog(): Promise<string> {
  try {
    return await getSkillCatalogPrompt();
  } catch {
    return "";
  }
}

async function loadCustomPrompt(): Promise<string> {
  try {
    return await getChatPromptSection();
  } catch {
    return "";
  }
}

interface ChatTools {
  tools: Record<string, Tool>;
  mcpNames: Set<string>;
}

async function buildChatTools(): Promise<ChatTools> {
  const mcpTools = await getLogMcpTools();
  return {
    tools: { ...mcpTools, ...builtinTools },
    mcpNames: new Set(Object.keys(mcpTools)),
  };
}

export interface ChatReferenceStages {
  vectorRank?: number;
  vectorScore?: number;
  bm25Rank?: number;
  bm25Score?: number;
  rerankRank?: number;
  rerankScore?: number;
}

export interface ChatReference {
  title: string;
  source: string;
  score: number;
  excerpt: string;
  knowledgeType?: KnowledgeType;
  stages?: ChatReferenceStages;
}

const REFERENCE_EXCERPT_CHARS = 200;

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
      ...(doc.stages ? { stages: doc.stages } : {}),
    };
  });
}

export interface ChatResult {
  answer: string;
  a2ui?: unknown[];
  references?: ChatReference[];
  reasoning?: string;
}

export {
  AUDIT_TEXT_CHARS,
  summarizeAuditText,
  recordToolAudit,
  type ToolAuditInput,
} from "@/lib/ai/tool-audit";
import { recordToolAudit } from "@/lib/ai/tool-audit";

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

  const raw = result.text;
  mem.setMessages({ role: "user", content: question });
  mem.setMessages({ role: "assistant", content: raw });
  void mem.maybeSummarize();

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
  | { type: "reasoning"; content: string }
  | {
      type: "tool";
      id: string;
      name: string;
      state: "call" | "result" | "error";
    };

export interface ChatToolEvent {
  id: string;
  name: string;
  state: "result" | "error";
  input: unknown;
  resultText: unknown;
  durationMs: number;
}

export interface ChatStreamProgress {
  text: string;
}

export interface ChatStreamPartsHooks {
  onToolEvent?: (event: ChatToolEvent) => void;
  handleInvalidBlock?: (
    block: string,
    rawTextSoFar: string,
  ) => AsyncIterable<ChatStreamEvent>;
  progress?: ChatStreamProgress;
}

export interface ChatStreamPartsResult {
  text: string;
  reasoning: string;
}

export async function* processChatStreamParts(
  parts: AsyncIterable<TextStreamPart<ToolSet>>,
  hooks: ChatStreamPartsHooks = {},
): AsyncGenerator<ChatStreamEvent, ChatStreamPartsResult> {
  const filter = createA2uiStreamFilter();
  let full = "";
  let reasoning = "";
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
  }

  const rest = filter.flush();
  if (rest.startsWith(A2UI_OPEN_TAG)) {
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

  if (references.length > 0) {
    yield { type: "references", references };
  }

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
    if (progress.text) {
      mem.setMessages({ role: "user", content: question });
      mem.setMessages({ role: "assistant", content: progress.text });
      void mem.maybeSummarize();
    }
  }
}
