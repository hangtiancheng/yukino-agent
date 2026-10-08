// Centralize environment variable reading.
// Next.js automatically loads .env / .env.local; importing dotenv/config here serves as a safeguard (for script scenarios).
import "dotenv/config";

export const config = {
  oncallDatabaseUrl: process.env.ONCALL_DATABASE_URL ?? "",
  // OpenAI (OpenAI compatible). 'think' is used for planning/replanning, 'quick' is used for execution/chat.
  openai: {
    think: {
      model: process.env.OPENAI_THINK_MODEL ?? "deepseek-flash",
      apiKey: process.env.OPENAI_THINK_API_KEY ?? "",
      baseURL:
        process.env.OPENAI_THINK_BASE_URL ??
        "https://ark.cn-beijing.volces.com/api/v3",
    },
    quick: {
      model: process.env.OPENAI_QUICK_MODEL ?? "deepseek-flash",
      apiKey: process.env.OPENAI_QUICK_API_KEY ?? "",
      baseURL:
        process.env.OPENAI_QUICK_BASE_URL ??
        "https://ark.cn-beijing.volces.com/api/v3",
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
    thinking: process.env.ANTHROPIC_THINKING !== "false", // default enabled
    maxOutputTokens: Number.parseInt(
      process.env.ANTHROPIC_MAX_OUTPUT_TOKENS ?? "8192",
      10,
    ),
  },
  // OpenAI embedding (OpenAI compatible)
  openaiEmbedding: {
    model: process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-v4",
    apiKey: process.env.OPENAI_EMBEDDING_API_KEY ?? "",
    baseURL:
      process.env.OPENAI_EMBEDDING_BASE_URL ??
      "https://openai.aliyuncs.com/compatible-mode/v1",
  },
  // Rerank (Aliyun DashScope text-rerank API). Optional second-stage ranker
  // applied to Milvus RRF-fused candidates; disabled when apiKey is empty,
  // in which case retrieval keeps the raw fusion order.
  rerank: {
    apiKey: process.env.RERANK_API_KEY ?? "",
    url:
      process.env.RERANK_URL ??
      "https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank",
    model: process.env.RERANK_MODEL ?? "qwen3-vl-rerank",
    timeoutMs: Number.parseInt(process.env.RERANK_TIMEOUT_MS ?? "10000", 10),
    maxRetries: Number.parseInt(process.env.RERANK_MAX_RETRIES ?? "2", 10),
  },
  // Milvus — vector database (dense COSINE + native BM25 hybrid search).
  // Replaces the former Redis Stack vector index.
  milvus: {
    uri: process.env.MILVUS_URI ?? "http://localhost:19530",
    token: process.env.MILVUS_TOKEN ?? "",
    collection: process.env.MILVUS_COLLECTION ?? "yukino_knowledge",
    // BM25 analyzer for the full-text path: "standard" (default) or "chinese".
    analyzer: process.env.MILVUS_ANALYZER ?? "standard",
  },
  // PostgreSQL (Prisma) — relational database. Replaces MySQL/knex.
  // Default port is 5432 because a native PostgreSQL often owns 5432 on dev machines.
  database: {
    url:
      process.env.DATABASE_URL ??
      "postgresql://yukino:yukino@localhost:5432/yukino_agent",
  },
  // MCP (Log tool SSE)
  mcpUrl: process.env.MCP_URL ?? "http://localhost:3000/sse",
  // Admin gate for mutating OnCall operational surfaces (MCP connection CRUD,
  // tool-call audit reads). The product is public/no-login; these endpoints
  // configure server-side outbound connections, so writes require this token
  // when set. Empty = mutations rejected (read-only), reads stay public.
  oncallAdminToken: process.env.ONCALL_ADMIN_TOKEN ?? "",
  // Multi-source alert aggregation (legacy agent_py alerts.py): a JSON array
  // of {name, type: "prometheus"|"alertmanager", baseUrl, username?, password?}
  // read by lib/ai/alerts.ts. Empty = single-source fallback built from
  // PROMETHEUS_BASE_URL below. Same-name alerts are deduped across sources.
  alertSourcesJson: process.env.ALERT_SOURCES ?? "",
  // File upload directory
  fileDir: process.env.FILE_DIR ?? "./data/docs",
  // Prometheus
  prometheusBaseUrl: process.env.PROMETHEUS_BASE_URL ?? "http://127.0.0.1:9090",
  // Langfuse observability (all three required to enable tracing).
  langfuse: {
    publicKey: process.env.LANGFUSE_PUBLIC_KEY ?? "",
    secretKey: process.env.LANGFUSE_SECRET_KEY ?? "",
    baseUrl: process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com",
  },
  // LLM provider selection: "openai" (default) | "anthropic"
  provider: (process.env.LLM_PROVIDER ?? "openai") as "openai" | "anthropic",
  // Embedding provider selection: "openai" (only)
  embeddingProvider: (process.env.EMBEDDING_PROVIDER ?? "openai") as "openai",
  // DevFlow (GitHub collaboration workspace)
  github: {
    token: process.env.GITHUB_TOKEN ?? "",
    apiBaseUrl: process.env.GITHUB_API_BASE_URL ?? "https://api.github.com",
    // Shared secret for verifying inbound GitHub webhook signatures (HMAC-SHA256).
    // When empty, webhook signature verification is skipped (dev only).
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? "",
  },
  devflow: {
    // Key used to encrypt per-repo GitHub tokens at rest (AES-256-GCM).
    secret: process.env.DEVFLOW_SECRET ?? "devflow-local-dev-secret",
    // Periodic background re-sync of connected repositories (see
    // lib/devflow/scheduler.ts, started from instrumentation.ts).
    autoSync: {
      enabled: process.env.DEVFLOW_AUTO_SYNC_ENABLED === "true",
      intervalSeconds: Number.parseInt(
        process.env.DEVFLOW_AUTO_SYNC_INTERVAL_SECONDS ?? "900",
        10,
      ),
      limit: Number.parseInt(process.env.DEVFLOW_AUTO_SYNC_LIMIT ?? "30", 10),
    },
    // Negative-feedback notification (Feishu/Lark incoming webhook) and the
    // public base URL used to build feedback trace links.
    feedback: {
      feishuWebhookUrl: process.env.DEVFLOW_FEISHU_WEBHOOK_URL ?? "",
      traceBaseUrl: process.env.DEVFLOW_FEEDBACK_TRACE_BASE_URL ?? "",
    },
    // Category B: server-side managed git checkouts that back the workspace file
    // tools and project-doc indexing. Clones are shallow (--depth 1) and live on
    // the Node server's disk; disable on serverless deployments.
    workspace: {
      checkoutDir: process.env.DEVFLOW_REPO_CHECKOUT_DIR ?? "./data/workspaces",
      // Safety bounds for clone/refresh and file reads.
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

// Conversation memory window size.
export const MEMORY_WINDOW_SIZE = 6;
// When true, evicted OnCall window pairs are folded into an LLM-maintained
// rolling summary injected into the system prompt (legacy agent_py chat
// memory compaction, simplified to the every_N_turns style trigger).
export const MEMORY_SUMMARY_ENABLED =
  process.env.MEMORY_SUMMARY_ENABLED !== "false";
