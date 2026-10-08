import { tool } from "ai";
import {
  getCurrentTimeSchema,
  postgresQuerySchema,
  queryInternalDocsSchema,
  prometheusAlertsSchema,
} from "./schemas";
import {
  getCurrentTime,
  queryPrometheusAlerts,
  retrieveDocs,
  execPostgresSql,
} from "./operations";
import { loadSkillTool } from "@/lib/ai/prompts-skills";

// get_current_time
export const getCurrentTimeTool = tool({
  description:
    "Get current system time in multiple formats. Returns the current time in seconds, milliseconds, microseconds, and a human-readable timestamp. Use this tool when you need current time for logging, timing, or timestamp events.",
  inputSchema: getCurrentTimeSchema,
  execute: async () => JSON.stringify(getCurrentTime()),
});

// postgres_query
export const postgresQueryTool = tool({
  description:
    "Execute SQL against the separately configured OnCall PostgreSQL database and return JSON results. Supports query/insert/update/delete. Cannot access the application database. Unavailable until the administrator configures a dedicated connection.",
  inputSchema: postgresQuerySchema,
  execute: async (input) =>
    JSON.stringify(await execPostgresSql(input.sql, input.operate_type)),
});

// query_internal_docs
export const queryInternalDocsTool = tool({
  description:
    "Search internal documentation and knowledge base via RAG. Finds similar documents and extracts processing steps. Useful for understanding internal procedures, best practices, or step-by-step guides.",
  inputSchema: queryInternalDocsSchema,
  execute: async (input) => JSON.stringify(await retrieveDocs(input.query)),
});

// query_prometheus_alerts
export const prometheusAlertsTool = tool({
  description:
    "Query active alerts from all configured Prometheus / Alertmanager sources. Retrieves currently firing alerts including name, description, state, active_at, duration, service, severity, labels, annotations, context_url, fingerprint and source provenance. Same alert name only kept once across sources; individual source failures are reported in sourceErrors without discarding other results.",
  inputSchema: prometheusAlertsSchema,
  execute: async () => JSON.stringify(await queryPrometheusAlerts()),
});

// Built-in tool collection (excludes MCP log tools, which are fetched separately)
export const builtinTools = {
  get_current_time: getCurrentTimeTool,
  postgres_query: postgresQueryTool,
  query_internal_docs: queryInternalDocsTool,
  query_prometheus_alerts: prometheusAlertsTool,
  // load_skill — port of the legacy progressive-disclosure skill tool
  // (agent_py chat/streaming.py:551-574); enabled assets only.
  load_skill: loadSkillTool,
};
