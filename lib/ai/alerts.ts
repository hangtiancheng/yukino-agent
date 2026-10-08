// Multi-source alert aggregation — port of the legacy Python
// `super_ai/alerts.py` (agent_py-release-2026-09-08).
//
// Legacy shape kept:
//   - ActiveAlert normalized fields (alerts.py:24-38) expanded onto the
//     current SimplifiedAlert snake_case contract (the AI Ops prompt and the
//     OnCall chat reference these keys): alert_name/description/state/
//     active_at/duration plus service/severity/labels/annotations/
//     context_url/fingerprint provenance.
//   - Prometheus v1 `/api/v1/alerts` + Alertmanager v2 `/api/v2/alerts`
//     providers (alerts.py:49-105), HTTP basic auth (alerts.py:189-193),
//     the "active|firing" state filter (alerts.py:232-234), fingerprint-or-
//     derived id (alerts.py:244-245), and per-source failure tolerance
//     (alerts.py:114-124: valid sources still serve results; only a total
//     failure raises).
//
// Config: `ALERT_SOURCES` (config.alertSourcesJson) is a JSON array of
// {name, type: "prometheus"|"alertmanager", baseUrl, username?, password?}.
// When unset or unparseable we fall back to the single-source behavior the
// surface had before: one prometheus source at PROMETHEUS_BASE_URL.
// Same-name dedup keeps the FIRST occurrence (existing queryPrometheusAlerts
// semantics, operations.ts:75-81), applied after the legacy (source,
// starts_at, id) sort (alerts.py:125).
import { z } from "zod/v4";
import { config } from "@/lib/config";

const FETCH_TIMEOUT_MS = 10_000;

export interface Alert {
  alert_name: string;
  description: string;
  state: string;
  active_at: string;
  duration: string;
  service: string;
  severity: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  context_url: string;
  fingerprint: string;
  /** Which configured source produced this alert (provenance). */
  source: string;
}

export interface AlertSourceError {
  source: string;
  error: string;
}

export interface AlertAggregate {
  alerts: Alert[];
  sourceErrors: AlertSourceError[];
  /** True when at least one configured source responded successfully. */
  anySourceOk: boolean;
}

export interface AlertSourceConfig {
  name: string;
  type: "prometheus" | "alertmanager";
  baseUrl: string;
  username?: string;
  password?: string;
}

const alertSourceSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["prometheus", "alertmanager"]),
  baseUrl: z.string().min(1),
  username: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
});

// One raw alert as it appears in either provider payload. Prometheus v1 uses
// `state` + `activeAt`; Alertmanager v2 uses `status.state` + `startsAt` +
// `fingerprint`. Everything else stays optional; string-map values are
// filtered exactly like the legacy `_string_mapping` (alerts.py:270-277).
const rawAlertSchema = z.looseObject({
  labels: z.record(z.string(), z.unknown()).optional(),
  annotations: z.record(z.string(), z.unknown()).optional(),
  state: z.string().optional(),
  activeAt: z.string().optional(),
  startsAt: z.string().optional(),
  fingerprint: z.string().optional(),
  status: z
    .union([z.looseObject({ state: z.string().optional() }), z.string()])
    .optional(),
});

const prometheusEnvelopeSchema = z.looseObject({
  status: z.string().optional(),
  data: z
    .looseObject({
      alerts: z.array(rawAlertSchema).optional(),
    })
    .optional(),
});

export function fallbackSource(): AlertSourceConfig {
  return {
    name: "prometheus",
    type: "prometheus",
    baseUrl: config.prometheusBaseUrl,
  };
}

// Parse config.alertSourcesJson; invalid/empty config falls back to the
// single PROMETHEUS_BASE_URL source so the surface keeps its pre-migration
// behavior (AGENTS.md: single-source prometheus v1 /api/v1/alerts).
export function parseAlertSources(raw: string): AlertSourceConfig[] {
  const trimmed = raw.trim();
  if (trimmed === "") return [fallbackSource()];
  try {
    const parsed = z.array(alertSourceSchema).parse(JSON.parse(trimmed));
    if (parsed.length === 0) return [fallbackSource()];
    return parsed;
  } catch {
    return [fallbackSource()];
  }
}

function alertsEndpoint(
  baseUrl: string,
  type: AlertSourceConfig["type"],
): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return type === "alertmanager"
    ? `${trimmed}/api/v2/alerts`
    : `${trimmed}/api/v1/alerts`;
}

// Legacy _string_mapping (alerts.py:270-277): keep only string→string pairs.
function stringMap(
  value: Record<string, unknown> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value) return out;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") out[key] = item;
  }
  return out;
}

