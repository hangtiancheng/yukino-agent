// Bridges yukino-sentry browser reports and Node/V8 runtime state to Prometheus:
// POST /api/log feeds the browser metrics, GET /api/metrics exposes them plus the
// runtime collectors for scraping.
import { performance } from "node:perf_hooks";
import v8 from "node:v8";

import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
  type GaugeConfiguration,
} from "prom-client";
import { z } from "zod/v4";

const reportItemSchema = z.looseObject({
  type: z.string(),
  name: z.string().optional(),
  status: z.string().optional(),
  projectId: z.string().optional(),
  payload: z.unknown().optional(),
});

export const reportBatchSchema = z.array(reportItemSchema);

export type ReportItem = z.infer<typeof reportItemSchema>;

const extraCarrierSchema = z.looseObject({ extra: z.unknown() });

const httpPayloadSchema = z.looseObject({
  method: z.string().optional(),
  statusCode: z.number().optional(),
  elapsedTime: z.number().optional(),
});

const performanceValueSchema = z.looseObject({
  value: z.number().optional(),
  rating: z.string().optional(),
});

const batchErrorPayloadSchema = z.looseObject({
  batchError: z.literal(true),
  batchErrorLength: z.number(),
});

const clickExtraSchema = z.looseObject({
  ev: z.string().optional(),
  msg: z.string().optional(),
});

const durationExtraSchema = z.looseObject({ duration: z.number().optional() });

const resourceTimingSchema = z.looseObject({
  initiatorType: z.string().optional(),
  duration: z.number().optional(),
  transferSize: z.number().optional(),
  fromCache: z.boolean().optional(),
});

const resourceTimingExtraSchema = z.looseObject({
  resource: resourceTimingSchema,
});

const resourceListPayloadSchema = z.looseObject({
  resourceList: z.array(resourceTimingSchema),
});

const longTaskPayloadSchema = z.looseObject({
  longTasks: z.array(z.looseObject({ duration: z.number().optional() })),
});

const memoryPayloadSchema = z.looseObject({
  memory: z.looseObject({
    bytes: z.number().optional(),
    breakdown: z
      .array(
        z.looseObject({
          bytes: z.number(),
          types: z.array(z.string()).optional(),
        }),
      )
      .optional(),
  }),
});

const numericRecordSchema = z.record(z.string(), z.unknown());

type ResourceTiming = z.infer<typeof resourceTimingSchema>;

// Web vitals share one gauge; every other Performance event carries an unrelated
// unit (bytes, task counts) and must not land in the same series.
const WEB_VITAL_NAMES = new Set(["LCP", "FCP", "CLS", "INP", "TTFB", "FSP"]);

const NAVIGATION_PHASES = [
  "paintTime",
  "domInteractive",
  "domContentLoaded",
  "loadEvent",
  "firstByte",
  "dnsLookup",
  "tcpConnection",
  "tlsHandshake",
  "timeToFirstByte",
  "contentTransfer",
  "domProcessing",
  "resourceLoad",
  "redirect",
  "unloadTime",
];

// Browser-supplied strings (error names, click ids, custom event names) are
// attacker- and refactor-controlled; collapsing the tail keeps a bad deploy from
// exploding Prometheus series count.
const MAX_LABEL_VALUES = 50;

// Bump whenever the metric set changes. loadMetrics() throws away a cached
// registry whose version does not match, which is what keeps a long-lived dev
// server from serving an object with undefined metric fields.
const METRICS_VERSION = 2;

