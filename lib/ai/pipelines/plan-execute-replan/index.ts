// Plan-Execute-Replan driver: runs the LangGraph orchestration in graph.ts
// (planner → executor → replanner loop) and replays its "custom"-mode event
// stream as PlanExecuteEvents.
// Langfuse: every run gets a session id; graph/node spans come from the
// CallbackHandler and LLM calls from observeGeneration — all no-ops when the
// LANGFUSE_* env vars are unset.
import { randomUUID } from "node:crypto";
import { logEnd, logStart } from "@/lib/ai/callbacks";
import { aiOpsCallbacks, withAiOpsTrace } from "@/lib/observability";
import { PlanExecuteEventSchema, type PlanExecuteEvent } from "./events";
import { opsGraph, RECURSION_LIMIT } from "./graph";

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

export async function* runPlanExecuteReplan(
  query: string = AI_OPS_QUERY,
): AsyncGenerator<PlanExecuteEvent> {
  const sessionId = randomUUID();
  logStart("PlanExecuteReplan");

  try {
    // withAiOpsTrace keeps the Langfuse session/tags attached to spans created
    // while the (lazily executed) graph stream advances.
    const stream = await withAiOpsTrace(sessionId, () =>
      opsGraph.stream(
        { query },
        {
          streamMode: "custom",
          recursionLimit: RECURSION_LIMIT,
          callbacks: aiOpsCallbacks(sessionId),
        },
      ),
    );
    for (;;) {
      const next = await withAiOpsTrace(sessionId, () => stream.next());
      if (next.done) break;
      const parsed = PlanExecuteEventSchema.safeParse(next.value);
      if (parsed.success) {
        yield parsed.data;
      }
    }
  } catch (e) {
    yield { type: "error", error: e instanceof Error ? e.message : String(e) };
  } finally {
    logEnd("PlanExecuteReplan");
  }
}
