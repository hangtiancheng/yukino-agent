// Step executor
// Uses AI SDK generateText with tools + stopWhen for multi-step tool execution
// within a single plan step.
import {
  generateText,
  isStepCount,
  type LanguageModelUsage,
  type Tool,
} from "ai";
import { quickModel, providerOptions } from "@/lib/ai/models";

export interface StepResult {
  text: string;
  // Token accounting for Langfuse generation telemetry.
  usage: LanguageModelUsage;
}

// P2-17 fix: pass providerOptions so Anthropic extended thinking is
// consistently enabled for step execution (same as chat & planner).
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
