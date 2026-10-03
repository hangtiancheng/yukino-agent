// LangGraph orchestration of the Plan-Execute-Replan loop:
//
//   planner → executor (one plan step per node run) → replanner → uiify | executor | exhausted
//
// The replanner intervenes after every full plan round: done → uiify (final
// report + optional A2UI surface), budget left → executor with the remaining
// steps, budget spent → exhausted. Nodes publish PlanExecuteEvent payloads to
// the "custom" stream via writer(); index.ts replays that stream to callers.
// LLM calls are recorded as Langfuse generations (no-op when unconfigured).
import {
  Annotation,
  END,
  START,
  StateGraph,
  getWriter,
} from "@langchain/langgraph";
import {
  generateText,
  Output,
  type LanguageModel,
  type LanguageModelUsage,
  type Tool,
} from "ai";
import { z } from "zod/v4";
import { observeGeneration } from "@/lib/observability";
import { providerOptions, quickModel, thinkModel } from "@/lib/ai/models";
import { correctA2uiBlock } from "@/lib/ai/a2ui/correct";
import { extractA2ui } from "@/lib/ai/a2ui/extract";
import {
  A2UI_CLOSE_TAG,
  A2UI_OPEN_TAG,
  A2UI_PROMPT_SECTION,
} from "@/lib/ai/a2ui/prompt";
import { builtinTools } from "@/lib/ai/tools";
import { getLogMcpTools } from "@/lib/ai/tools/query-log";
import { executeStep } from "./executor";
import type { PlanExecuteEvent } from "./events";

export const MAX_ITERATIONS = 20;

// Safety net only — the iteration counter in afterReplanner is the real
// budget. Each round costs one superstep per plan step plus the replanner, so
// allow a generous per-round step count before LangGraph itself aborts.
export const RECURSION_LIMIT = MAX_ITERATIONS * 25 + 25;

const overwrite = <T>(_left: T, right: T): T => right;

