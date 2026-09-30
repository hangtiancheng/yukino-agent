// Supports both OpenAI-compatible providers (OpenAI, etc.) and Anthropic.
// Select provider via LLM_PROVIDER env var: "openai" (default) | "anthropic".
// 'think' is used for planner/replanner, 'quick' is used for executor/chat.
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { config } from "@/lib/config";
import type { LanguageModel } from "ai";

// Some Anthropic-compatible gateways emit `thinking` content blocks WITHOUT the
// `signature` field that the official Anthropic API always includes.
// @ai-sdk/anthropic v4 marks `signature` as REQUIRED on non-streaming message
// responses (anthropicResponseSchema), so the SDK rejects the body with
// "Invalid JSON response" — which surfaces to the HTTP client as an EMPTY error
// message. This fetch wrapper backfills the missing `signature` before the SDK
// parses the body. Streaming (SSE) responses are passed through unchanged
// because the streaming chunk schema does not require `signature`.
function createAnthropicFetch(): typeof globalThis.fetch {
  const baseFetch = globalThis.fetch;
  return async (input, init) => {
    const res = await baseFetch(input, init);
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) return res;

    const body = await res.text();
    let patched = body;
    try {
      const json = JSON.parse(body);
      if (json?.type === "message" && Array.isArray(json.content)) {
        let changed = false;
        for (const block of json.content) {
          if (
            block &&
            typeof block === "object" &&
            block.type === "thinking" &&
            typeof block.signature !== "string"
          ) {
            block.signature = "";
            changed = true;
          }
        }
        if (changed) patched = JSON.stringify(json);
      }
    } catch {
      // Not valid JSON or unexpected shape — return original body unchanged.
    }

    const headers = new Headers(res.headers);
    if (patched !== body) {
      // Body bytes changed; drop length/encoding headers so the new Response
      // is internally consistent.
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
  // Anthropic
  if (config.provider === "anthropic") {
    const provider = createAnthropic({
      baseURL: config.anthropic.think.baseURL,
      apiKey: config.anthropic.think.apiKey,
      fetch: createAnthropicFetch(),
    });
    return provider(config.anthropic.think.model);
  }
  // OpenAI
  const provider = createOpenAI({
    baseURL: config.openai.think.baseURL,
    apiKey: config.openai.think.apiKey,
  });
  return provider.chat(config.openai.think.model);
}

function resolveQuickModel(): LanguageModel {
  // Anthropic
  if (config.provider === "anthropic") {
    const provider = createAnthropic({
      baseURL: config.anthropic.quick.baseURL,
      apiKey: config.anthropic.quick.apiKey,
      fetch: createAnthropicFetch(),
    });
    return provider(config.anthropic.quick.model);
  }
  // OpenAI
  const provider = createOpenAI({
    baseURL: config.openai.quick.baseURL,
    apiKey: config.openai.quick.apiKey,
  });
  return provider.chat(config.openai.quick.model);
}

// ToolCallingChatModel (LanguageModelV4), used for streamText/generateText
export const thinkModel = resolveThinkModel();
export const quickModel = resolveQuickModel();

// Anthropic provider options for extended thinking (mirrors yukino/src/llm/anthropic.ts L310-322)
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
