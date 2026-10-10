import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { config } from "@/lib/config";
import type { LanguageModel } from "ai";

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
    } catch {}

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
