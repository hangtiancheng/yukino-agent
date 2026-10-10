import {
  generateText,
  isStepCount,
  type LanguageModelUsage,
  type Tool,
} from "ai";
import { quickModel, providerOptions } from "@/lib/ai/models";

export interface StepToolAudit {
  toolName: string;
  input: unknown;
  resultText: unknown;
  status: "success" | "error";
}

export interface StepResult {
  text: string;
  usage: LanguageModelUsage;
  toolAudits: StepToolAudit[];
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
  // Legacy persisted one aiops_tool_call_audits row per diagnostic tool call;
  // flatten the step trace so the graph node can record the same audit trail.
  const toolAudits: StepToolAudit[] = [];
  for (const stepResult of result.steps) {
    for (const call of stepResult.toolCalls) {
      const matched = stepResult.toolResults.find(
        (r) => r.toolCallId === call.toolCallId,
      );
      const failed = stepResult.content.some(
        (part) =>
          part.type === "tool-error" && part.toolCallId === call.toolCallId,
      );
      toolAudits.push({
        toolName: call.toolName,
        input: call.input,
        resultText: matched ? matched.output : failed ? "tool failed" : "",
        status: failed ? "error" : "success",
      });
    }
  }
  return { text: result.text, usage: result.usage, toolAudits };
}