export function calculateDuration(activeAt: string): string {
  const t = Date.parse(activeAt);
  if (Number.isNaN(t)) return "unknown";
  const ms = Date.now() - t;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (h > 0) return `${h}h${m}m${s}s`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}

// Legacy _normalize_alert (alerts.py:225-263), lifted onto the snake_case
// field contract the OnCall surface already uses. Returns null for states
// outside {active, firing} and for alerts without an `alertname` label
// (the current dedup also drops unnamed alerts, operations.ts:79-80).
export function normalizeAlert(
  raw: z.infer<typeof rawAlertSchema>,
  sourceId: string,
): Alert | null {
  const statusState =
    typeof raw.status === "object" && raw.status !== undefined
      ? (raw.status.state ?? "")
      : "";
  const state = statusState || (raw.state ?? "");
  if (state !== "firing" && state !== "active") return null;

  const labels = stringMap(raw.labels);
  const annotations = stringMap(raw.annotations);
  const alertName = labels["alertname"] ?? "";
  if (alertName === "") return null;
  const service = labels["service"] ?? labels["job"] ?? "Unspecified service";
  const severity = labels["severity"] ?? "unknown";
  // startsAt (alertmanager) first, then activeAt (prometheus) — legacy
  // precedence alerts.py:241-243.
  const activeAt = raw.startsAt ?? raw.activeAt ?? "";
  const fingerprint =
    raw.fingerprint ?? `${sourceId}:${alertName}:${service}:${activeAt}`;
  // Context URL: not a legacy ActiveAlert field; surfaced from the common
  // annotation conventions so the panel can deep-link an incident.
  const contextUrl =
    annotations["context_url"] ??
    annotations["runbook_url"] ??
    annotations["dashboard_url"] ??
    "";

  return {
    alert_name: alertName,
    description: annotations["description"] ?? annotations["summary"] ?? "",
    state,
    active_at: activeAt,
    duration: calculateDuration(activeAt),
    service,
    severity,
    labels,
    annotations,
    context_url: contextUrl,
    fingerprint,
    source: sourceId,
  };
}

export function parsePrometheusAlerts(
  payload: unknown,
  sourceId: string,
): Alert[] {
  const parsed = prometheusEnvelopeSchema.parse(payload);
  if (parsed.status !== "success") {
    throw new Error(
      "The configured alert provider returned an invalid response.",
    );
  }
  return (parsed.data?.alerts ?? [])
    .map((a) => normalizeAlert(a, sourceId))
    .filter((a): a is Alert => a !== null);
}

export function parseAlertmanagerAlerts(
  payload: unknown,
  sourceId: string,
): Alert[] {
  if (!Array.isArray(payload)) {
    throw new Error(
      "The configured alert provider returned an invalid response.",
    );
  }
  return payload
    .map((a) => normalizeAlert(rawAlertSchema.parse(a), sourceId))
    .filter((a): a is Alert => a !== null);
}

export interface FetchOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** Override the parsed ALERT_SOURCES (offline tests / explicit callers). */
  sources?: AlertSourceConfig[];
}

