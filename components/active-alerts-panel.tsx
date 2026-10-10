"use client";
import { useCallback, useEffect, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { motion } from "motion/react";
import {
  BellRing,
  Clock,
  RefreshCw,
  Siren,
  Stethoscope,
  X,
} from "lucide-react";
import { z } from "zod/v4";
import { runAiOpsStream } from "@/hooks/aiops-stream";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import MdRender from "@/components/md-render";

const alertSchema = z.object({
  alert_name: z.string(),
  description: z.string(),
  state: z.string(),
  active_at: z.string(),
  duration: z.string(),
  service: z.string(),
  severity: z.string(),
  labels: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.string()),
  context_url: z.string(),
  fingerprint: z.string(),
  source: z.string(),
});
type AlertItem = z.infer<typeof alertSchema>;

const activeAlertsResponseSchema = z.object({
  message: z.string(),
  data: z
    .object({
      items: z.array(alertSchema).default([]),
      sourceErrors: z
        .array(z.object({ source: z.string(), error: z.string() }))
        .default([]),
    })
    .nullish(),
});

const runSummarySchema = z.object({
  id: z.string(),
  query: z.string(),
  status: z.string(),
  alertName: z.string().nullable(),
  reportExcerpt: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
});
type RunSummary = z.infer<typeof runSummarySchema>;

const runsResponseSchema = z.object({
  message: z.string(),
  data: z.object({ items: z.array(runSummarySchema).default([]) }).nullish(),
});

const caseSchema = z.object({
  id: z.string(),
  hash: z.string(),
  title: z.string(),
  alertName: z.string(),
  summary: z.string(),
  fileName: z.string(),
  createdAt: z.string(),
});
type CaseItem = z.infer<typeof caseSchema>;

const casesResponseSchema = z.object({
  message: z.string(),
  data: z.object({ items: z.array(caseSchema).default([]) }).nullish(),
});

const runEventSchema = z.object({
  type: z.string(),
  index: z.number().optional(),
  step: z.string().optional(),
  output: z.string().optional(),
  steps: z.array(z.string()).optional(),
  done: z.boolean().optional(),
  remaining: z.array(z.string()).optional(),
  error: z.string().optional(),
});
type RunEvent = z.infer<typeof runEventSchema>;

const runDetailDataSchema = z.object({
  id: z.string(),
  status: z.string(),
  alertName: z.string().nullable(),
  report: z.string(),
  error: z.string().nullish(),
  events: z.array(runEventSchema).default([]),
});
const runDetailResponseSchema = z.object({
  message: z.string(),
  data: runDetailDataSchema.nullish(),
});

export interface AiOpsReportPayload {
  result: string;
  detail: string[];
  a2ui?: unknown[];
}

function RunTimelineEvent({ event }: { event: RunEvent }) {
  const t = useTranslations("oncallOps");
  if (event.type === "plan_created") {
    const steps = event.steps ?? [];
    return (
      <div className="text-xs">
        <span className="text-muted-foreground">
          {t("progressPlan", { count: steps.length })}
        </span>
        <ol className="text-muted-foreground mt-0.5 list-decimal pl-4">
          {steps.map((step, i) => (
            <li key={i} className="truncate">
              {step}
            </li>
          ))}
        </ol>
      </div>
    );
  }
  if (event.type === "step_start") {
    return (
      <div className="text-muted-foreground truncate text-xs">
        {t("progressStep", {
          index: (event.index ?? 0) + 1,
          step: event.step ?? "",
        })}
      </div>
    );
  }
  if (event.type === "step_done") {
    return (
      <div className="text-xs">
        <div className="text-muted-foreground">
          {t("progressStepDone", { index: (event.index ?? 0) + 1 })}
        </div>
        {event.output ? (
          <pre className="bg-muted/50 text-foreground/80 mt-0.5 max-h-24 overflow-auto rounded px-2 py-1 text-[11px] whitespace-pre-wrap">
            {event.output}
          </pre>
        ) : null}
      </div>
    );
  }
  if (event.type === "replan") {
    return (
      <div className="text-muted-foreground text-xs">
        {event.done
          ? t("progressReplanDone")
          : t("progressReplan", { count: (event.remaining ?? []).length })}
      </div>
    );
  }
  if (event.type === "error") {
    return <div className="text-destructive text-xs">{event.error}</div>;
  }
  return null;
}

interface ActiveAlertsPanelProps {
  disabled: boolean;
  onReport: (report: AiOpsReportPayload) => void;
  onNotify: (
    message: string,
    type: "info" | "success" | "warning" | "error",
  ) => void;
}

