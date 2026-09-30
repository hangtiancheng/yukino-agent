"use client";

// import { RandomCrash } from "@/crash";
// import { startErrorSeeder } from "@/crash/seeder";
import { enablePlugin, init, isInitialized } from "@yukino.js/sentry";
import { ExposurePlugin, PerformancePlugin } from "@yukino.js/sentry/plugins";
import { ReactErrorBoundary } from "@yukino.js/sentry/react";
import type { ReactNode } from "react";

// Browser-only SDK: this module is also evaluated during SSR of client
// components, so gate on window before touching it.
//
// Oversized single events (rrweb ScreenRecord payloads, ResourceList on dev
// pages that load hundreds of modules) push the batch past the 64KB
// fetch-keepalive body limit, permanently wedging every retry — drop them.
const MAX_EVENT_BYTES = 50 * 1024;

// https://github.com/toss/es-toolkit/blob/main/src/predicate/isBrowser.ts
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

  // if (process.env.NODE_ENV === "development") {
  //   startErrorSeeder();
  // }
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
      {/* {process.env.NODE_ENV === "development" && <RandomCrash />} */}
    </ReactErrorBoundary>
  );
}
