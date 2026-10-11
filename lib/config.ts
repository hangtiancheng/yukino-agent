import "dotenv/config";

export const config = {
  oncallDatabaseUrl: process.env.ONCALL_DATABASE_URL ?? "",
  openai: {
    think: {
      model: process.env.OPENAI_THINK_MODEL ?? "deepseek-flash",
      apiKey: process.env.OPENAI_THINK_API_KEY ?? "",
      baseURL: process.env.OPENAI_THINK_BASE_URL ?? "https://api.deepseek.com",
    },
    quick: {
      model: process.env.OPENAI_QUICK_MODEL ?? "deepseek-flash",
      apiKey: process.env.OPENAI_QUICK_API_KEY ?? "",
      baseURL: process.env.OPENAI_QUICK_BASE_URL ?? "https://api.deepseek.com",
    },
  },
  anthropic: {
    think: {
      model: process.env.ANTHROPIC_THINK_MODEL ?? "deepseek-flash",
      apiKey: process.env.ANTHROPIC_THINK_API_KEY ?? "",
      baseURL:
        process.env.ANTHROPIC_THINK_BASE_URL ?? "https://api.anthropic.com",
    },
    quick: {
      model: process.env.ANTHROPIC_QUICK_MODEL ?? "deepseek-flash",
      apiKey: process.env.ANTHROPIC_QUICK_API_KEY ?? "",
      baseURL:
        process.env.ANTHROPIC_QUICK_BASE_URL ?? "https://api.anthropic.com",
    },
    thinking: process.env.ANTHROPIC_THINKING !== "false",
    maxOutputTokens: Number.parseInt(
      process.env.ANTHROPIC_MAX_OUTPUT_TOKENS ?? "8192",
      10,
    ),
  },
  openaiEmbedding: {
    model: process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-v4",
    apiKey: process.env.OPENAI_EMBEDDING_API_KEY ?? "",
    baseURL:
      process.env.OPENAI_EMBEDDING_BASE_URL ??
      "https://openai.aliyuncs.com/compatible-mode/v1",
  },
  rerank: {
    apiKey: process.env.RERANK_API_KEY ?? "",
    url:
      process.env.RERANK_URL ??
      "https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank",
    model: process.env.RERANK_MODEL ?? "qwen3-vl-rerank",
    timeoutMs: Number.parseInt(process.env.RERANK_TIMEOUT_MS ?? "10000", 10),
    maxRetries: Number.parseInt(process.env.RERANK_MAX_RETRIES ?? "2", 10),
  },
  milvus: {
    uri: process.env.MILVUS_URI ?? "http://localhost:19530",
    token: process.env.MILVUS_TOKEN ?? "",
    collection: process.env.MILVUS_COLLECTION ?? "yukino_knowledge",
    analyzer: process.env.MILVUS_ANALYZER ?? "standard",
  },
  database: {
    url:
      process.env.DATABASE_URL ??
      "postgresql://yukino:yukino@localhost:5432/yukino_agent",
  },
  mcpUrl: process.env.MCP_URL ?? "http://localhost:3000/sse",
  oncallAdminToken: process.env.ONCALL_ADMIN_TOKEN ?? "",
  alertSourcesJson: process.env.ALERT_SOURCES ?? "",
  fileDir: process.env.FILE_DIR ?? "./data/docs",
  prometheusBaseUrl: process.env.PROMETHEUS_BASE_URL ?? "http://127.0.0.1:9090",
  langfuse: {
    publicKey: process.env.LANGFUSE_PUBLIC_KEY ?? "",
    secretKey: process.env.LANGFUSE_SECRET_KEY ?? "",
    baseUrl: process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com",
  },
  provider: (process.env.LLM_PROVIDER ?? "openai") as "openai" | "anthropic",
  embeddingProvider: (process.env.EMBEDDING_PROVIDER ?? "openai") as "openai",
  github: {
    token: process.env.GITHUB_TOKEN ?? "",
    apiBaseUrl: process.env.GITHUB_API_BASE_URL ?? "https://api.github.com",
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? "",
  },
  devflow: {
    secret: process.env.DEVFLOW_SECRET ?? "devflow-local-dev-secret",
    autoSync: {
      enabled: process.env.DEVFLOW_AUTO_SYNC_ENABLED === "true",
      intervalSeconds: Number.parseInt(
        process.env.DEVFLOW_AUTO_SYNC_INTERVAL_SECONDS ?? "900",
        10,
      ),
      limit: Number.parseInt(process.env.DEVFLOW_AUTO_SYNC_LIMIT ?? "30", 10),
    },
    feedback: {
      feishuWebhookUrl: process.env.DEVFLOW_FEISHU_WEBHOOK_URL ?? "",
      traceBaseUrl: process.env.DEVFLOW_FEEDBACK_TRACE_BASE_URL ?? "",
    },
    workspace: {
      checkoutDir: process.env.DEVFLOW_REPO_CHECKOUT_DIR ?? "./data/workspaces",
      gitTimeoutMs: Number.parseInt(
        process.env.DEVFLOW_GIT_TIMEOUT_MS ?? "180000",
        10,
      ),
      maxFileBytes: Number.parseInt(
        process.env.DEVFLOW_MAX_FILE_BYTES ?? "300000",
        10,
      ),
      maxScanFiles: Number.parseInt(
        process.env.DEVFLOW_MAX_SCAN_FILES ?? "2000",
        10,
      ),
    },
  },
} as const;

export const MEMORY_WINDOW_SIZE = 6;
export const MEMORY_SUMMARY_ENABLED =
  process.env.MEMORY_SUMMARY_ENABLED !== "false";
