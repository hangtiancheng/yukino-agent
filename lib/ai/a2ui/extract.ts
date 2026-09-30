// Server-side A2UI block handling: tag extraction from full LLM output,
// zod validation via the web_core protocol schemas, and a stateful streaming
// filter that strips <a2ui-json> blocks out of a text-chunk stream.
import { A2uiMessageListSchema } from "@a2ui/web_core/v0_9";

import { A2UI_CLOSE_TAG, A2UI_OPEN_TAG } from "./prompt";

export interface A2uiParseResult {
  messages?: unknown[];
  error?: string;
}

export interface A2uiExtractResult extends A2uiParseResult {
  cleanText: string;
}

// Validates a parsed message array with the protocol list schema (web_core
// ships its own zod v3 instance — never compose this schema into app-level
// zod/v4 combinators).
export function validateA2uiMessages(messages: unknown[]): A2uiParseResult {
  const result = A2uiMessageListSchema.safeParse(messages);
  if (!result.success) {
    return {
      error: result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    };
  }
  return { messages };
}

// Parses the raw inner content of an <a2ui-json> block.
export function parseA2uiBlock(raw: string): A2uiParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch (e) {
    return {
      error: `invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  return validateA2uiMessages(Array.isArray(parsed) ? parsed : [parsed]);
}

// Extracts and validates the A2UI block from a complete LLM response.
// No tags present is not an error — the reply is plain markdown.
export function extractA2ui(text: string): A2uiExtractResult {
  const start = text.indexOf(A2UI_OPEN_TAG);
  if (start === -1) {
    return { cleanText: text.trim() };
  }
  const end = text.indexOf(A2UI_CLOSE_TAG, start + A2UI_OPEN_TAG.length);
  if (end === -1) {
    return {
      cleanText: text.slice(0, start).trim(),
      error: `output opened ${A2UI_OPEN_TAG} but never closed it with ${A2UI_CLOSE_TAG}`,
    };
  }
  const cleanText = (
    text.slice(0, start) + text.slice(end + A2UI_CLOSE_TAG.length)
  ).trim();
  const result = parseA2uiBlock(text.slice(start + A2UI_OPEN_TAG.length, end));
  return { cleanText, ...result };
}

export interface A2uiFilterOutput {
  /** Pass-through text safe to forward to the client immediately. */
  text?: string;
  /** Raw inner contents of completed <a2ui-json> blocks (tags stripped). */
  blocks: string[];
}

// Longest k (< tag.length) such that `s` ends with the first k chars of `tag`.
function partialTagSuffixLength(s: string, tag: string): number {
  const max = Math.min(s.length, tag.length - 1);
  for (let k = max; k > 0; k--) {
    if (s.endsWith(tag.slice(0, k))) {
      return k;
    }
  }
  return 0;
}

// Stateful stream filter: forwards text immediately (holding back only tails
// that could be the start of an opening tag split across chunks) and buffers
// tagged block contents silently until the closing tag arrives.
export function createA2uiStreamFilter(): {
  push(chunk: string): A2uiFilterOutput;
  flush(): string;
} {
  let buffer = "";
  let inBlock = false;

  return {
    push(chunk: string): A2uiFilterOutput {
      buffer += chunk;
      let text = "";
      const blocks: string[] = [];
      while (true) {
        if (inBlock) {
          const closeIdx = buffer.indexOf(A2UI_CLOSE_TAG);
          if (closeIdx === -1) {
            break;
          }
          blocks.push(buffer.slice(0, closeIdx));
          buffer = buffer.slice(closeIdx + A2UI_CLOSE_TAG.length);
          inBlock = false;
        } else {
          const openIdx = buffer.indexOf(A2UI_OPEN_TAG);
          if (openIdx === -1) {
            const hold = partialTagSuffixLength(buffer, A2UI_OPEN_TAG);
            text += buffer.slice(0, buffer.length - hold);
            buffer = buffer.slice(buffer.length - hold);
            break;
          }
          text += buffer.slice(0, openIdx);
          buffer = buffer.slice(openIdx + A2UI_OPEN_TAG.length);
          inBlock = true;
        }
      }
      return { text: text || undefined, blocks };
    },
    // Stream ended: an unterminated block is surfaced back as plain text
    // (with its opening tag restored) rather than silently dropped.
    flush(): string {
      const rest = inBlock ? A2UI_OPEN_TAG + buffer : buffer;
      buffer = "";
      inBlock = false;
      return rest;
    },
  };
}
