// Langfuse observability for the AI Ops pipeline: OTEL export through
// NodeSDK + LangfuseSpanProcessor, a LangChain CallbackHandler for
// LangGraph run/node spans, and generation observations around AI SDK calls.
// Everything degrades to a no-op when the LANGFUSE_* env vars are unset.
import { CallbackHandler } from "@langfuse/langchain";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  propagateAttributes,
  startActiveObservation,
  type LangfuseGeneration,
} from "@langfuse/tracing";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { config } from "@/lib/config";

const AI_OPS_TAGS = ["ai-ops"];
const AI_OPS_METADATA = { pipeline: "plan-execute-replan" };

// Cached on globalThis: Next.js dev reloads modules across HMR, but the OTEL
// global provider registration persists for the process lifetime.
const globalStore = globalThis as typeof globalThis & {
  __yukinoObservabilitySdk?: NodeSDK;
};

export function langfuseEnabled(): boolean {
  return Boolean(
    config.langfuse.publicKey &&
    config.langfuse.secretKey &&
    config.langfuse.baseUrl,
  );
}

export function initObservability(): void {
  if (!langfuseEnabled() || globalStore.__yukinoObservabilitySdk) {
    return;
  }
  try {
    const sdk = new NodeSDK({
      spanProcessors: [
        new LangfuseSpanProcessor({
          publicKey: config.langfuse.publicKey,
          secretKey: config.langfuse.secretKey,
          baseUrl: config.langfuse.baseUrl,
        }),
      ],
    });
    sdk.start();
    globalStore.__yukinoObservabilitySdk = sdk;
    console.log(
      `[observability] langfuse tracing enabled (${config.langfuse.baseUrl})`,
    );
  } catch (e) {
    console.warn(
      "[observability] failed to start langfuse tracing; continuing without it:",
      e,
    );
  }
}

export async function shutdownObservability(): Promise<void> {
  const sdk = globalStore.__yukinoObservabilitySdk;
  if (!sdk) {
    return;
  }
  delete globalStore.__yukinoObservabilitySdk;
  await sdk.shutdown();
}

// One Langfuse trace per graph run (node-level spans included); sessionId
// groups runs that belong to the same AI Ops invocation.
export function aiOpsCallbacks(sessionId: string): CallbackHandler[] {
  if (!langfuseEnabled()) {
    return [];
  }
  return [
    new CallbackHandler({
      sessionId,
      tags: AI_OPS_TAGS,
      traceMetadata: AI_OPS_METADATA,
    }),
  ];
}

// Propagates session/tags so spans created inside fn — including observations
// that are not parented under the graph trace — group into the same Langfuse
// session.
export async function withAiOpsTrace<T>(
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!langfuseEnabled()) {
    return fn();
  }
  return propagateAttributes(
    { sessionId, tags: AI_OPS_TAGS, metadata: AI_OPS_METADATA },
    fn,
  );
}

// Records a single LLM call as a Langfuse generation; when disabled the
// function runs without an observation object.
export async function observeGeneration<T>(
  name: string,
  fn: (generation?: LangfuseGeneration) => Promise<T>,
): Promise<T> {
  if (!langfuseEnabled()) {
    return fn();
  }
  return startActiveObservation(name, fn, { asType: "generation" });
}
