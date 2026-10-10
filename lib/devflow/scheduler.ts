import { config } from "@/lib/config";
import { prisma } from "@/lib/db";
import { syncRepository } from "./sync";

type AutoSyncHandle = {
  timer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
};

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
    handle.timer.unref?.();
  };

  schedule(5000);
}

export function stopAutoSyncLoop(): void {
  const handle = globalForAutoSync.devflowAutoSync;
  if (!handle) return;
  handle.stopped = true;
  if (handle.timer) clearTimeout(handle.timer);
  globalForAutoSync.devflowAutoSync = undefined;
}