const OpsState = Annotation.Root({
  // The analysis task (defaults to the AI Ops alert-analysis query).
  query: Annotation<string>(),
  // Steps of the current round; the replanner replaces it with the remaining steps.
  plan: Annotation<string[]>({ reducer: overwrite, default: () => [] }),
  // Next step to execute within the current plan.
  stepIndex: Annotation<number>({ reducer: overwrite, default: () => 0 }),
  // Outputs of every executed step across all rounds.
  detail: Annotation<string[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  // Completed replan rounds.
  iteration: Annotation<number>({ reducer: overwrite, default: () => 0 }),
  done: Annotation<boolean>({ reducer: overwrite, default: () => false }),
  // Final report produced by the replanner when done.
  report: Annotation<string>({ reducer: overwrite, default: () => "" }),
});

type OpsGraphState = typeof OpsState.State;
type OpsGraphUpdate = typeof OpsState.Update;

const planSchema = z.object({
  steps: z.array(z.string()).describe("Ordered steps to accomplish the task"),
});

const replanSchema = z.object({
  done: z.boolean().describe("Whether the overall task is complete"),
  remaining: z
    .array(z.string())
    .describe("Remaining steps if not done; empty when done"),
  summary: z.string().describe("Final report / summary when done"),
});

async function buildTools(): Promise<Record<string, Tool>> {
  const mcp = await getLogMcpTools();
  return { ...mcp, ...builtinTools };
}

function usageDetails(usage: LanguageModelUsage) {
  return {
    ...(usage.inputTokens !== undefined ? { input: usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { output: usage.outputTokens } : {}),
    ...(usage.totalTokens !== undefined ? { total: usage.totalTokens } : {}),
  };
}

// LanguageModel is a union that includes bare model-id strings.
function modelIdOf(model: LanguageModel): string | undefined {
  if (typeof model === "string") return model;
  if ("modelId" in model && typeof model.modelId === "string") {
    return model.modelId;
  }
  return undefined;
}

// Publishes an event to the "custom" stream. Note: use getWriter(), NOT the
// writer() helper — in @langchain/langgraph 1.4.x writer() reads
// configurable.writer, which Pregel no longer populates, so it silently
// drops every event; getWriter() reads the top-level config.writer.
function writeEvent(event: PlanExecuteEvent): void {
  getWriter()?.(event);
}

async function planner(state: OpsGraphState): Promise<OpsGraphUpdate> {
  const prompt = `Break down the following task into concrete steps.\n\nTask:\n${state.query}`;
  const result = await observeGeneration(
    "ai-ops.planner",
    async (generation) => {
      const res = await generateText({
        model: thinkModel,
        output: Output.object({ schema: planSchema }),
        prompt,
        providerOptions,
      });
      generation?.update({
        input: prompt,
        output: res.text,
        model: modelIdOf(thinkModel),
        usageDetails: usageDetails(res.usage),
      });
      return res;
    },
  );
  writeEvent({
    type: "plan_created",
    steps: result.output.steps,
  });
  return { plan: result.output.steps };
}

async function executor(state: OpsGraphState): Promise<OpsGraphUpdate> {
  const index = state.stepIndex;
  const step = state.plan[index];
  writeEvent({ type: "step_start", index, step });
  const tools = await buildTools();
  const result = await observeGeneration(
    "ai-ops.execute-step",
    async (generation) => {
      const res = await executeStep(step, tools);
      generation?.update({
        input: step,
        output: res.text,
        model: modelIdOf(quickModel),
        usageDetails: usageDetails(res.usage),
      });
      return res;
    },
  );
  writeEvent({ type: "step_done", index, output: result.text });
  return { stepIndex: index + 1, detail: [result.text] };
}

async function replanner(state: OpsGraphState): Promise<OpsGraphUpdate> {
  const prompt = `You are a replanning agent reviewing execution progress toward an objective. Analyze the completed steps and their outcomes to decide whether the objective is fully achieved or further action is required.

Task:
${state.query}

Original Plan:
${JSON.stringify({ steps: state.plan })}

Completed steps:
${state.plan.map((s, idx) => `${idx + 1}. ${s}`).join("\n")}

Results so far:
${state.detail.join("\n")}

Based on the progress above, determine whether the task is complete. If it is, provide a comprehensive final report in the summary field. If more work is needed, list only the remaining steps.`;
  const output = await observeGeneration(
    "ai-ops.replanner",
    async (generation) => {
      const res = await generateText({
        model: thinkModel,
        output: Output.object({ schema: replanSchema }),
        prompt,
        providerOptions,
      });
      generation?.update({
        input: prompt,
        output: res.text,
        model: modelIdOf(thinkModel),
        usageDetails: usageDetails(res.usage),
      });
      return res.output;
    },
  );
  writeEvent({
    type: "replan",
    done: output.done,
    remaining: output.remaining,
  });
  return {
    done: output.done,
    report: output.summary,
    plan: output.remaining,
    stepIndex: 0,
    iteration: state.iteration + 1,
  };
}

// Post "UI-ify" pass: one no-tools think-model call that optionally renders
// the finished report as an A2UI surface. Returns undefined when the report
// has nothing structured to visualize, the block stays invalid after one
// corrective retry, or the call fails — the report itself is never at risk.
async function uiifyReport(result: string): Promise<unknown[] | undefined> {
  const system = `You render A2UI surfaces for an OnCall assistant.\n${A2UI_PROMPT_SECTION}`;
  const question = `Below is an alert operations analysis report. If it presents structured data worth visualizing (alert lists, metric series, tabular results), reply with ONLY one A2UI block wrapped between ${A2UI_OPEN_TAG} and ${A2UI_CLOSE_TAG}.

Rules:

- The report is the ONLY source: visualize facts it states, copied verbatim — NEVER invent data.
- Do not visualize intermediate execution chatter (e.g. current-time lookups) and never repeat the same data twice.
- Never render empty tables or placeholder rows like "(none)" or "—".
- Titles must be short noun phrases, not sentences; omit a Table caption when a heading already labels it.
- If the report has nothing structured to render (e.g. zero active alerts, prose-only conclusions), reply with the single word NONE.

Report:

${result}`;
  try {
    const gen = await observeGeneration("ai-ops.uiify", async (generation) => {
      const res = await generateText({
        model: thinkModel,
        system,
        prompt: question,
        providerOptions,
      });
      generation?.update({
        input: question,
        output: res.text,
        model: modelIdOf(thinkModel),
        usageDetails: usageDetails(res.usage),
      });
      return res;
    });
    const extracted = extractA2ui(gen.text);
    if (extracted.messages) return extracted.messages;
    if (!extracted.error) return undefined; // no block: nothing to render
    return await correctA2uiBlock({
      model: thinkModel,
      system,
      history: [],
      question,
      rawAnswer: gen.text,
      error: extracted.error,
    });
  } catch (e) {
    // The surface is an optional decoration on an expensive multi-iteration
    // run — never let its failure discard the finished report.
    console.error("[a2ui] ai_ops uiify failed:", e);
    return undefined;
  }
}

async function uiify(state: OpsGraphState): Promise<OpsGraphUpdate> {
  const a2ui = await uiifyReport(state.report);
  writeEvent({
    type: "done",
    result: state.report,
    detail: state.detail,
    ...(a2ui ? { a2ui } : {}),
  });
  return {};
}

function exhausted(state: OpsGraphState): OpsGraphUpdate {
  writeEvent({
    type: "done",
    result: "Max iterations reached",
    detail: state.detail,
  });
  return {};
}

function afterPlanner(state: OpsGraphState): "executor" | "exhausted" {
  return state.plan.length > 0 ? "executor" : "exhausted";
}

function afterExecutor(state: OpsGraphState): "executor" | "replanner" {
  return state.stepIndex < state.plan.length ? "executor" : "replanner";
}

function afterReplanner(
  state: OpsGraphState,
): "executor" | "uiify" | "exhausted" {
  if (state.done) return "uiify";
  if (state.iteration >= MAX_ITERATIONS || state.plan.length === 0) {
    return "exhausted";
  }
  return "executor";
}

export const opsGraph = new StateGraph(OpsState)
  .addNode("planner", planner)
  .addNode("executor", executor)
  .addNode("replanner", replanner)
  .addNode("uiify", uiify)
  .addNode("exhausted", exhausted)
  .addEdge(START, "planner")
  .addConditionalEdges("planner", afterPlanner, ["executor", "exhausted"])
  .addConditionalEdges("executor", afterExecutor, ["executor", "replanner"])
  .addConditionalEdges("replanner", afterReplanner, [
    "executor",
    "uiify",
    "exhausted",
  ])
  .addEdge("uiify", END)
  .addEdge("exhausted", END)
  .compile();
