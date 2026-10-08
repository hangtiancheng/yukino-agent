// Pure function implementations for tools:
// get_current_time / query_prometheus_alerts / query_internal_docs / postgres_query
import { retrieve } from "@/lib/milvus/retriever";
import { executeOncallSql } from "./postgres";
import { aggregateAlerts, type Alert } from "@/lib/ai/alerts";

// ============ get_current_time ============
export function getCurrentTime() {
  const now = new Date();
  const s = now.getTime() / 1000;
  return {
    success: true,
    seconds: Math.floor(s),
    milliseconds: now.getTime(),
    microseconds: now.getTime() * 1000,
    timestamp: formatTimestamp(now),
    message: "Current time retrieved successfully",
  };
}

function formatTimestamp(d: Date): string {
  const pad = (n: number, l = 2) => String(n).padStart(l, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

// ============ query_prometheus_alerts ============
// `Alert` is the multi-source normalized shape ported from the legacy
// super_ai/alerts.py ActiveAlert (see lib/ai/alerts.ts). The old inline
// single-source fetch + SimplifiedAlert lived here; the aggregation, state
// filter, dedup and failure tolerance now live in lib/ai/alerts.ts.
export type { Alert };

export async function queryPrometheusAlerts(): Promise<{
  success: boolean;
  alerts: Alert[];
  sourceErrors?: { source: string; error: string }[];
  message?: string;
  error?: string;
}> {
  try {
    const { alerts, sourceErrors, anySourceOk } = await aggregateAlerts();
    if (!anySourceOk) {
      return {
        success: false,
        alerts: [],
        sourceErrors,
        message: "Failed to query Prometheus alerts",
        error: `All alert sources are unavailable: ${sourceErrors
          .map((e) => `${e.source} (${e.error})`)
          .join(", ")}`,
      };
    }
    return {
      success: true,
      alerts,
      ...(sourceErrors.length > 0 ? { sourceErrors } : {}),
      message: `Successfully retrieved ${alerts.length} active alerts`,
    };
  } catch (e) {
    // Defensive: aggregateAlerts tolerates per-source failures, but a config
    // read or dedup crash must still degrade to an honest error result.
    return {
      success: false,
      alerts: [],
      message: "Failed to query Prometheus alerts",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ============ query_internal_docs ============
export async function retrieveDocs(query: string) {
  const docs = await retrieve(query);
  return docs;
}

// ============ postgres_query ============
// Public OnCall must never inherit the application account's database access.
// The LLM supplies SQL only; the dedicated connection is administrator-configured.

export async function execPostgresSql(
  sql: string,
  operateType: string,
): Promise<unknown> {
  return executeOncallSql(sql, operateType);
}
