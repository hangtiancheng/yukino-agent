// Planner (think) → Executor (quick + tools) → Replanner (think) loop,
// MaxIterations=20.
// event-stream pattern.
import { generateText, Output, type Tool } from "ai";
import { z } from "zod/v4";
import { thinkModel, providerOptions } from "../../models";
import { correctA2uiBlock } from "../../a2ui/correct";
import { extractA2ui } from "../../a2ui/extract";
import {
  A2UI_CLOSE_TAG,
  A2UI_OPEN_TAG,
  A2UI_PROMPT_SECTION,
} from "../../a2ui/prompt";
import { builtinTools } from "../../tools";
import { getLogMcpTools } from "../../tools/query-log";
import { executeStep } from "./executor";
import type { PlanExecuteEvent } from "./events";
import { logStart, logEnd } from "@/lib/ai/callbacks";

const MAX_ITERATIONS = 20;

// AI Ops alert-analysis query.
const AI_OPS_QUERY = `1. You are an intelligent service alert analysis assistant. First, call the tool query_prometheus_alerts to retrieve all active alerts.
2. For each alert, call the tool query_internal_docs by alert name to retrieve the corresponding handling procedure.
3. Strictly follow the internal documentation for queries and analysis; do not use any information outside the documentation.
4. For any time-related parameters, first call the tool get_current_time to obtain the current time, then pass parameters according to the tool's time requirements.
5. For log queries, first use the log tool to retrieve relevant log information; parameters must include the region and log topic.
6. Summarize and analyze the information retrieved for each alert, then generate an alert operations analysis report in Chinese (中文) in the following format:

告警分析报告
---

# 告警处理详情

## 活跃告警列表

## 告警归因 N (第 N 个告警)

## 处理流程 N (第 N 个告警)

## 结论
`;

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
    const gen = await generateText({
      model: thinkModel,
      system,
      prompt: question,
      providerOptions,
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

export async function* runPlanExecuteReplan(
  query: string = AI_OPS_QUERY,
): AsyncGenerator<PlanExecuteEvent> {
  const tools = await buildTools();
  logStart("PlanExecuteReplan");

  try {
    // Planner
    const planResult = await generateText({
      model: thinkModel,
      output: Output.object({ schema: planSchema }),
      prompt: `Break down the following task into concrete steps.\n\nTask:\n${query}`,
      providerOptions,
    });
    let plan = planResult.output.steps;
    yield { type: "plan_created", steps: plan };

    const detail: string[] = [];

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      if (plan.length === 0) break;

      for (let i = 0; i < plan.length; i++) {
        const step = plan[i];
        yield { type: "step_start", index: i, step };
        const res = await executeStep(step, tools);
        detail.push(res.text);
        yield { type: "step_done", index: i, output: res.text };
      }

      // Replanner
      const replanResult = await generateText({
        model: thinkModel,
        output: Output.object({ schema: replanSchema }),
        prompt: `You are a replanning agent reviewing execution progress toward an objective. Analyze the completed steps and their outcomes to decide whether the objective is fully achieved or further action is required.

Task:
${query}

Original Plan:
${JSON.stringify({ steps: plan })}

Completed steps:
${plan.map((s, idx) => `${idx + 1}. ${s}`).join("\n")}

Results so far:
${detail.join("\n")}

Based on the progress above, determine whether the task is complete. If it is, provide a comprehensive final report in the summary field. If more work is needed, list only the remaining steps.`,
        providerOptions,
      });
      const obj = replanResult.output;
      yield { type: "replan", done: obj.done, remaining: obj.remaining };

      if (obj.done) {
        const a2ui = await uiifyReport(obj.summary);
        yield {
          type: "done",
          result: obj.summary,
          detail,
          ...(a2ui ? { a2ui } : {}),
        };
        return;
      }
      plan = obj.remaining;
    }

    yield { type: "done", result: "Max iterations reached", detail };
  } catch (e) {
    yield { type: "error", error: e instanceof Error ? e.message : String(e) };
  } finally {
    logEnd("PlanExecuteReplan");
  }
}