// Fetch one source. Errors (network / timeout / non-2xx / bad payload)
// propagate to the aggregator, which records them per source — legacy
// AggregatedAlertProvider tolerance (alerts.py:114-124).
export async function fetchAlertsFromSource(
  source: AlertSourceConfig,
  options: FetchOptions = {},
): Promise<Alert[]> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const url = alertsEndpoint(source.baseUrl, source.type);
  const headers: Record<string, string> = {};
  if (source.username !== undefined && source.password !== undefined) {
    // Legacy httpx.BasicAuth (alerts.py:189-193).
    const token = Buffer.from(`${source.username}:${source.password}`).toString(
      "base64",
    );
    headers["Authorization"] = `Basic ${token}`;
  } else if (source.username !== undefined || source.password !== undefined) {
    // Legacy refused a half-configured pair (alerts.py:158-161); surface it
    // as this source's error rather than sending a broken credential header.
    throw new Error(
      "Alert source credentials must include username and password.",
    );
  }
  const resp = await doFetch(url, {
    headers,
    signal: AbortSignal.timeout(options.timeoutMs ?? FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }
  const payload: unknown = await resp.json();
  return source.type === "alertmanager"
    ? parseAlertmanagerAlerts(payload, source.name)
    : parsePrometheusAlerts(payload, source.name);
}

// Legacy dedup note: alerts.py deduped by provider id; the OnCall surface
// deduped by alert name and keeps the first occurrence (AGENTS.md). We sort
// legacy-style first, then apply the name dedup.
export function dedupeAlerts(alerts: Alert[]): Alert[] {
  const sorted = [...alerts].sort(
    (a, b) =>
      a.source.localeCompare(b.source) ||
      a.active_at.localeCompare(b.active_at) ||
      a.fingerprint.localeCompare(b.fingerprint),
  );
  const seen = new Set<string>();
  const out: Alert[] = [];
  for (const alert of sorted) {
    if (seen.has(alert.alert_name)) continue;
    seen.add(alert.alert_name);
    out.push(alert);
  }
  return out;
}

export async function aggregateAlerts(
  options: FetchOptions = {},
): Promise<AlertAggregate> {
  const sources = options.sources ?? parseAlertSources(config.alertSourcesJson);
  const results = await Promise.allSettled(
    sources.map((source) => fetchAlertsFromSource(source, options)),
  );
  const alerts: Alert[] = [];
  const sourceErrors: AlertSourceError[] = [];
  let anySourceOk = false;
  results.forEach((result, i) => {
    if (result.status === "fulfilled") {
      anySourceOk = true;
      alerts.push(...result.value);
    } else {
      sourceErrors.push({
        source: sources[i].name,
        error:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
      });
    }
  });
  return { alerts: dedupeAlerts(alerts), sourceErrors, anySourceOk };
}

// ---- Readiness primitives (legacy agent_py app.py:423-429 /ready: every
// dependency answered with ok + latencyMs; a degraded dependency flips the
// aggregate to "degraded", never an exception). Kept here so /api/ready
// stays thin and the aggregation is offline-smoke-testable with injected
// fake checkers. ----

export interface ReadinessCheck {
  name: string;
  ok: boolean;
  latencyMs: number;
  detail?: string;
}

export type ReadinessChecker = () => Promise<{
  ok: boolean;
  latencyMs?: number;
  detail?: string;
}>;

// Runs every checker concurrently; a throwing checker degrades to ok:false
// (legacy gather-then-aggregate, app.py:1900-1908). "ready" requires ALL
// checks to pass — alert-source probes included, matching the legacy
// all-components rule; the route decides how to weight the HTTP status.
export async function runReadinessChecks(
  checkers: Record<string, ReadinessChecker>,
): Promise<{ status: "ready" | "degraded"; checks: ReadinessCheck[] }> {
  const entries = Object.entries(checkers);
  const results = await Promise.all(
    entries.map(async ([name, checker]) => {
      const startedAt = performance.now();
      try {
        const out = await checker();
        return {
          name,
          ok: out.ok,
          latencyMs: out.latencyMs ?? Math.round(performance.now() - startedAt),
          ...(out.detail !== undefined ? { detail: out.detail } : {}),
        };
      } catch (e) {
        return {
          name,
          ok: false,
          latencyMs: Math.round(performance.now() - startedAt),
          detail: e instanceof Error ? e.message : String(e),
        };
      }
    }),
  );
  const status = results.every((check) => check.ok) ? "ready" : "degraded";
  return { status, checks: results };
}

// Probes each configured alert source's alerts endpoint with a short
// timeout (legacy readiness used provider health; here the provider surface
// IS the endpoint). Failures degrade the check, never throw.
export async function probeAlertSources(
  timeoutMs = 3000,
  options: FetchOptions = {},
): Promise<Record<string, ReadinessChecker>> {
  const sources = options.sources ?? parseAlertSources(config.alertSourcesJson);
  const checkers: Record<string, ReadinessChecker> = {};
  for (const source of sources) {
    checkers[`alertSource:${source.name}`] = async () => {
      const startedAt = performance.now();
      try {
        const url = alertsEndpoint(source.baseUrl, source.type);
        const headers: Record<string, string> = {};
        if (source.username !== undefined && source.password !== undefined) {
          headers["Authorization"] = `Basic ${Buffer.from(
            `${source.username}:${source.password}`,
          ).toString("base64")}`;
        }
        const resp = await (options.fetch ?? globalThis.fetch)(url, {
          headers,
          signal: AbortSignal.timeout(timeoutMs),
        });
        return {
          ok: resp.status < 500,
          latencyMs: Math.round(performance.now() - startedAt),
          detail: `HTTP ${resp.status}`,
        };
      } catch (e) {
        return {
          ok: false,
          latencyMs: Math.round(performance.now() - startedAt),
          detail: e instanceof Error ? e.message : String(e),
        };
      }
    };
  }
  return checkers;
}
