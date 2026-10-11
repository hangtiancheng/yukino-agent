import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

import { config } from "@/lib/config";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

// Anthropic occasionally emits `thinking` blocks without a `signature`, which
// the SDK rejects. Backfill an empty signature so the response parses.
function patchAnthropicThinkingSignatures(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.type !== "message") {
    return null;
  }
  const content = parsed.content;
  if (!isUnknownArray(content)) {
    return null;
  }
  let changed = false;
  for (const block of content) {
    if (
      isRecord(block) &&
      block.type === "thinking" &&
      typeof block.signature !== "string"
    ) {
      block.signature = "";
      changed = true;
    }
  }
  return changed ? JSON.stringify(parsed) : null;
}

function createAnthropicFetch(): typeof globalThis.fetch {
  const baseFetch = globalThis.fetch;
  return async (input, init) => {
    const res = await baseFetch(input, init);
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      return res;
    }

    const body = await res.text();
    const patched = patchAnthropicThinkingSignatures(body) ?? body;

    const headers = new Headers(res.headers);
    if (patched !== body) {
      headers.delete("content-length");
      headers.delete("content-encoding");
    }
    return new Response(patched, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  };
}

function resolveThinkModel(): LanguageModel {
  if (config.provider === "anthropic") {
    const provider = createAnthropic({
      baseURL: config.anthropic.think.baseURL,
      apiKey: config.anthropic.think.apiKey,
      fetch: createAnthropicFetch(),
    });
    return provider(config.anthropic.think.model);
  }
  const provider = createOpenAI({
    baseURL: config.openai.think.baseURL,
    apiKey: config.openai.think.apiKey,
  });
  return provider.chat(config.openai.think.model);
}

function resolveQuickModel(): LanguageModel {
  if (config.provider === "anthropic") {
    const provider = createAnthropic({
      baseURL: config.anthropic.quick.baseURL,
      apiKey: config.anthropic.quick.apiKey,
      fetch: createAnthropicFetch(),
    });
    return provider(config.anthropic.quick.model);
  }
  const provider = createOpenAI({
    baseURL: config.openai.quick.baseURL,
    apiKey: config.openai.quick.apiKey,
  });
  return provider.chat(config.openai.quick.model);
}

export const thinkModel = resolveThinkModel();
export const quickModel = resolveQuickModel();

export function quickModelId(): string {
  return config.provider === "anthropic"
    ? config.anthropic.quick.model
    : config.openai.quick.model;
}

export const providerOptions =
  config.provider === "anthropic"
    ? {
        anthropic: {
          thinking: config.anthropic.thinking
            ? ({
                type: "enabled",
                budgetTokens: config.anthropic.maxOutputTokens - 1,
              } as const)
            : ({ type: "disabled" } as const),
        },
      }
    : undefined;