interface SentryMetrics {
  version: number;
  registry: Registry;
  labelValues: Map<string, Set<string>>;
  eventsTotal: Counter<"type" | "status" | "project_id">;
  eventLastSeen: Gauge<"type" | "project_id">;
  errorsTotal: Counter<"type" | "name" | "project_id">;
  batchErrorGroupsTotal: Counter<"type" | "name" | "project_id">;
  resourceErrorsTotal: Counter<"tag" | "project_id">;
  httpRequestsTotal: Counter<
    "method" | "status_code" | "status" | "project_id"
  >;
  httpRequestDurationMs: Histogram<"method" | "status_code" | "project_id">;
  webVitals: Gauge<"name" | "rating" | "project_id">;
  webVitalSamplesTotal: Counter<"name" | "rating" | "project_id">;
  navigationTimingMs: Histogram<"phase" | "project_id">;
  resourceEntriesTotal: Counter<"initiator_type" | "from_cache" | "project_id">;
  resourceDurationMs: Histogram<"initiator_type" | "from_cache" | "project_id">;
  resourceTransferBytes: Histogram<"initiator_type" | "project_id">;
  longTasksTotal: Counter<"project_id">;
  longTaskDurationMs: Histogram<"project_id">;
  browserMemoryBytes: Gauge<"project_id">;
  browserMemoryBreakdownBytes: Gauge<"kind" | "project_id">;
  clicksTotal: Counter<"ev" | "project_id">;
  exposuresTotal: Counter<"project_id">;
  exposureDurationMs: Histogram<"project_id">;
  whiteScreensTotal: Counter<"project_id">;
  pageViewsTotal: Counter<"name" | "project_id">;
  pageDwellMs: Histogram<"project_id">;
  customEventsTotal: Counter<"name" | "project_id">;
  performanceValue: Gauge<"name" | "project_id">;
  reportBatchesTotal: Counter<"outcome">;
  reportBatchSize: Histogram<string>;
}

