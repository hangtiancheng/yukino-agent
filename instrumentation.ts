export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }
  const { initObservability } = await import("@/lib/observability");
  initObservability();
  const { indexDataDir } = await import("@/lib/ai/pipelines/knowledge-index");
  try {
    await indexDataDir();
  } catch (e) {
    console.error("[instrumentation] startup knowledge indexing failed:", e);
  }
  const { startAutoSyncLoop } = await import("@/lib/devflow/scheduler");
  startAutoSyncLoop();
}
