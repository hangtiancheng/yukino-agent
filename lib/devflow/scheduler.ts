// Periodic background re-sync of connected GitHub repositories. Port of the
// Python services/scheduler.py loop. Started from instrumentation.ts so it runs
// in the Node server process. A recursive setTimeout (not setInterval) is used
// so a slow sync never overlaps the next tick; per-repo failures are logged and
// never stop the loop.
//
// CAVEAT: this is an in-process loop, faithful to the Python design. It is only
// meaningful on a long-lived Node server. On serverless deployments (and during
// `next build`) it should stay disabled via DEVFLOW_AUTO_SYNC_ENABLED.
import { config } from "@/lib/config";
import { prisma } from "@/lib/db";
import { syncRepository } from "./sync";

type AutoSyncHandle = { timer: ReturnType<typeof setTimeout> | null; stopped: boolean };

const globalForAutoSync = globalThis as unknown as {
  devflowAutoSync?: AutoSyncHandle;
};

const MIN_INTERVAL_SECONDS = 30;

async function runOnce(limit: number): Promise<void> {
  const repos = await prisma.repository.findMany({
    where: { provider: { in: ["github", "github_compatible"] } },
    select: { id: true, fullName: true },
  });
  for (const repo of repos) {
    try {
      await syncRepository(repo.id, { limit });
    } catch (e) {
      console.warn(
        `[devflow:auto-sync] periodic sync failed for ${repo.fullName}:`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }
}

export function startAutoSyncLoop(): void {
  const { enabled, intervalSeconds, limit } = config.devflow.autoSync;
  if (!enabled) return;

  // Survive Next.js dev hot-reload: reuse the existing loop instead of
  // stacking a new one on every module re-evaluation.
  if (globalForAutoSync.devflowAutoSync) return;

  const handle: AutoSyncHandle = { timer: null, stopped: false };
  globalForAutoSync.devflowAutoSync = handle;
  console.log(
    `[devflow:auto-sync] enabled (interval=${Math.max(intervalSeconds, MIN_INTERVAL_SECONDS)}s, limit=${limit})`,
  );

  const schedule = (delayMs: number) => {
    handle.timer = setTimeout(async () => {
      if (handle.stopped) return;
      try {
        await runOnce(limit);
      } catch (e) {
        console.warn(
          "[devflow:auto-sync] tick failed:",
          e instanceof Error ? e.message : String(e),
        );
      }
      schedule(Math.max(intervalSeconds, MIN_INTERVAL_SECONDS) * 1000);
    }, delayMs);
    // Do not keep the Node process alive just for the sync loop.
    handle.timer.unref?.();
  };

  // Mirror the Python loop's small startup delay.
  schedule(5000);
}

export function stopAutoSyncLoop(): void {
  const handle = globalForAutoSync.devflowAutoSync;
  if (!handle) return;
  handle.stopped = true;
  if (handle.timer) clearTimeout(handle.timer);
  globalForAutoSync.devflowAutoSync = undefined;
}
