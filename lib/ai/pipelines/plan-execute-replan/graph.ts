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
import { executeStep, findUnknownToolReferences } from "./executor";
import type { PlanExecuteEvent } from "./events";

export const MAX_ITERATIONS = 20;

// Constant result text of the exhausted branch; the /api/ai_ops route maps it
// to AiOpsRun.status "exhausted" (events.ts is a fixed contract, so this
// string is the only done/exhausted discriminator).
export const EXHAUSTED_RESULT = "Max iterations reached";

// Safety net only — the iteration counter in afterReplanner is the real
// budget. Each round costs one superstep per plan step plus the replanner, so
// allow a generous per-round step count before LangGraph itself aborts.
export const RECURSION_LIMIT = MAX_ITERATIONS * 25 + 25;

const overwrite = <T>(_left: T, right: T): T => right;

const OpsState = Annotation.Root({
  // The analysis task (defaults to the AI Ops alert-analysis query).
  query: Annotation<string>(),
  // Structured fields of the alert a targeted diagnosis was asked for
  // (AI Ops input surface G3); null for generic runs. Feeds the
  // deterministic report fallback template (port of the legacy alert table).
  alert: Annotation<Record<string, string> | null>({
    reducer: overwrite,
    default: () => null,
  }),
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
  // Guardrail ported from legacy _validated_plan (diagnostics.py:829-863):
  // plan steps may only reference DISCOVERED tools. An undiscovered tool
  // name is never silently narrated — the step is marked skipped and the
  // observation lands in `detail` so the replanner sees why.
  const unknown = findUnknownToolReferences(step, Object.keys(tools));
  if (unknown.length > 0) {
    const observation = `[skipped] step references undiscovered tool(s): ${unknown.join(", ")}; currently discovered tools: ${Object.keys(tools).join(", ") || "none"}.`;
    writeEvent({ type: "step_done", index, output: observation });
    return { stepIndex: index + 1, detail: [observation] };
  }
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

// ---- Report structure guardrail (port of legacy _clean_markdown_report +
// _fallback_report_content, diagnostics.py:63-68 / 1087-1190 — the two
// anti-hallucination guardrails). The REQUIRED markers are the minimum headings
// of the current redesigned template (index.ts AI_OPS_QUERY): title, alert list,
// conclusion — deliberately looser than the legacy exact-heading match because
// the migration changed the template shape.
export const AIOPS_REPORT_REQUIRED_MARKERS = [
  "告警分析报告",
  "活跃告警",
  "结论",
] as const;

const REPORT_FENCE_PATTERN =
  /^```(?:markdown|md)?[ \t]*\r?\n([\s\S]*)\r?\n```[ \t]*$/;

// Legacy _clean_markdown_report: strip surrounding whitespace, unwrap a
// whole-response ``` fence, reject JSON-shaped text, require every marker.
// Returns the cleaned report or null when the draft is unusable.
export function cleanMarkdownReport(content: string): string | null {
  let report = content.trim();
  const fenced = REPORT_FENCE_PATTERN.exec(report);
  if (fenced !== null) report = fenced[1].trim();
  if (report === "" || report.startsWith("{") || report.startsWith("[")) {
    return null;
  }
  if (
    !AIOPS_REPORT_REQUIRED_MARKERS.every((marker) => report.includes(marker))
  ) {
    return null;
  }
  return report;
}

// Legacy _report_value (diagnostics.py:1192-1199): first non-empty string
// field, with '|' escaped for markdown tables; "未获取" when nothing matches.
function reportValue(
  alert: Record<string, string> | null,
  ...keys: string[]
): string {
  for (const key of keys) {
    const value = alert?.[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim().replace(/\|/g, "\\|");
    }
  }
  return "未获取";
}

// Legacy _fallback_evidence_lines (diagnostics.py:1201-1209), adapted: our
// `detail` entries are free-text step outputs, so each collapses to one
// numbered line (whitespace-normalized, bounded like the 500-char evidence
// summaries in diagnostic-cases.ts).
const EVIDENCE_LINE_CHARS = 500;
const MAX_EVIDENCE_LINES = 20;

export function fallbackEvidenceLines(detail: string[]): string[] {
  const lines = detail.slice(0, MAX_EVIDENCE_LINES).map((item, i) => {
    const normalized = item.split(/\s+/).join(" ").trim();
    const summary =
      normalized.length <= EVIDENCE_LINE_CHARS
        ? normalized
        : `${normalized.slice(0, EVIDENCE_LINE_CHARS - 3)}...`;
    return `${i + 1}. ${summary === "" ? "(空步骤输出)" : summary}`;
  });
  return lines.length > 0 ? lines : ["未获取工具证据，无法验证日志症状。"];
}

// Legacy _fallback_report_content (diagnostics.py:1099-1190): a deterministic
// Chinese template assembled ONLY from the structured alert input and the
// executed-step evidence — used when the LLM report fails structure
// validation twice, so a finished run always yields a compliant report and
// never an unverified root-cause claim.
export function fallbackReportContent(args: {
  alert: Record<string, string> | null;
  detail: string[];
}): string {
  const { alert, detail } = args;
  const alertName = reportValue(alert, "alert_name", "alertName", "name");
  const severity = reportValue(alert, "severity", "level");
  const service = reportValue(alert, "service", "target");
  const startsAt = reportValue(alert, "active_at", "startsAt", "startTime");
  const duration = reportValue(alert, "duration");
  const state = reportValue(alert, "state", "status");
  const evidenceLines = fallbackEvidenceLines(detail);
  const executionFailed = detail.length === 0;
  const alertList =
    alert === null
      ? "本次为通用巡检诊断，未传入结构化告警；请参见下方执行证据。"
      : [
          "| 告警名称 | 级别 | 目标服务 | 首次触发时间 | 持续时间 | 状态 |",
          "|---------|------|----------|-------------|---------|------|",
          `| ${alertName} | ${severity} | ${service} | ${startsAt} | ${duration} | ${state} |`,
        ].join("\n");
  const executionLine = executionFailed
    ? "诊断工具执行失败或未产出证据，部分结论无法验证。"
    : "诊断流程已执行完成。";
  const firstSuggestion = executionFailed
    ? "1. 检查失败的工具调用并恢复数据源连接。"
    : "1. 继续补充相关服务的指标和日志证据。";
  return [
    "# 告警分析报告",
    "",
    "---",
    "",
    "## 活跃告警列表",
    "",
    alertList,
    "",
    "---",
    "",
    `## 告警归因 1 (第 1 个告警) - ${alertName}`,
    "",
    "### 告警详情",
    `- **告警级别**: ${severity}`,
    `- **受影响服务**: ${service}`,
    `- **持续时间**: ${duration}`,
    "",
    "### 症状描述",
    "当前仅能确认诊断输入和下列工具执行结果，未获取可独立验证的完整症状指标。",
    "",
    "### 日志证据",
    ...evidenceLines,
    "",
    "### 根因结论",
    "证据不足，无法确认根因。",
    "",
    "---",
    "",
    `## 处理流程 1 (第 1 个告警) - ${alertName}`,
    "",
    "### 已执行的排查步骤",
    ...evidenceLines,
    "",
    "### 处理建议",
    "本报告为确定性回退模板：模型生成的报告两次未通过结构校验，仅基于已执行证据拼成，未采用任何未经验证的推断。在变更系统状态前，请补充可验证的日志和指标证据，并由值班人员确认处置动作。",
    "",
    "### 预期效果",
    "补充证据后可缩小故障范围，并验证后续处置是否降低告警影响；当前尚未执行处置动作。",
    "",
    "---",
    "",
    "## 结论",
    "",
    "### 整体评估",
    executionLine,
    "当前报告未获得足以确认根因的完整证据，不作未经验证的根因判断。",
    "",
    "### 关键发现",
    `- ${executionLine}`,
    "- 模型生成的最终报告未通过必需标题校验，已使用确定性证据模板回退。",
    "",
    "### 后续建议",
    firstSuggestion,
    "2. 将新增证据与告警触发时间对齐后重新执行诊断。",
    "",
    "### 风险评估",
    `告警级别为 ${severity}；由于影响范围和持续时间信息不完整，当前风险等级无法进一步确认。`,
  ].join("\n");
}

// Second LLM attempt when the replanner summary fails validation: one
// no-tools think-model call that may only restructure the draft around the
// collected evidence. Any failure returns "" and the caller falls back.
async function regenerateReport(state: OpsGraphState): Promise<string> {
  const prompt = `You are finalizing an alert operations analysis report (告警分析报告). The draft below failed required-structure validation. Rewrite it as clean Markdown that contains at least these Chinese headings: "# 告警分析报告", "## 活跃告警列表", "## 告警归因 N (第 N 个告警)", "## 处理流程 N (第 N 个告警)", "## 结论".

Hard rules:
- Use ONLY facts stated in the evidence; never invent tool results, metrics, or root causes.
- Where evidence is missing, state 未获取 / 证据不足 instead of guessing.
- Reply with the Markdown report only.

Task:
${state.query}

Collected evidence (executed step outputs):
${state.detail.join("\n\n")}

Draft report:
${state.report}`;
  const res = await observeGeneration(
    "ai-ops.report-retry",
    async (generation) => {
      const out = await generateText({
        model: thinkModel,
        prompt,
        providerOptions,
      });
      generation?.update({
        input: prompt,
        output: out.text,
        model: modelIdOf(thinkModel),
        usageDetails: usageDetails(out.usage),
      });
      return out;
    },
  );
  return res.text;
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
  // Legacy report pipeline (_generate_report_content, diagnostics.py:669-684):
  // validate the model report; on failure fall back to the deterministic
  // template. Here the replanner summary is attempt #1, a single evidence-
  // bound rewrite is #2, and the template is the guaranteed floor — a
  // finished run always yields a structurally compliant report.
  let report = cleanMarkdownReport(state.report);
  if (report === null && state.report.trim() !== "") {
    let retryText = "";
    try {
      retryText = await regenerateReport(state);
    } catch (e) {
      // The rewrite call is best-effort (LLM may be down); the template floor
      // keeps the report alive.
      console.error("[ai-ops] report regeneration failed:", e);
    }
    report = cleanMarkdownReport(retryText);
  }
  if (report === null)
    report = fallbackReportContent({
      alert: state.alert,
      detail: state.detail,
    });
  const a2ui = await uiifyReport(report);
  writeEvent({
    type: "done",
    result: report,
    detail: state.detail,
    ...(a2ui ? { a2ui } : {}),
  });
  return {};
}

function exhausted(state: OpsGraphState): OpsGraphUpdate {
  writeEvent({
    type: "done",
    result: EXHAUSTED_RESULT,
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
