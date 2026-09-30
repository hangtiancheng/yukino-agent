// Centralize environment variable reading.
// Next.js automatically loads .env / .env.local; importing dotenv/config here serves as a safeguard (for script scenarios).
import "dotenv/config";

export const config = {
  // OpenAI (OpenAI compatible). 'think' is used for planning/replanning, 'quick' is used for execution/chat.
  openai: {
    think: {
      model: process.env.OPENAI_THINK_MODEL ?? "deepseek-v4-flash",
      apiKey: process.env.OPENAI_THINK_API_KEY ?? "",
      baseURL:
        process.env.OPENAI_THINK_BASE_URL ??
        "https://ark.cn-beijing.volces.com/api/v3",
    },
    quick: {
      model: process.env.OPENAI_QUICK_MODEL ?? "deepseek-v4-flash",
      apiKey: process.env.OPENAI_QUICK_API_KEY ?? "",
      baseURL:
        process.env.OPENAI_QUICK_BASE_URL ??
        "https://ark.cn-beijing.volces.com/api/v3",
    },
  },
  anthropic: {
    think: {
      model: process.env.ANTHROPIC_THINK_MODEL ?? "deepseek-v4-flash",
      apiKey: process.env.ANTHROPIC_THINK_API_KEY ?? "",
      baseURL:
        process.env.ANTHROPIC_THINK_BASE_URL ?? "https://api.anthropic.com",
    },
    quick: {
      model: process.env.ANTHROPIC_QUICK_MODEL ?? "deepseek-v4-flash",
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
  // Redis Stack (RediSearch module) — vector database
  redis: {
    url: process.env.REDIS_URL ?? "redis://localhost:6379",
    indexName: process.env.REDIS_INDEX_NAME ?? "idx:biz",
    keyPrefix: process.env.REDIS_KEY_PREFIX ?? "biz:",
  },
  // MCP (Log tool SSE)
  mcpUrl: process.env.MCP_URL ?? "http://localhost:3000/sse",
  // File upload directory
  fileDir: process.env.FILE_DIR ?? "./data/docs",
  // Prometheus
  prometheusBaseUrl: process.env.PROMETHEUS_BASE_URL ?? "http://127.0.0.1:9090",
  // LLM provider selection: "openai" (default) | "anthropic"
  provider: (process.env.LLM_PROVIDER ?? "openai") as "openai" | "anthropic",
  // Embedding provider selection: "openai" (only)
  embeddingProvider: (process.env.EMBEDDING_PROVIDER ?? "openai") as "openai",
} as const;

// Conversation memory window size.
export const MEMORY_WINDOW_SIZE = 6;
