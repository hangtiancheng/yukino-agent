// Step executor
// Uses AI SDK generateText with tools + stopWhen for multi-step tool execution
// within a single plan step, plus the ported legacy guardrail "the plan may
// only use discovered tools" (agent_py aiops/diagnostics.py:829-863 —
// _validated_plan dropped any step whose `tool` was not in the discovered
// set). Plan steps here are free text, so the deterministic counterpart
// scans the step text for tool-style identifiers and the graph node marks
// steps referencing undiscovered tools as skipped with an honest observation
// instead of letting the model narrate a tool it never called.
// (Both guardrails were missing from the first migration pass and are restored here.)
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

// Tool-style identifiers in prose: explicit `tool <name>` mentions — the
// phrasing the AI Ops prompts consistently use for tool calls ("call the
// tool query_prometheus_alerts …"). Only snake_case identifiers (≥2 word
// parts) count, so ordinary prose ("the tool time", "this tool helps") is
// never mistaken for a tool reference. Deliberately conservative: false
// skips are worse than the narration risk this guard exists for.
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
