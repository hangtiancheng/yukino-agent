"use client";

import { enablePlugin, init, isInitialized } from "@yukino.js/sentry";
import { ExposurePlugin, PerformancePlugin } from "@yukino.js/sentry/plugins";
import { ReactErrorBoundary } from "@yukino.js/sentry/react";
import type { ReactNode } from "react";

const MAX_EVENT_BYTES = 50 * 1024;

function isBrowser(): boolean {
  return typeof window !== "undefined" && window?.document != null;
}

if (isBrowser() && !isInitialized()) {
  init({
    dsn: "/api/log",
    projectId: "yukino-agent",
    debug: true,
    beforeSendBatch: (eventList) =>
      eventList.filter(
        (item) => JSON.stringify(item).length <= MAX_EVENT_BYTES,
      ),
  });
  enablePlugin(new PerformancePlugin(), new ExposurePlugin());
}

export function SentryProvider({ children }: { children: ReactNode }) {
  return (
    <ReactErrorBoundary
      fallback={
        <div className="flex min-h-screen flex-col items-center justify-center gap-2">
          <p className="text-lg font-medium">Something went wrong</p>
          <p className="text-muted-foreground text-sm">
            The error has been reported. Please refresh the page.
          </p>
        </div>
      }
    >
      {children}
    </ReactErrorBoundary>
  );
}
