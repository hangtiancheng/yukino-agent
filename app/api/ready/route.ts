// GET /api/ready — dependency readiness probe (port of the agent_py
// readiness/config-check routes). Each check reports ok + latency + short
// detail; the endpoint returns 200 when the core checks (database, vector
// store) pass, 503 otherwise. Optional integrations (rerank, Langfuse,
// Prometheus, MCP, alert sources) degrade to ok=false informational
// entries, never to 503 — same "single dependency fails, surface degrades"
// shape as the legacy /ready payload (agent_py app.py:1900-1990).
import { getTranslations } from "next-intl/server";
import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { count as milvusCount } from "@/lib/milvus/client";
import { probeAlertSources } from "@/lib/ai/alerts";

type BaseCheckName =
  | "database"
  | "vectorStore"
  | "embedding"
  | "llm"
  | "rerank"
  | "prometheus"
  | "mcp";

interface CheckResult {
  name: BaseCheckName | string;
  ok: boolean;
  latencyMs: number;
  detail: string;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`probe timed out after ${ms}ms`)), ms),
    ),
  ]);
}

async function check(
  name: BaseCheckName | string,
  fn: () => Promise<{ ok: boolean; detail: string }>,
): Promise<CheckResult> {
  const started = Date.now();
  try {
    const res = await fn();
    return {
      name,
      ok: res.ok,
      latencyMs: Date.now() - started,
      detail: res.detail,
    };
  } catch (e) {
    return {
      name,
      ok: false,
      latencyMs: Date.now() - started,
      detail: e instanceof Error ? e.message.slice(0, 200) : String(e),
    };
  }
}

export async function GET() {
  const t = await getTranslations("api.oncall");

  const database = await check("database", async () => {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, detail: "postgresql reachable" };
  });
  const vectorStore = await check("vectorStore", async () => {
    await withTimeout(milvusCount(), 16_000);
    return {
      ok: true,
      detail: `collection ${config.milvus.collection} loaded`,
    };
  });
  // Config-presence checks (no outbound LLM/embedding calls — the readiness
  // probe must stay cheap and side-effect-free; real credentials are exercised
  // by the smoke tests instead).
  const embedding = await check("embedding", async () => {
    return {
      ok: config.openaiEmbedding.apiKey !== "",
      detail:
        config.openaiEmbedding.apiKey !== ""
          ? config.openaiEmbedding.model
          : t("readinessUnconfigured"),
    };
  });
  const llm = await check("llm", async () => {
    const key =
      config.provider === "anthropic"
        ? config.anthropic.quick.apiKey
        : config.openai.quick.apiKey;
    return {
      ok: key !== "",
      detail:
        key !== "" ? t("readinessConfigured") : t("readinessUnconfigured"),
    };
  });
  const rerank = await check("rerank", async () => {
    return {
      ok: config.rerank.apiKey !== "",
      detail:
        config.rerank.apiKey !== ""
          ? config.rerank.model
          : t("readinessDisabled"),
    };
  });
  const prometheus = await check("prometheus", async () => {
    const res = await fetch(`${config.prometheusBaseUrl}/-/ready`, {
      signal: AbortSignal.timeout(4000),
    });
    return { ok: res.ok, detail: `HTTP ${res.status}` };
  });
  const mcp = await check("mcp", async () => {
    // Reachability only: any HTTP answer proves the endpoint is up (the SSE
    // body itself is a long-lived stream — headers are enough here).
    const res = await fetch(config.mcpUrl, {
      signal: AbortSignal.timeout(3000),
    });
    return { ok: true, detail: `HTTP ${res.status}` };
  });
  // Per-source alert reachability (legacy alert-provider readiness): one
  // dead source marks only its own entry degraded.
  const alertProbes = await probeAlertSources(3000);
  const alertChecks: CheckResult[] = await Promise.all(
    Object.entries(alertProbes).map(async ([name, probe]) => {
      const res = await probe();
      return {
        name,
        ok: res.ok,
        latencyMs: res.latencyMs ?? 0,
        detail: res.detail ?? "",
      };
    }),
  );

  const results: CheckResult[] = [
    database,
    vectorStore,
    embedding,
    llm,
    rerank,
    prometheus,
    mcp,
    ...alertChecks,
  ];
  const coreOk = database.ok && vectorStore.ok;
  return Response.json(
    {
      message: coreOk ? "OK" : t("readinessDegraded"),
      data: { status: coreOk ? "ready" : "degraded", checks: results },
    },
    { status: coreOk ? 200 : 503 },
  );
}
