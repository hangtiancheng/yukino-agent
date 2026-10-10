import assert from "node:assert/strict";
import {
  recordInvalidReportBatch,
  recordReportBatch,
  reportBatchSchema,
  sentryMetrics,
  type ReportItem,
} from "@/lib/metrics";

const PROJECT = "metrics-smoke";

const BATCH: ReportItem[] = [
  {
    type: "XMLHttpRequest",
    status: "success",
    projectId: PROJECT,
    payload: { method: "GET", statusCode: 200, elapsedTime: 12 },
  },
  {
    type: "fetch",
    status: "error",
    projectId: PROJECT,
    payload: { method: "POST", statusCode: 500, elapsedTime: 34 },
  },
  {
    type: "Error",
    status: "error",
    name: "TypeError",
    projectId: PROJECT,
    payload: { msg: "boom" },
  },
  {
    type: "Error",
    status: "error",
    name: "TypeError",
    projectId: PROJECT,
    payload: { batchError: true, batchErrorLength: 3 },
  },
  { type: "React", status: "error", name: "Crash", projectId: PROJECT },
  { type: "Vue", status: "error", name: "Crash", projectId: PROJECT },
  {
    type: "OtherFrameworks",
    status: "error",
    name: "Crash",
    projectId: PROJECT,
  },
  { type: "Resource", status: "error", name: "IMG", projectId: PROJECT },
  {
    type: "Performance",
    status: "success",
    name: "LCP",
    projectId: PROJECT,
    payload: { value: 1200, rating: "good" },
  },
  {
    type: "Performance",
    status: "success",
    name: "NavigationTiming",
    projectId: PROJECT,
    payload: { extra: { paintTime: 100, domInteractive: 200, loadEvent: 900 } },
  },
  {
    type: "Performance",
    status: "success",
    name: "ResourceTiming",
    projectId: PROJECT,
    payload: {
      extra: {
        resource: {
          initiatorType: "script",
          duration: 55,
          transferSize: 2048,
          fromCache: false,
        },
      },
    },
  },
  {
    type: "Performance",
    status: "success",
    name: "ResourceList",
    projectId: PROJECT,
    payload: {
      resourceList: [{ initiatorType: "css", duration: 21, transferSize: 512 }],
    },
  },
  {
    type: "Performance",
    status: "success",
    name: "LongTask",
    projectId: PROJECT,
    payload: { longTasks: [{ duration: 120 }, { duration: 80 }] },
  },
  {
    type: "Performance",
    status: "success",
    name: "Memory",
    projectId: PROJECT,
    payload: {
      memory: {
        bytes: 123456,
        breakdown: [
          { bytes: 1000, types: ["Document"] },
          { bytes: 2000, types: ["JavaScript"] },
        ],
      },
    },
  },
  {
    type: "Performance",
    status: "success",
    name: "HTTP GET",
    projectId: PROJECT,
    payload: { value: 77, extra: { method: "GET", statusCode: 200 } },
  },
  {
    type: "Performance",
    status: "success",
    name: "CustomTiming",
    projectId: PROJECT,
    payload: { value: 42 },
  },
  {
    type: "Click",
    status: "success",
    name: "send-button",
    projectId: PROJECT,
    payload: { extra: { ev: "send-button" } },
  },
  {
    type: "Exposure",
    status: "success",
    projectId: PROJECT,
    payload: { extra: { duration: 1500 } },
  },
  { type: "WhiteScreen", status: "error", projectId: PROJECT },
  { type: "PV", status: "success", name: "PageLoad", projectId: PROJECT },
  {
    type: "PV",
    status: "success",
    name: "PageDwell",
    projectId: PROJECT,
    payload: { extra: { duration: 30000 } },
  },
  {
    type: "Custom",
    status: "success",
    name: "feature_used",
    projectId: PROJECT,
  },
  { type: "ScreenRecord", status: "success", projectId: PROJECT },
];

function assertSeries(
  exposition: string,
  metric: string,
  labels: Record<string, string | number>,
  value?: string | number,
): void {
  const line = exposition
    .split("\n")
    .find(
      (l) =>
        l.startsWith(`${metric}{`) &&
        Object.entries(labels).every(([k, v]) =>
          l.includes(`${k}="${String(v)}"`),
        ),
    );
  assert.ok(
    line !== undefined,
    `exposition is missing series ${metric} with ${JSON.stringify(labels)}${value !== undefined ? ` = ${value}` : ""}`,
  );
  if (value !== undefined) {
    assert.equal(
      line?.slice(line.lastIndexOf("}") + 1).trim(),
      String(value),
      `series ${metric} ${JSON.stringify(labels)} has an unexpected value`,
    );
  }
}

