// Chat pipeline: RAG retrieval + system prompt + ReAct agent (streamText/generateText with tools + maxSteps).
import {
  streamText,
  generateText,
  type Tool,
  type ModelMessage,
  isStepCount,
} from "ai";
import { quickModel, providerOptions } from "../models";
import { A2UI_OPEN_TAG, A2UI_PROMPT_SECTION } from "../a2ui/prompt";
import { correctA2uiBlock } from "../a2ui/correct";
import {
  createA2uiStreamFilter,
  extractA2ui,
  parseA2uiBlock,
} from "../a2ui/extract";
import { builtinTools } from "../tools";
import { getLogMcpTools } from "../tools/query-log";
import { retrieve } from "@/lib/redis/retriever";
import { getSimpleMemory } from "@/lib/memory";

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
`;

function buildSystemPrompt(documents: string): string {
  return SYSTEM_PROMPT.replace(
    "{date}",
    new Date().toLocaleString("en-US"),
  ).replace("{documents}", documents);
}

async function buildChatTools(): Promise<Record<string, Tool>> {
  const mcpTools = await getLogMcpTools();
  return { ...mcpTools, ...builtinTools };
}

export interface ChatResult {
  answer: string;
  a2ui?: unknown[];
}

// Non-streaming chat.
export async function chat(id: string, question: string): Promise<ChatResult> {
  const mem = getSimpleMemory(id);
  const history = mem.getMessages();
  const docs = await retrieve(question);
  const documents = docs.map((d) => d.content).join("\n");
  const tools = await buildChatTools();
  const system = buildSystemPrompt(documents);

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
  return { answer: extracted.cleanText, a2ui };
}

export type ChatStreamEvent =
  | { type: "text"; content: string }
  | { type: "notice"; content: string }
  | { type: "a2ui"; messages: unknown[] };

// Streaming chat. Yields pass-through text chunks immediately; <a2ui-json>
// blocks are buffered by the stream filter, validated, and yielded as a
// single a2ui event (invalid blocks get one corrective retry, then degrade
// to a notice). Memory is persisted after the stream completes.
export async function* chatStream(
  id: string,
  question: string,
): AsyncGenerator<ChatStreamEvent> {
  const mem = getSimpleMemory(id);
  const history = mem.getMessages();
  const docs = await retrieve(question);
  const documents = docs.map((d) => d.content).join("\n");
  const tools = await buildChatTools();
  const system = buildSystemPrompt(documents);

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

  const filter = createA2uiStreamFilter();
  let full = "";

  async function* handleBlock(block: string): AsyncGenerator<ChatStreamEvent> {
    const parsed = parseA2uiBlock(block);
    if (parsed.messages) {
      yield { type: "a2ui", messages: parsed.messages };
      return;
    }
    const corrected = await correctA2uiBlock({
      model: quickModel,
      system,
      history,
      question,
      rawAnswer: full,
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
  }

  try {
    for await (const chunk of result.textStream) {
      full += chunk;
      const out = filter.push(chunk);
      if (out.text) {
        yield { type: "text", content: out.text };
      }
      for (const block of out.blocks) {
        yield* handleBlock(block);
      }
    }
    const rest = filter.flush();
    if (rest.startsWith(A2UI_OPEN_TAG)) {
      // Unterminated block at stream end: treat as an invalid block instead
      // of leaking raw JSON into the visible text.
      yield* handleBlock(rest.slice(A2UI_OPEN_TAG.length));
    } else if (rest) {
      yield { type: "text", content: rest };
    }
    if (streamError !== undefined) {
      throw streamError instanceof Error
        ? streamError
        : new Error(String(streamError));
    }
  } finally {
    if (full) {
      mem.setMessages({ role: "user", content: question });
      mem.setMessages({ role: "assistant", content: full });
    }
  }
}
