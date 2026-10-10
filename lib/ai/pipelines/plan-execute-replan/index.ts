import { randomUUID } from "node:crypto";
import { logEnd, logStart } from "@/lib/ai/callbacks";
import { aiOpsCallbacks, withAiOpsTrace } from "@/lib/observability";
import { PlanExecuteEventSchema, type PlanExecuteEvent } from "./events";
import { opsGraph, RECURSION_LIMIT } from "./graph";

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

const ALERT_QUERY_FIELDS = [
  "alert_name",
  "severity",
  "service",
  "state",
  "active_at",
  "duration",
  "description",
  "context_url",
  "fingerprint",
  "source",
] as const;

export interface AiOpsRequestBody {
  query?: string;
  alert?: Record<string, string> | null;
}

export function buildAiOpsQuery(body: AiOpsRequestBody): {
  query: string;
  alert: Record<string, string> | null;
} {
  const alert = body.alert ?? null;
  if (alert === null) {
    return {
      query: body.query && body.query.trim() !== "" ? body.query : AI_OPS_QUERY,
      alert: null,
    };
  }
  const lines = ALERT_QUERY_FIELDS.filter((field) => alert[field])
    .map((field) => `- ${field}: ${alert[field]}`)
    .join("\n");
  const operatorNote =
    body.query && body.query.trim() !== ""
      ? `\n\nAdditional operator instructions:\n${body.query.trim()}`
      : "";
  const query = `You are diagnosing ONE specific active alert. Treat it as the only subject of this analysis — do not sweep the whole alert list.

Target alert (normalized fields from the configured alert provider):
${lines || "- alert_name: Unknown alert"}

1. Call the tool query_internal_docs by the alert name to retrieve the corresponding handling procedure / runbook.
2. Strictly follow the internal documentation for queries and analysis; do not use any information outside the documentation.
3. For any time-related parameters, first call the tool get_current_time to obtain the current time, then pass parameters according to the tool's time requirements.
4. For log queries, first use the log tool to retrieve relevant log information; parameters must include the region and log topic.
5. Summarize and analyze the evidence gathered for this alert, then generate an alert operations analysis report in Chinese (中文) in the following format:

告警分析报告
---

# 告警处理详情

## 活跃告警列表

## 告警归因 1 (第 1 个告警)

## 处理流程 1 (第 1 个告警)

## 结论
${operatorNote}`;
  return { query, alert };
}

export async function* runPlanExecuteReplan(
  query: string = AI_OPS_QUERY,
  alert: Record<string, string> | null = null,
): AsyncGenerator<PlanExecuteEvent> {
  const sessionId = randomUUID();
  logStart("PlanExecuteReplan");

  try {
    const stream = await withAiOpsTrace(sessionId, () =>
      opsGraph.stream(
        { query, alert },
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