const SEVERITY_CLASSES: Record<string, string> = {
  critical: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  warning: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  info: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
};

const STATUS_CLASSES: Record<string, string> = {
  running: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  success:
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  exhausted:
    "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  failed: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
};

type Tab = "alerts" | "runs" | "cases";

export default function ActiveAlertsPanel({
  disabled,
  onReport,
  onNotify,
}: ActiveAlertsPanelProps) {
  const t = useTranslations("oncallOps");
  const format = useFormatter();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("alerts");
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [sourceErrors, setSourceErrors] = useState<
    { source: string; error: string }[]
  >([]);
  const [alertsError, setAlertsError] = useState(false);
  const [alertsLoading, setAlertsLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [diagnosing, setDiagnosing] = useState<string | null>(null);
  const [diagnoseProgress, setDiagnoseProgress] = useState<string[]>([]);

  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<z.infer<
    typeof runDetailDataSchema
  > | null>(null);
  const [runDetailLoading, setRunDetailLoading] = useState(false);

  const [cases, setCases] = useState<CaseItem[]>([]);
  const [casesLoading, setCasesLoading] = useState(false);
  const [expandedCaseId, setExpandedCaseId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      setAlertsLoading(true);
      try {
        const resp = await fetch("/api/active_alerts");
        const parsed = activeAlertsResponseSchema.safeParse(await resp.json());
        if (cancelled) return;
        if (parsed.success && parsed.data.data != null) {
          setAlerts(parsed.data.data.items);
          setSourceErrors(parsed.data.data.sourceErrors);
          setAlertsError(false);
        } else {
          setAlerts([]);
          setSourceErrors([]);
          setAlertsError(true);
        }
      } catch {
        if (cancelled) return;
        setAlerts([]);
        setSourceErrors([]);
        setAlertsError(true);
      } finally {
        if (!cancelled) setAlertsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, reloadKey]);

  useEffect(() => {
    if (!open || tab !== "runs") return;
    let cancelled = false;
    void (async () => {
      setRunsLoading(true);
      try {
        const resp = await fetch("/api/ai_ops/runs");
        const parsed = runsResponseSchema.safeParse(await resp.json());
        if (cancelled) return;
        setRuns(parsed.success ? (parsed.data.data?.items ?? []) : []);
      } catch {
        if (!cancelled) setRuns([]);
      } finally {
        if (!cancelled) setRunsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, tab, reloadKey]);

  useEffect(() => {
    if (!open || tab !== "cases") return;
    let cancelled = false;
    void (async () => {
      setCasesLoading(true);
      try {
        const resp = await fetch("/api/diagnostic_cases");
        const parsed = casesResponseSchema.safeParse(await resp.json());
        if (cancelled) return;
        setCases(parsed.success ? (parsed.data.data?.items ?? []) : []);
      } catch {
        if (!cancelled) setCases([]);
      } finally {
        if (!cancelled) setCasesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, tab, reloadKey]);

  const openRun = useCallback(
    async (id: string) => {
      if (expandedRunId === id) {
        setExpandedRunId(null);
        setRunDetail(null);
        return;
      }
      setExpandedRunId(id);
      setRunDetail(null);
      setRunDetailLoading(true);
      try {
        const resp = await fetch(`/api/ai_ops/runs/${id}`);
        const parsed = runDetailResponseSchema.safeParse(await resp.json());
        setRunDetail(parsed.success ? (parsed.data.data ?? null) : null);
      } catch {
        setRunDetail(null);
      } finally {
        setRunDetailLoading(false);
      }
    },
    [expandedRunId],
  );

  const diagnose = useCallback(
    async (alert: AlertItem) => {
      if (disabled || diagnosing !== null) return;
      setDiagnosing(alert.alert_name);
      setDiagnoseProgress([]);
      const progress: string[] = [];
      const push = (line: string) => {
        progress.push(line);
        setDiagnoseProgress([...progress].slice(-6));
      };
      try {
        const streamed = await runAiOpsStream(
          { alert },
          {
            onPlan: (steps) => {
              push(t("progressPlan", { count: steps.length }));
            },
            onStepStart: (index, step) => {
              push(t("progressStep", { index: index + 1, step }));
            },
            onStepDone: (index) => {
              push(t("progressStepDone", { index: index + 1 }));
            },
            onReplan: (done, remaining) => {
              push(
                done
                  ? t("progressReplanDone")
                  : t("progressReplan", { count: remaining.length }),
              );
            },
          },
        );
        onReport({
          result: streamed.result,
          detail: streamed.detail,
          ...(streamed.a2ui && streamed.a2ui.length > 0
            ? { a2ui: streamed.a2ui }
            : {}),
        });
        setReloadKey((k) => k + 1);
      } catch (e) {
        onNotify(
          t("diagnoseFailedWithError", {
            error: e instanceof Error ? e.message : String(e),
          }),
          "error",
        );
      } finally {
        setDiagnosing(null);
        setDiagnoseProgress([]);
      }
    },
    [disabled, diagnosing, onNotify, onReport, t],
  );

  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-20 flex flex-col items-end gap-2">
      {open && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          className="bg-background pointer-events-auto flex max-h-[70svh] w-96 flex-col overflow-hidden rounded-xl border shadow-lg"
        >
          <div className="border-b px-3 py-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <BellRing className="text-primary size-4" />
                <span className="text-foreground text-sm font-semibold">
                  {t("title")}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  onClick={() => setReloadKey((k) => k + 1)}
                  title={t("refresh")}
                >
                  <RefreshCw className="size-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  onClick={() => setOpen(false)}
                  title={t("close")}
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            </div>
            <div className="mt-1.5 flex gap-1">
              {(["alerts", "runs", "cases"] as const).map((key) => (
                <Button
                  key={key}
                  size="sm"
                  variant={tab === key ? "secondary" : "ghost"}
                  className="h-7 px-2 text-xs"
                  onClick={() => setTab(key)}
                >
                  {key === "alerts"
                    ? t("alertsTab")
                    : key === "runs"
                      ? t("runsTab")
                      : t("casesTab")}
                </Button>
              ))}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
            {tab === "alerts" ? (
              <div className="flex flex-col gap-2">
                {sourceErrors.length > 0 && (
                  <div className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
                    <div className="font-medium">{t("sourceErrors")}</div>
                    {sourceErrors.map((e) => (
                      <div key={e.source} className="truncate">
                        {e.source}: {e.error}
                      </div>
                    ))}
                  </div>
                )}
                {alertsError && (
                  <div className="text-muted-foreground rounded-md border px-2 py-1.5 text-xs">
                    {t("alertsUnavailable")}
                  </div>
                )}
                {alertsLoading && (
                  <div className="text-muted-foreground py-6 text-center text-xs">
                    {t("loading")}
                  </div>
                )}
                {!alertsLoading && !alertsError && alerts.length === 0 && (
                  <div className="text-muted-foreground py-6 text-center text-xs">
                    {t("noAlerts")}
                  </div>
                )}
                {alerts.map((alert) => (
                  <div
                    key={`${alert.source}:${alert.fingerprint}`}
                    className="rounded-lg border px-2.5 py-2"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-foreground truncate text-sm font-medium">
                          {alert.alert_name}
                        </div>
                        <div className="text-muted-foreground mt-0.5 text-xs">
                          {alert.service} · {alert.duration}
                        </div>
                      </div>
                      <span
                        className={cn(
                          "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium",
                          SEVERITY_CLASSES[alert.severity] ??
                            "bg-muted text-muted-foreground",
                        )}
                      >
                        {alert.severity}
                      </span>
                    </div>
                    {alert.description !== "" && (
                      <div className="text-muted-foreground mt-1 line-clamp-2 text-xs">
                        {alert.description}
                      </div>
                    )}
                    <div className="mt-1.5 flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 px-2 text-xs"
                        disabled={disabled || diagnosing !== null}
                        onClick={() => void diagnose(alert)}
                      >
                        {diagnosing === alert.alert_name ? (
                          <RefreshCw className="size-3 animate-spin" />
                        ) : (
                          <Stethoscope className="size-3" />
                        )}
                        <span>{t("diagnose")}</span>
                      </Button>
                      {alert.context_url !== "" && (
                        <a
                          href={alert.context_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary text-xs underline-offset-2 hover:underline"
                        >
                          {t("context")}
                        </a>
                      )}
                    </div>
                    {diagnosing === alert.alert_name &&
                      diagnoseProgress.length > 0 && (
                        <div className="bg-muted/60 text-muted-foreground mt-1.5 flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-[11px] leading-snug">
                          {diagnoseProgress.map((line, i) => (
                            <div key={i} className="truncate">
                              {line}
                            </div>
                          ))}
                        </div>
                      )}
                  </div>
                ))}
              </div>
            ) : tab === "runs" ? (
              <div className="flex flex-col gap-2">
                {runsLoading && (
                  <div className="text-muted-foreground py-6 text-center text-xs">
                    {t("loading")}
                  </div>
                )}
                {!runsLoading && runs.length === 0 && (
                  <div className="text-muted-foreground py-6 text-center text-xs">
                    {t("runsEmpty")}
                  </div>
                )}
                {runs.map((run) => (
                  <div key={run.id} className="rounded-lg border px-2.5 py-2">
                    <button
                      type="button"
                      className="flex w-full items-start justify-between gap-2 text-left"
                      onClick={() => void openRun(run.id)}
                    >
                      <div className="min-w-0">
                        <div className="text-foreground truncate text-sm font-medium">
                          {run.alertName ?? t("genericRun")}
                        </div>
                        <div className="text-muted-foreground mt-0.5 flex items-center gap-1 text-xs">
                          <Clock className="size-3" />
                          {format.dateTime(new Date(run.startedAt), "short")}
                        </div>
                      </div>
                      <span
                        className={cn(
                          "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium",
                          STATUS_CLASSES[run.status] ??
                            "bg-muted text-muted-foreground",
                        )}
                      >
                        {run.status}
                      </span>
                    </button>
                    {expandedRunId === run.id && (
                      <div className="mt-2 border-t pt-2">
                        {runDetailLoading && (
                          <div className="text-muted-foreground py-3 text-center text-xs">
                            {t("loading")}
                          </div>
                        )}
                        {!runDetailLoading && runDetail === null && (
                          <div className="text-muted-foreground py-3 text-center text-xs">
                            {t("runDetailUnavailable")}
                          </div>
                        )}
                        {!runDetailLoading && runDetail !== null && (
                          <>
                            {runDetail.events.length > 0 && (
                              <div className="mb-3">
                                <div className="text-muted-foreground mb-1.5 text-[11px] font-medium tracking-wide uppercase">
                                  {t("runTimeline")}
                                </div>
                                <div className="flex flex-col gap-1.5">
                                  {runDetail.events.map((ev, i) => (
                                    <RunTimelineEvent key={i} event={ev} />
                                  ))}
                                </div>
                              </div>
                            )}
                            {runDetail.report !== "" ? (
                              <MdRender
                                content={runDetail.report}
                                className="text-foreground max-w-none text-xs leading-relaxed wrap-break-word"
                              />
                            ) : (
                              <div className="text-muted-foreground py-2 text-xs">
                                {runDetail.error ?? t("noReport")}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {casesLoading && (
                  <div className="text-muted-foreground py-6 text-center text-xs">
                    {t("loading")}
                  </div>
                )}
                {!casesLoading && cases.length === 0 && (
                  <div className="text-muted-foreground py-6 text-center text-xs">
                    {t("casesEmpty")}
                  </div>
                )}
                {cases.map((item) => (
                  <div key={item.id} className="rounded-lg border px-2.5 py-2">
                    <button
                      type="button"
                      className="flex w-full items-start justify-between gap-2 text-left"
                      onClick={() =>
                        setExpandedCaseId(
                          expandedCaseId === item.id ? null : item.id,
                        )
                      }
                    >
                      <div className="min-w-0">
                        <div className="text-foreground truncate text-sm font-medium">
                          {item.title}
                        </div>
                        <div className="text-muted-foreground mt-0.5 flex items-center gap-1 text-xs">
                          <Clock className="size-3" />
                          {format.dateTime(new Date(item.createdAt), "short")}
                        </div>
                      </div>
                      {item.alertName !== "" && (
                        <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium">
                          {item.alertName}
                        </span>
                      )}
                    </button>
                    {expandedCaseId === item.id && (
                      <div className="text-muted-foreground mt-2 border-t pt-2 text-xs">
                        {item.summary}
                        <div className="mt-1 font-mono text-[10px] opacity-70">
                          {item.fileName}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </motion.div>
      )}
      <Button
        size="icon"
        variant={open ? "default" : "secondary"}
        className="pointer-events-auto relative size-11 rounded-full shadow-lg"
        onClick={() => setOpen((v) => !v)}
        title={t("title")}
        aria-expanded={open}
      >
        <Siren className="size-5" />
        {!open && alerts.length > 0 && (
          <span className="absolute -top-1 -right-1 flex min-h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold text-white">
            {alerts.length}
          </span>
        )}
      </Button>
    </div>
  );
}