async function main() {
  const parsed = reportBatchSchema.safeParse(BATCH);
  assert.ok(parsed.success, "sample batch must satisfy reportBatchSchema");

  recordReportBatch(parsed.data);
  recordInvalidReportBatch();

  const exposition = await sentryMetrics.registry.metrics();

  assertSeries(
    exposition,
    "yukino_sentry_events_total",
    { type: "XMLHttpRequest", status: "success", project_id: PROJECT },
    1,
  );
  assertSeries(
    exposition,
    "yukino_sentry_events_total",
    { type: "ScreenRecord", status: "success", project_id: PROJECT },
    1,
  );
  assertSeries(
    exposition,
    "yukino_sentry_report_batches_total",
    { outcome: "accepted" },
    1,
  );
  assertSeries(
    exposition,
    "yukino_sentry_report_batches_total",
    { outcome: "invalid" },
    1,
  );
  assert.ok(
    exposition.includes("yukino_sentry_report_batch_size_count 1"),
    "batch-size histogram did not observe the batch",
  );

  assertSeries(
    exposition,
    "yukino_sentry_http_requests_total",
    {
      method: "GET",
      status_code: "200",
      status: "success",
      project_id: PROJECT,
    },
    1,
  );
  assertSeries(
    exposition,
    "yukino_sentry_http_requests_total",
    {
      method: "POST",
      status_code: "500",
      status: "error",
      project_id: PROJECT,
    },
    1,
  );
  assertSeries(
    exposition,
    "yukino_sentry_http_requests_total",
    { method: "GET", status_code: "200", status: "OK", project_id: PROJECT },
    1,
  );
  assertSeries(
    exposition,
    "yukino_sentry_http_request_duration_ms_count",
    { method: "GET", status_code: "200", project_id: PROJECT },
    2,
  );

  assertSeries(
    exposition,
    "yukino_sentry_errors_total",
    { type: "Error", name: "TypeError", project_id: PROJECT },
    4,
  );
  assertSeries(
    exposition,
    "yukino_sentry_batch_error_groups_total",
    { type: "Error", name: "TypeError", project_id: PROJECT },
    1,
  );
  assertSeries(
    exposition,
    "yukino_sentry_errors_total",
    { type: "React", name: "Crash", project_id: PROJECT },
    1,
  );
  assertSeries(
    exposition,
    "yukino_sentry_resource_errors_total",
    { tag: "IMG", project_id: PROJECT },
    1,
  );

  assertSeries(
    exposition,
    "yukino_sentry_web_vitals",
    { name: "LCP", rating: "good", project_id: PROJECT },
    1200,
  );
  assertSeries(
    exposition,
    "yukino_sentry_web_vital_samples_total",
    { name: "LCP", rating: "good", project_id: PROJECT },
    1,
  );

  assertSeries(
    exposition,
    "yukino_sentry_navigation_timing_ms_count",
    { phase: "paintTime", project_id: PROJECT },
    1,
  );
  assertSeries(
    exposition,
    "yukino_sentry_resource_entries_total",
    { initiator_type: "script", from_cache: "false", project_id: PROJECT },
    1,
  );
  assertSeries(
    exposition,
    "yukino_sentry_resource_transfer_bytes_sum",
    { initiator_type: "script", project_id: PROJECT },
    2048,
  );
  assertSeries(
    exposition,
    "yukino_sentry_long_tasks_total",
    { project_id: PROJECT },
    2,
  );
  assertSeries(
    exposition,
    "yukino_sentry_long_task_duration_ms_sum",
    { project_id: PROJECT },
    200,
  );
  assertSeries(
    exposition,
    "yukino_sentry_browser_memory_bytes",
    { project_id: PROJECT },
    123456,
  );
  assertSeries(
    exposition,
    "yukino_sentry_browser_memory_breakdown_bytes",
    { kind: "JavaScript", project_id: PROJECT },
    2000,
  );

  assertSeries(
    exposition,
    "yukino_sentry_clicks_total",
    { ev: "send-button", project_id: PROJECT },
    1,
  );
  assertSeries(
    exposition,
    "yukino_sentry_exposures_total",
    { project_id: PROJECT },
    1,
  );
  assertSeries(
    exposition,
    "yukino_sentry_exposure_duration_ms_sum",
    { project_id: PROJECT },
    1500,
  );
  assertSeries(
    exposition,
    "yukino_sentry_white_screens_total",
    { project_id: PROJECT },
    1,
  );
  assertSeries(
    exposition,
    "yukino_sentry_page_views_total",
    { name: "PageLoad", project_id: PROJECT },
    1,
  );
  assertSeries(
    exposition,
    "yukino_sentry_page_dwell_ms_sum",
    { project_id: PROJECT },
    30000,
  );
  assertSeries(
    exposition,
    "yukino_sentry_custom_events_total",
    { name: "feature_used", project_id: PROJECT },
    1,
  );
  assertSeries(
    exposition,
    "yukino_sentry_performance_value",
    { name: "CustomTiming", project_id: PROJECT },
    42,
  );

  assert.ok(
    exposition.includes('yukino_node_v8_heap_bytes{kind="heap_size_limit"}'),
    "runtime heap-limit gauge missing",
  );
  assert.ok(
    exposition.includes("yukino_node_eventloop_utilization"),
    "event-loop utilization gauge missing",
  );

  for (let i = 0; i < 60; i++) {
    recordReportBatch([
      {
        type: "Click",
        status: "success",
        name: `bounded-click-${i}`,
        projectId: PROJECT,
      },
    ]);
  }
  const bounded = await sentryMetrics.registry.metrics();
  assert.ok(
    bounded.includes('ev="other"'),
    "label bounding did not collapse overflow into other",
  );

  console.log(
    "metrics smoke OK: all report types + runtime gauges + label bounding verified",
  );
}

main().catch((e) => {
  console.error("SMOKE FAILED:", e);
  process.exit(1);
});
