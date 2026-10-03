// Centralize environment variable reading.
// Next.js automatically loads .env / .env.local; importing dotenv/config here serves as a safeguard (for script scenarios).
import "dotenv/config";

export const config = {
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
  // Default port is 5433 because a native PostgreSQL often owns 5432 on dev machines.
  database: {
    url:
      process.env.DATABASE_URL ??
      "postgresql://yukino:yukino@localhost:5433/yukino_agent",
  },
  // MCP (Log tool SSE)
  mcpUrl: process.env.MCP_URL ?? "http://localhost:3000/sse",
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
  },
  devflow: {
    // Falls back to the shared MYSQL_DSN when not set explicitly.
    mysqlDsn: process.env.DEVFLOW_MYSQL_DSN ?? process.env.MYSQL_DSN ?? "",
    database: process.env.DEVFLOW_MYSQL_DATABASE ?? "devflow",
    // Key used to encrypt per-repo GitHub tokens at rest (AES-256-GCM).
    secret: process.env.DEVFLOW_SECRET ?? "devflow-local-dev-secret",
  },
} as const;

// Conversation memory window size.
export const MEMORY_WINDOW_SIZE = 6;