function createMetrics(): SentryMetrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  registerRuntimeMetrics(registry);
  return {
    version: METRICS_VERSION,
    registry,
    labelValues: new Map(),
    eventsTotal: new Counter({
      name: "yukino_sentry_events_total",
      help: "Events reported by the yukino-sentry browser SDK, by type and status.",
      labelNames: ["type", "status", "project_id"],
      registers: [registry],
    }),
    eventLastSeen: new Gauge({
      name: "yukino_sentry_event_last_seen_timestamp_seconds",
      help: "Unix timestamp of the most recent SDK event of each type.",
      labelNames: ["type", "project_id"],
      registers: [registry],
    }),
    errorsTotal: new Counter({
      name: "yukino_sentry_errors_total",
      help: "Browser errors (Error/React/Vue/OtherFrameworks), counting each event inside a batched group.",
      labelNames: ["type", "name", "project_id"],
      registers: [registry],
    }),
    batchErrorGroupsTotal: new Counter({
      name: "yukino_sentry_batch_error_groups_total",
      help: "Error bursts the SDK collapsed into a single batched report (5+ identical errors within 2s).",
      labelNames: ["type", "name", "project_id"],
      registers: [registry],
    }),
    resourceErrorsTotal: new Counter({
      name: "yukino_sentry_resource_errors_total",
      help: "Static resource load failures, by failing element tag (img/script/link).",
      labelNames: ["tag", "project_id"],
      registers: [registry],
    }),
    httpRequestsTotal: new Counter({
      name: "yukino_sentry_http_requests_total",
      help: "Browser-side XHR/fetch requests. Successes only appear when the SDK runs with enableHttpPerformance.",
      labelNames: ["method", "status_code", "status", "project_id"],
      registers: [registry],
    }),
    httpRequestDurationMs: new Histogram({
      name: "yukino_sentry_http_request_duration_ms",
      help: "Browser-side HTTP request duration in milliseconds (XHR/fetch events).",
      labelNames: ["method", "status_code", "project_id"],
      buckets: [50, 100, 300, 500, 1000, 3000, 10000],
      registers: [registry],
    }),
    webVitals: new Gauge({
      name: "yukino_sentry_web_vitals",
      help: "Latest web vital value (LCP/FCP/INP/TTFB/FSP in ms, CLS unitless).",
      labelNames: ["name", "rating", "project_id"],
      registers: [registry],
    }),
    webVitalSamplesTotal: new Counter({
      name: "yukino_sentry_web_vital_samples_total",
      help: "Web vital samples by rating, for rate-based degradation alerts.",
      labelNames: ["name", "rating", "project_id"],
      registers: [registry],
    }),
    navigationTimingMs: new Histogram({
      name: "yukino_sentry_navigation_timing_ms",
      help: "Page navigation timing phases in milliseconds.",
      labelNames: ["phase", "project_id"],
      buckets: [10, 50, 100, 300, 500, 1000, 2000, 5000, 10000, 30000],
      registers: [registry],
    }),
    resourceEntriesTotal: new Counter({
      name: "yukino_sentry_resource_entries_total",
      help: "Static resource timing entries, by initiator type and cache hit.",
      labelNames: ["initiator_type", "from_cache", "project_id"],
      registers: [registry],
    }),
    resourceDurationMs: new Histogram({
      name: "yukino_sentry_resource_duration_ms",
      help: "Static resource load duration in milliseconds.",
      labelNames: ["initiator_type", "from_cache", "project_id"],
      buckets: [10, 50, 100, 300, 500, 1000, 3000, 10000],
      registers: [registry],
    }),
    resourceTransferBytes: new Histogram({
      name: "yukino_sentry_resource_transfer_bytes",
      help: "Static resource transfer size in bytes (0 for cache hits).",
      labelNames: ["initiator_type", "project_id"],
      buckets: [1024, 10240, 51200, 102400, 512000, 1048576, 5242880],
      registers: [registry],
    }),
    longTasksTotal: new Counter({
      name: "yukino_sentry_long_tasks_total",
      help: "Main-thread long tasks observed in the browser.",
      labelNames: ["project_id"],
      registers: [registry],
    }),
    longTaskDurationMs: new Histogram({
      name: "yukino_sentry_long_task_duration_ms",
      help: "Main-thread long task duration in milliseconds.",
      labelNames: ["project_id"],
      buckets: [50, 100, 200, 500, 1000, 2000, 5000],
      registers: [registry],
    }),
    browserMemoryBytes: new Gauge({
      name: "yukino_sentry_browser_memory_bytes",
      help: "Browser tab memory from performance.measureUserAgentSpecificMemory (Chromium only).",
      labelNames: ["project_id"],
      registers: [registry],
    }),
    browserMemoryBreakdownBytes: new Gauge({
      name: "yukino_sentry_browser_memory_breakdown_bytes",
      help: "Browser tab memory breakdown by reported allocation type.",
      labelNames: ["kind", "project_id"],
      registers: [registry],
    }),
    clicksTotal: new Counter({
      name: "yukino_sentry_clicks_total",
      help: "Declarative click events, by yukino-sentry-ev identifier.",
      labelNames: ["ev", "project_id"],
      registers: [registry],
    }),
    exposuresTotal: new Counter({
      name: "yukino_sentry_exposures_total",
      help: "Element exposure events completed (element left the viewport after being visible).",
      labelNames: ["project_id"],
      registers: [registry],
    }),
    exposureDurationMs: new Histogram({
      name: "yukino_sentry_exposure_duration_ms",
      help: "Element visible duration in milliseconds.",
      labelNames: ["project_id"],
      buckets: [100, 500, 1000, 3000, 10000, 30000, 60000],
      registers: [registry],
    }),
    whiteScreensTotal: new Counter({
      name: "yukino_sentry_white_screens_total",
      help: "White-screen detections reported by the SDK sampler.",
      labelNames: ["project_id"],
      registers: [registry],
    }),
    pageViewsTotal: new Counter({
      name: "yukino_sentry_page_views_total",
      help: "Page view events, by lifecycle name (PageLoad/HistoryChange/HashChange/ManualPageView/PageDwell).",
      labelNames: ["name", "project_id"],
      registers: [registry],
    }),
    pageDwellMs: new Histogram({
      name: "yukino_sentry_page_dwell_ms",
      help: "Time spent on a page before navigating away, in milliseconds.",
      labelNames: ["project_id"],
      buckets: [1000, 5000, 15000, 30000, 60000, 300000, 900000],
      registers: [registry],
    }),
    customEventsTotal: new Counter({
      name: "yukino_sentry_custom_events_total",
      help: "Business events reported through traceCustomEvent.",
      labelNames: ["name", "project_id"],
      registers: [registry],
    }),
    performanceValue: new Gauge({
      name: "yukino_sentry_performance_value",
      help: "Latest value of Performance events that are not web vitals (e.g. tracePerformance metrics).",
      labelNames: ["name", "project_id"],
      registers: [registry],
    }),
    reportBatchesTotal: new Counter({
      name: "yukino_sentry_report_batches_total",
      help: "Report batches received at /api/log, by validation outcome.",
      labelNames: ["outcome"],
      registers: [registry],
    }),
    reportBatchSize: new Histogram({
      name: "yukino_sentry_report_batch_size",
      help: "Number of events per accepted report batch.",
      buckets: [1, 2, 5, 10, 20, 50, 100],
      registers: [registry],
    }),
  };
}

