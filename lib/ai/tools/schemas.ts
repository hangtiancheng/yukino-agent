// Tool input parameter schemas (Zod).
import { z } from "zod/v4";

// get_current_time: no input parameters
export const getCurrentTimeSchema = z
  .object({})
  .describe("No input parameters, returns the current system time");

// postgres_query: SQL + operation type (connection comes from ONCALL_DATABASE_URL)
export const postgresQuerySchema = z.object({
  sql: z
    .string()
    .describe(
      "PostgreSQL statement to execute against the dedicated OnCall database; the application account and complaint database is not accessible",
    ),
  operate_type: z
    .enum(["query", "insert", "update", "delete"])
    .describe("SQL operation type"),
});

// query_internal_docs: RAG retrieval for internal documents
export const queryInternalDocsSchema = z.object({
  query: z
    .string()
    .describe("Query string used to retrieve internal documents"),
});

// query_prometheus_alerts: no input parameters
export const prometheusAlertsSchema = z
  .object({})
  .describe("No input parameters, queries active Prometheus alerts");
