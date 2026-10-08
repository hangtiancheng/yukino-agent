// GET /api/config_check — static configuration sanity report (port of the
// agent_py config-check route). Never echoes secret values: each item reports
// configured + a non-sensitive detail. The issues list names variables that
// must be set before the corresponding capability works.
import { getTranslations } from "next-intl/server";
import { config } from "@/lib/config";

interface ConfigItem {
  key: string;
  configured: boolean;
  detail: string;
}

export async function GET() {
  const t = await getTranslations("api.oncall");

  const items: ConfigItem[] = [
    {
      key: "DATABASE_URL",
      configured: config.database.url !== "",
      detail: config.database.url.replace(/\/\/[^@]*@/, "//***@"),
    },
    {
      key: "MILVUS_URI",
      configured: config.milvus.uri !== "",
      detail: `${config.milvus.uri} / ${config.milvus.collection} (analyzer: ${config.milvus.analyzer})`,
    },
    {
      key: "OPENAI_QUICK/THINK",
      configured:
        config.openai.quick.apiKey !== "" && config.openai.think.apiKey !== "",
      detail: `${config.provider}: ${config.openai.quick.model}`,
    },
    {
      key: "OPENAI_EMBEDDING_API_KEY",
      configured: config.openaiEmbedding.apiKey !== "",
      detail: config.openaiEmbedding.model,
    },
    {
      key: "RERANK_API_KEY",
      configured: config.rerank.apiKey !== "",
      detail:
        config.rerank.apiKey !== ""
          ? config.rerank.model
          : t("configRerankDisabled"),
    },
    {
      key: "PROMETHEUS_BASE_URL",
      configured: config.prometheusBaseUrl !== "",
      detail: config.prometheusBaseUrl,
    },
    {
      key: "ALERT_SOURCES",
      configured: config.alertSourcesJson !== "",
      detail:
        config.alertSourcesJson !== ""
          ? t("configMultiSource")
          : t("configSingleSource"),
    },
    {
      key: "MCP_URL",
      configured: config.mcpUrl !== "",
      detail: config.mcpUrl,
    },
    {
      key: "ONCALL_DATABASE_URL",
      configured: config.oncallDatabaseUrl !== "",
      detail:
        config.oncallDatabaseUrl !== ""
          ? t("configReadonlyToolOn")
          : t("configReadonlyToolOff"),
    },
    {
      key: "LANGFUSE",
      configured:
        config.langfuse.publicKey !== "" &&
        config.langfuse.secretKey !== "" &&
        config.langfuse.baseUrl !== "",
      detail: config.langfuse.baseUrl,
    },
    {
      key: "FILE_DIR",
      configured: config.fileDir !== "",
      detail: config.fileDir,
    },
    {
      key: "ONCALL_ADMIN_TOKEN",
      configured: config.oncallAdminToken !== "",
      detail:
        config.oncallAdminToken !== ""
          ? t("configAdminGateOn")
          : t("configAdminGateOff"),
    },
  ];

  const issues: string[] = [];
  if (config.openaiEmbedding.apiKey === "")
    issues.push("OPENAI_EMBEDDING_API_KEY");
  if (
    (config.provider === "openai" && config.openai.quick.apiKey === "") ||
    (config.provider === "anthropic" && config.anthropic.quick.apiKey === "")
  ) {
    issues.push("LLM_API_KEY");
  }
  if (config.oncallAdminToken === "") issues.push("ONCALL_ADMIN_TOKEN");

  return Response.json({
    message: "OK",
    data: {
      items,
      issues,
      status: issues.length === 0 ? "complete" : "partial",
    },
  });
}
