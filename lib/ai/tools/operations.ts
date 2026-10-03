// Pure function implementations for tools:
// get_current_time / query_prometheus_alerts / query_internal_docs / postgres_query
import { retrieve } from "@/lib/milvus/retriever";
import { executeOncallSql } from "./postgres";
import { config } from "@/lib/config";
import { z } from "zod/v4";

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

// Prometheus /api/v1/alerts response schema (runtime validation via zod)
const prometheusResponseSchema = z.looseObject({
  data: z
    .looseObject({
      alerts: z
        .array(
          z.looseObject({
            labels: z.record(z.string(), z.string()).optional(),
            annotations: z.record(z.string(), z.string()).optional(),
            state: z.string().optional(),
            activeAt: z.string().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});

// ============ query_prometheus_alerts ============
export interface SimplifiedAlert {
  alert_name: string;
  description: string;
  state: string;
  active_at: string;
  duration: string;
}

export async function queryPrometheusAlerts(): Promise<{
  success: boolean;
  alerts: SimplifiedAlert[];
  message?: string;
  error?: string;
}> {
  try {
    const url = `${config.prometheusBaseUrl}/api/v1/alerts`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) {
      return {
        success: false,
        alerts: [],
        message: "Failed to query Prometheus alerts",
        error: `HTTP ${resp.status}`,
      };
    }
    const result = prometheusResponseSchema.parse(await resp.json());
    const all = result.data?.alerts ?? [];
    // Keep only the first occurrence for the same alertname.
    const seen = new Set<string>();
    const alerts: SimplifiedAlert[] = [];
    for (const a of all) {
      const name = a.labels?.alertname ?? "";
      if (!name || seen.has(name)) continue;
      seen.add(name);
      alerts.push({
        alert_name: name,
        description: a.annotations?.description ?? "",
        state: a.state ?? "",
        active_at: a.activeAt ?? "",
        duration: calculateDuration(a.activeAt ?? ""),
      });
    }
    return {
      success: true,
      alerts,
      message: `Successfully retrieved ${alerts.length} active alerts`,
    };
  } catch (e) {
    // Return an error message when Prometheus is unavailable.
    return {
      success: false,
      alerts: [],
      message: "Failed to query Prometheus alerts",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function calculateDuration(activeAt: string): string {
  const t = Date.parse(activeAt);
  if (Number.isNaN(t)) return "unknown";
  const ms = Date.now() - t;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (h > 0) return `${h}h${m}m${s}s`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
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
