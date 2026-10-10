import { z } from "zod/v4";

export const getCurrentTimeSchema = z
  .object({})
  .describe("No input parameters, returns the current system time");

export const postgresQuerySchema = z.object({
  sql: z
    .string()
    .describe(
      "PostgreSQL statement to execute against the dedicated OnCall database; the application database is not accessible",
    ),
  operate_type: z
    .enum(["query", "insert", "update", "delete"])
    .describe("SQL operation type"),
});

export const queryInternalDocsSchema = z.object({
  query: z
    .string()
    .describe("Query string used to retrieve internal documents"),
});

export const prometheusAlertsSchema = z
  .object({})
  .describe(
    "No input parameters, queries currently firing/active alerts from all configured Prometheus / Alertmanager sources (ALERT_SOURCES; falls back to PROMETHEUS_BASE_URL). Returns snake_case fields: alert_name, description, state, active_at, duration, service, severity, labels, annotations, context_url, fingerprint, source.",
  );

export const loadSkillSchema = z.object({
  skill_name: z
    .string()
    .describe(
      "Exact skill name from the Available Skills catalog; unknown names return an honest error listing what is loadable",
    ),
});