function defineGauge<T extends string>(
  config: GaugeConfiguration<T>,
): Gauge<T> {
  return new Gauge(config);
}

// prom-client defaults already cover event loop lag, GC duration, heap spaces,
// RSS and CPU. These fill the gaps that matter for V8 memory forensics:
// heap_size_limit (OOM headroom), detached contexts (leak fingerprint),
// array buffers, code/bytecode growth, and event loop utilization.
function registerRuntimeMetrics(registry: Registry): void {
  defineGauge({
    name: "yukino_node_memory_bytes",
    help: "Node process memory usage from process.memoryUsage().",
    labelNames: ["kind"],
    registers: [registry],
    collect() {
      const usage = process.memoryUsage();
      this.set({ kind: "rss" }, usage.rss);
      this.set({ kind: "heap_total" }, usage.heapTotal);
      this.set({ kind: "heap_used" }, usage.heapUsed);
      this.set({ kind: "external" }, usage.external);
      this.set({ kind: "array_buffers" }, usage.arrayBuffers);
    },
  });

  defineGauge({
    name: "yukino_node_v8_heap_bytes",
    help: "V8 heap statistics from v8.getHeapStatistics().",
    labelNames: ["kind"],
    registers: [registry],
    collect() {
      const stats = v8.getHeapStatistics();
      this.set({ kind: "total_heap_size" }, stats.total_heap_size);
      this.set(
        { kind: "total_heap_size_executable" },
        stats.total_heap_size_executable,
      );
      this.set({ kind: "total_physical_size" }, stats.total_physical_size);
      this.set({ kind: "total_available_size" }, stats.total_available_size);
      this.set({ kind: "used_heap_size" }, stats.used_heap_size);
      this.set({ kind: "heap_size_limit" }, stats.heap_size_limit);
      this.set({ kind: "malloced_memory" }, stats.malloced_memory);
      this.set({ kind: "peak_malloced_memory" }, stats.peak_malloced_memory);
      this.set({ kind: "external_memory" }, stats.external_memory);
      this.set(
        { kind: "total_global_handles_size" },
        stats.total_global_handles_size,
      );
      this.set(
        { kind: "used_global_handles_size" },
        stats.used_global_handles_size,
      );
    },
  });

  defineGauge({
    name: "yukino_node_v8_heap_used_ratio",
    help: "V8 used_heap_size divided by heap_size_limit; 1.0 means an imminent OOM.",
    registers: [registry],
    collect() {
      const stats = v8.getHeapStatistics();
      this.set(
        stats.heap_size_limit > 0
          ? stats.used_heap_size / stats.heap_size_limit
          : 0,
      );
    },
  });

  defineGauge({
    name: "yukino_node_v8_contexts",
    help: "V8 context counts; a growing detached count is the classic memory-leak fingerprint.",
    labelNames: ["kind"],
    registers: [registry],
    collect() {
      const stats = v8.getHeapStatistics();
      this.set({ kind: "native" }, stats.number_of_native_contexts);
      this.set({ kind: "detached" }, stats.number_of_detached_contexts);
    },
  });

  defineGauge({
    name: "yukino_node_v8_code_bytes",
    help: "V8 code and script memory from v8.getHeapCodeStatistics().",
    labelNames: ["kind"],
    registers: [registry],
    collect() {
      const stats = v8.getHeapCodeStatistics();
      this.set({ kind: "code_and_metadata" }, stats.code_and_metadata_size);
      this.set(
        { kind: "bytecode_and_metadata" },
        stats.bytecode_and_metadata_size,
      );
      this.set(
        { kind: "external_script_source" },
        stats.external_script_source_size,
      );
    },
  });

  let previousUtilization = performance.eventLoopUtilization();
  defineGauge({
    name: "yukino_node_eventloop_utilization",
    help: "Fraction of time the event loop was active since the previous scrape (0-1).",
    registers: [registry],
    collect() {
      const current = performance.eventLoopUtilization();
      this.set(
        performance.eventLoopUtilization(current, previousUtilization)
          .utilization,
      );
      previousUtilization = current;
    },
  });

  defineGauge({
    name: "yukino_node_max_rss_bytes",
    help: "Peak resident set size of the process since start.",
    registers: [registry],
    collect() {
      this.set(process.resourceUsage().maxRSS * 1024);
    },
  });

  defineGauge({
    name: "yukino_node_page_faults",
    help: "Page faults since process start; a rising major count means the process is swapping.",
    labelNames: ["kind"],
    registers: [registry],
    collect() {
      const usage = process.resourceUsage();
      this.set({ kind: "minor" }, usage.minorPageFault);
      this.set({ kind: "major" }, usage.majorPageFault);
    },
  });

  defineGauge({
    name: "yukino_node_context_switches",
    help: "Context switches since process start; involuntary switches indicate CPU contention.",
    labelNames: ["kind"],
    registers: [registry],
    collect() {
      const usage = process.resourceUsage();
      this.set({ kind: "voluntary" }, usage.voluntaryContextSwitches);
      this.set({ kind: "involuntary" }, usage.involuntaryContextSwitches);
    },
  });

  defineGauge({
    name: "yukino_node_fs_operations",
    help: "Filesystem read/write operations performed since process start.",
    labelNames: ["kind"],
    registers: [registry],
    collect() {
      const usage = process.resourceUsage();
      this.set({ kind: "read" }, usage.fsRead);
      this.set({ kind: "write" }, usage.fsWrite);
    },
  });
}

