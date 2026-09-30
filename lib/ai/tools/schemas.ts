// Tool input parameter schemas (Zod).
import { z } from "zod/v4";

// get_current_time: no input parameters
export const getCurrentTimeSchema = z
  .object({})
  .describe("No input parameters, returns the current system time");

// mysql_crud: DSN + SQL + operation type
export const mysqlCrudSchema = z.object({
  dsn: z
    .string()
    .describe(
      "MySQL DSN, including username/password/host/port/database name, e.g., root:pass@tcp(host:3306)/db",
    ),
  sql: z.string().describe("SQL statement to execute"),
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
