import { retrieve } from "@/lib/milvus/retriever";
import { executeOncallSql } from "./postgres";
import { aggregateAlerts, type Alert } from "@/lib/ai/alerts";

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
    return {
      success: false,
      alerts: [],
      message: "Failed to query Prometheus alerts",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function retrieveDocs(query: string) {
  const docs = await retrieve(query);
  return docs;
}

export async function execPostgresSql(
  sql: string,
  operateType: string,
): Promise<unknown> {
  return executeOncallSql(sql, operateType);
}