declare global {
  // Route bundles and dev HMR re-evaluate this module; the globalThis cache
  // keeps a single registry per Node process so counters never reset or
  // double-register.
  var __yukinoSentryMetrics: SentryMetrics | undefined;
}

function loadMetrics(): SentryMetrics {
  const cached = globalThis.__yukinoSentryMetrics;
  // A cache built by an earlier version of this module is typed as
  // SentryMetrics but is missing every field added since, so trusting it throws
  // TypeError on the first use. Rebuilding costs one counter reset instead.
  if (cached?.version === METRICS_VERSION) {
    return cached;
  }
  const created = createMetrics();
  globalThis.__yukinoSentryMetrics = created;
  return created;
}

export const sentryMetrics: SentryMetrics = loadMetrics();

function boundedLabel(key: string, value: string | undefined): string {
  const raw = value?.trim();
  if (!raw) {
    return "unknown";
  }
  const seen = sentryMetrics.labelValues.get(key) ?? new Set<string>();
  sentryMetrics.labelValues.set(key, seen);
  if (seen.has(raw)) {
    return raw;
  }
  if (seen.size >= MAX_LABEL_VALUES) {
    return "other";
  }
  seen.add(raw);
  return raw;
}

function readExtra(payload: unknown): unknown {
  const parsed = extraCarrierSchema.safeParse(payload);
  return parsed.success ? parsed.data.extra : undefined;
}

export function recordInvalidReportBatch(): void {
  sentryMetrics.reportBatchesTotal.inc({ outcome: "invalid" });
}

export function recordReportBatch(items: ReportItem[]): void {
  sentryMetrics.reportBatchesTotal.inc({ outcome: "accepted" });
  sentryMetrics.reportBatchSize.observe(items.length);
  for (const item of items) {
    recordReportItem(item);
  }
}

function recordReportItem(item: ReportItem): void {
  const projectId = item.projectId ?? "unknown";
  const status = item.status ?? "unknown";
  sentryMetrics.eventsTotal.inc({
    type: item.type,
    status,
    project_id: projectId,
  });
  sentryMetrics.eventLastSeen.set(
    { type: item.type, project_id: projectId },
    Date.now() / 1000,
  );

  switch (item.type) {
    case "XMLHttpRequest":
    case "fetch":
      recordHttpEvent(item, projectId, status);
      return;
    case "Error":
    case "React":
    case "Vue":
    case "OtherFrameworks":
      recordErrorEvent(item, projectId);
      return;
    case "Resource":
      sentryMetrics.resourceErrorsTotal.inc({
        tag: boundedLabel("resource_tag", item.name),
        project_id: projectId,
      });
      return;
    case "Performance":
      recordPerformanceEvent(item, projectId);
      return;
    case "Click":
      recordClickEvent(item, projectId);
      return;
    case "Exposure":
      recordExposureEvent(item, projectId);
      return;
    case "WhiteScreen":
      sentryMetrics.whiteScreensTotal.inc({ project_id: projectId });
      return;
    case "PV":
      recordPageViewEvent(item, projectId);
      return;
    case "Custom":
      sentryMetrics.customEventsTotal.inc({
        name: boundedLabel("custom_event", item.name),
        project_id: projectId,
      });
      return;
    default:
      // ScreenRecord carries only an opaque rrweb blob; History/HashChange never
      // reach the reporter as their own events. The events counter is enough.
      return;
  }
}

