// Next.js instrumentation: runs once per server start.
// Embeds every document in the knowledge-base data directory so the vector
// index is populated without requiring a manual upload first.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }
  const { indexDataDir } = await import("@/lib/ai/pipelines/knowledge-index");
  try {
    await indexDataDir();
  } catch (e) {
    // Never block server boot on indexing problems (e.g. Redis down).
    console.error("[instrumentation] startup knowledge indexing failed:", e);
  }
}
