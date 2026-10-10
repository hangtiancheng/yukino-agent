import {
  generateText,
  isStepCount,
  type LanguageModelUsage,
  type Tool,
} from "ai";
import { quickModel, providerOptions } from "@/lib/ai/models";

export interface StepResult {
  text: string;
  usage: LanguageModelUsage;
}

const TOOL_MENTION_PATTERN = /\btool\s+`?([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`?/g;

export function findUnknownToolReferences(
  step: string,
  discoveredTools: readonly string[],
): string[] {
  const known = new Set(discoveredTools);
  const candidates = new Set<string>();
  for (const match of step.matchAll(TOOL_MENTION_PATTERN)) {
    candidates.add(match[1]);
  }
  return [...candidates].filter((name) => !known.has(name));
}

export async function executeStep(
  step: string,
  tools: Record<string, Tool>,
): Promise<StepResult> {
  const result = await generateText({
    model: quickModel,
    prompt: step,
    tools,
    stopWhen: isStepCount(10),
    providerOptions,
  });
  return { text: result.text, usage: result.usage };
}