function recordHttpEvent(
  item: ReportItem,
  projectId: string,
  status: string,
): void {
  const http = httpPayloadSchema.safeParse(item.payload);
  const method = http.success ? (http.data.method ?? "unknown") : "unknown";
  const statusCode = String(http.success ? (http.data.statusCode ?? 0) : 0);
  sentryMetrics.httpRequestsTotal.inc({
    method,
    status_code: statusCode,
    status,
    project_id: projectId,
  });
  if (http.success && http.data.elapsedTime !== undefined) {
    sentryMetrics.httpRequestDurationMs.observe(
      { method, status_code: statusCode, project_id: projectId },
      http.data.elapsedTime,
    );
  }
}

function recordErrorEvent(item: ReportItem, projectId: string): void {
  const labels = {
    type: item.type,
    name: boundedLabel("error_name", item.name),
    project_id: projectId,
  };
  const batch = batchErrorPayloadSchema.safeParse(item.payload);
  if (batch.success) {
    sentryMetrics.batchErrorGroupsTotal.inc(labels);
    sentryMetrics.errorsTotal.inc(labels, batch.data.batchErrorLength);
    return;
  }
  sentryMetrics.errorsTotal.inc(labels);
}

function recordPerformanceEvent(item: ReportItem, projectId: string): void {
  const name = item.name ?? "";
  if (WEB_VITAL_NAMES.has(name)) {
    recordWebVital(name, item.payload, projectId);
    return;
  }
  switch (name) {
    case "NavigationTiming":
      recordNavigationTiming(item.payload, projectId);
      return;
    case "ResourceTiming":
      recordResourceTimingEvent(item.payload, projectId);
      return;
    case "ResourceList":
      recordResourceList(item.payload, projectId);
      return;
    case "LongTask":
      recordLongTasks(item.payload, projectId);
      return;
    case "Memory":
      recordBrowserMemory(item.payload, projectId);
      return;
  }
  if (name.startsWith("HTTP ")) {
    recordHttpPerformance(name, item.payload, projectId);
    return;
  }
  const perf = performanceValueSchema.safeParse(item.payload);
  if (perf.success && perf.data.value !== undefined) {
    sentryMetrics.performanceValue.set(
      { name: boundedLabel("performance_name", name), project_id: projectId },
      perf.data.value,
    );
  }
}

function recordWebVital(
  name: string,
  payload: unknown,
  projectId: string,
): void {
  const perf = performanceValueSchema.safeParse(payload);
  if (!perf.success || perf.data.value === undefined) {
    return;
  }
  const labels = {
    name,
    rating: perf.data.rating ?? "none",
    project_id: projectId,
  };
  sentryMetrics.webVitals.set(labels, perf.data.value);
  sentryMetrics.webVitalSamplesTotal.inc(labels);
}

function recordNavigationTiming(payload: unknown, projectId: string): void {
  const extra = numericRecordSchema.safeParse(readExtra(payload));
  if (!extra.success) {
    return;
  }
  for (const phase of NAVIGATION_PHASES) {
    const value = extra.data[phase];
    if (typeof value === "number") {
      sentryMetrics.navigationTimingMs.observe(
        { phase, project_id: projectId },
        value,
      );
    }
  }
}

function recordResourceTimingEvent(payload: unknown, projectId: string): void {
  const extra = resourceTimingExtraSchema.safeParse(readExtra(payload));
  if (extra.success) {
    recordResourceEntry(extra.data.resource, projectId);
  }
}

function recordResourceList(payload: unknown, projectId: string): void {
  const parsed = resourceListPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return;
  }
  for (const resource of parsed.data.resourceList) {
    recordResourceEntry(resource, projectId);
  }
}

function recordResourceEntry(
  resource: ResourceTiming,
  projectId: string,
): void {
  const initiatorType = boundedLabel("initiator_type", resource.initiatorType);
  const fromCache = String(resource.fromCache ?? false);
  sentryMetrics.resourceEntriesTotal.inc({
    initiator_type: initiatorType,
    from_cache: fromCache,
    project_id: projectId,
  });
  if (resource.duration !== undefined) {
    sentryMetrics.resourceDurationMs.observe(
      {
        initiator_type: initiatorType,
        from_cache: fromCache,
        project_id: projectId,
      },
      resource.duration,
    );
  }
  if (resource.transferSize !== undefined) {
    sentryMetrics.resourceTransferBytes.observe(
      { initiator_type: initiatorType, project_id: projectId },
      resource.transferSize,
    );
  }
}

function recordLongTasks(payload: unknown, projectId: string): void {
  const parsed = longTaskPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return;
  }
  for (const task of parsed.data.longTasks) {
    sentryMetrics.longTasksTotal.inc({ project_id: projectId });
    if (task.duration !== undefined) {
      sentryMetrics.longTaskDurationMs.observe(
        { project_id: projectId },
        task.duration,
      );
    }
  }
}

function recordBrowserMemory(payload: unknown, projectId: string): void {
  const parsed = memoryPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return;
  }
  const { bytes, breakdown } = parsed.data.memory;
  if (bytes !== undefined) {
    sentryMetrics.browserMemoryBytes.set({ project_id: projectId }, bytes);
  }
  if (!breakdown) {
    return;
  }
  const totals = new Map<string, number>();
  for (const entry of breakdown) {
    const kind = boundedLabel("browser_memory_kind", entry.types?.join("+"));
    totals.set(kind, (totals.get(kind) ?? 0) + entry.bytes);
  }
  for (const [kind, value] of totals) {
    sentryMetrics.browserMemoryBreakdownBytes.set(
      { kind, project_id: projectId },
      value,
    );
  }
}

function recordHttpPerformance(
  name: string,
  payload: unknown,
  projectId: string,
): void {
  const perf = performanceValueSchema.safeParse(payload);
  const extra = httpPayloadSchema.safeParse(readExtra(payload));
  const method = extra.success
    ? (extra.data.method ?? name.slice(5))
    : name.slice(5);
  const statusCode = String(extra.success ? (extra.data.statusCode ?? 0) : 0);
  sentryMetrics.httpRequestsTotal.inc({
    method,
    status_code: statusCode,
    status: "OK",
    project_id: projectId,
  });
  if (perf.success && perf.data.value !== undefined) {
    sentryMetrics.httpRequestDurationMs.observe(
      { method, status_code: statusCode, project_id: projectId },
      perf.data.value,
    );
  }
}

function recordClickEvent(item: ReportItem, projectId: string): void {
  const extra = clickExtraSchema.safeParse(readExtra(item.payload));
  const ev = extra.success ? (extra.data.ev ?? item.name) : item.name;
  sentryMetrics.clicksTotal.inc({
    ev: boundedLabel("click_ev", ev),
    project_id: projectId,
  });
}

function recordExposureEvent(item: ReportItem, projectId: string): void {
  sentryMetrics.exposuresTotal.inc({ project_id: projectId });
  const extra = durationExtraSchema.safeParse(readExtra(item.payload));
  if (extra.success && extra.data.duration !== undefined) {
    sentryMetrics.exposureDurationMs.observe(
      { project_id: projectId },
      extra.data.duration,
    );
  }
}

function recordPageViewEvent(item: ReportItem, projectId: string): void {
  const name = boundedLabel("page_view_name", item.name);
  sentryMetrics.pageViewsTotal.inc({ name, project_id: projectId });
  if (item.name !== "PageDwell") {
    return;
  }
  const extra = durationExtraSchema.safeParse(readExtra(item.payload));
  if (extra.success && extra.data.duration !== undefined) {
    sentryMetrics.pageDwellMs.observe(
      { project_id: projectId },
      extra.data.duration,
    );
  }
}
