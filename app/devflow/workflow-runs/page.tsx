"use client";

import { useEffect, useMemo, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { FileText, ListTree, Play, RefreshCw, Workflow } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { notify } from "@/components/devflow/notify";
import { cn } from "@/lib/utils";
import PageHeader from "@/components/devflow/page-header";
import DevflowMarkdown from "@/components/devflow/markdown";
import { ConfidenceBadge } from "@/components/devflow/badges";
import { dfGet, dfPost, useDevflow } from "@/components/devflow/provider";

type EntityType = "issue" | "pull_request" | "workflow_run" | "repository";
type TaskType = "issue_analysis" | "pr_review" | "ci_debug" | "repo_health";
type RunStatus = "running" | "success" | "failed" | "cancelled";
type TaskStatus = "pending" | "running" | "success" | "failed" | "skipped";
type Severity = "info" | "warning" | "blocker";

interface ClaimView {
  id: string;
  entity_type: EntityType;
  entity_ref: string;
  task_type: TaskType;
  acceptance_criteria: string[];
}

interface SpecView {
  goal: string;
  claims: ClaimView[];
}

interface FindingView {
  finding_type: string;
  severity: Severity;
  message: string;
  claim_ids: string[];
  recommendation: string;
}

interface ObservationView {
  findings: FindingView[];
  overall_confidence: number;
  human_review_required: boolean;
  summary: string;
}

interface TaskRowView {
  taskId: string;
  agentName: string;
  taskType: TaskType;
  claim: ClaimView | null;
  status: TaskStatus;
  error: string | null;
  result: {
    summary?: string;
    confidence?: number | null;
  } | null;
}

interface PlanResponse {
  runId: string;
  spec: SpecView;
  generationMode: "llm" | "deterministic";
  violations: Array<{ claimId: string; reason: string }>;
  tasks: Array<{ taskId: string; taskType: TaskType; status: TaskStatus }>;
}

interface RunDetailView {
  id: string;
  goal: string;
  status: RunStatus;
  spec: SpecView | null;
  observation: ObservationView | null;
  finalAnswer: string;
  createdAt: string;
  completedAt: string | null;
  tasks: TaskRowView[];
}

interface RunSummaryView {
  id: string;
  goal: string;
  status: RunStatus;
  createdAt: string;
  completedAt: string | null;
  taskCount: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
}

const RUN_STATUS_KEYS = {
  running: "running",
  success: "success",
  failed: "failed",
  cancelled: "cancelled",
} as const;

const TASK_STATUS_KEYS = {
  pending: "pending",
  running: "running",
  success: "success",
  failed: "failed",
  skipped: "skipped",
} as const;

const ENTITY_KEYS = {
  issue: "issue",
  pull_request: "pullRequest",
  workflow_run: "workflowRun",
  repository: "repository",
} as const;

const TASK_TYPE_KEYS = {
  issue_analysis: "issueAnalysis",
  pr_review: "prReview",
  ci_debug: "ciDebug",
  repo_health: "repoHealth",
} as const;

const SEVERITY_KEYS = {
  info: "info",
  warning: "warning",
  blocker: "blocker",
} as const;

const TASK_STATUS_STYLE: Record<TaskStatus, string> = {
  pending: "",
  running: "border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-300",
  success:
    "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  failed: "border-transparent bg-red-500/15 text-red-700 dark:text-red-300",
  skipped: "border-transparent bg-zinc-500/15 text-zinc-600 dark:text-zinc-400",
};

const RUN_STATUS_STYLE: Record<RunStatus, string> = {
  running: "border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-300",
  success:
    "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  failed: "border-transparent bg-red-500/15 text-red-700 dark:text-red-300",
  cancelled:
    "border-transparent bg-zinc-500/15 text-zinc-600 dark:text-zinc-400",
};

const SEVERITY_STYLE: Record<Severity, string> = {
  info: "",
  warning:
    "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300",
  blocker: "border-transparent bg-red-500/15 text-red-700 dark:text-red-300",
};

interface LiveTaskState {
  status: TaskStatus;
  agentName?: string;
  taskType?: TaskType;
  summary?: string;
  confidence?: number | null;
  error?: string | null;
}

export default function DevflowWorkflowRunsPage() {
  const { repoId, repo } = useDevflow();
  const t = useTranslations("devflow.workflowRuns");
  const format = useFormatter();

  const [goal, setGoal] = useState("");
  const [planning, setPlanning] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [liveTasks, setLiveTasks] = useState<Record<string, LiveTaskState>>({});
  const [liveObservation, setLiveObservation] =
    useState<ObservationView | null>(null);
  const [liveReplans, setLiveReplans] = useState(0);
  const [memo, setMemo] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetailView | null>(null);

  const [runs, setRuns] = useState<RunSummaryView[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsReloadKey, setRunsReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!repoId) {
        setRuns([]);
        return;
      }
      setRunsLoading(true);
      try {
        const items = await dfGet<RunSummaryView[]>(
          `/workflow-runs?repoId=${repoId}`,
        );
        if (!cancelled) setRuns(items);
      } catch {
        if (!cancelled) setRuns([]);
      } finally {
        if (!cancelled) setRunsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoId, runsReloadKey]);

  const [panelRepoId, setPanelRepoId] = useState(repoId);
  if (panelRepoId !== repoId) {
    setPanelRepoId(repoId);
    setPlan(null);
    setDetail(null);
    setMemo(null);
    setLiveTasks({});
    setLiveObservation(null);
    setLiveReplans(0);
  }

  const formatTime = (iso: string | null) =>
    iso ? format.dateTime(new Date(iso), "short") : "-";

  const handlePlan = async () => {
    const trimmed = goal.trim();
    if (!repoId || !trimmed || planning) return;
    setPlanning(true);
    setPlan(null);
    setDetail(null);
    setMemo(null);
    setLiveTasks({});
    setLiveObservation(null);
    setLiveReplans(0);
    try {
      const result = await dfPost<PlanResponse>("/chat/plan", {
        repoId,
        goal: trimmed,
      });
      setPlan(result);
      if (result.violations.length > 0) {
        notify.info(
          t("violationsDropped", { count: result.violations.length }),
        );
      }
      if (result.spec.claims.length === 0) {
        notify.info(t("noClaims"));
      }
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setPlanning(false);
    }
  };

  const handleExecute = async () => {
    if (!plan || executing) return;
    setExecuting(true);
    setMemo(null);
    setLiveObservation(null);
    setLiveReplans(0);
    const initial: Record<string, LiveTaskState> = {};
    for (const task of plan.tasks) {
      initial[task.taskId] = { status: task.status, taskType: task.taskType };
    }
    setLiveTasks(initial);

    try {
      const response = await fetch("/api/devflow/chat/plan/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: plan.runId }),
      });
      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => null);
        throw new Error(
          (payload as { message?: string } | null)?.message ??
            `${response.status}`,
        );
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const rawEvent of events) {
          const lines = rawEvent.split("\n");
          const event =
            lines.find((l) => l.startsWith("event: "))?.slice(7) ?? "message";
          const dataText = lines
            .filter((l) => l.startsWith("data: "))
            .map((l) => l.slice(6))
            .join("\n");
          if (!dataText) continue;
          try {
            handleSseEvent(event, dataText);
          } catch {}
        }
      }
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setExecuting(false);
      setRunsReloadKey((key) => key + 1);
    }
  };

  const handleSseEvent = (event: string, dataText: string) => {
    if (event === "task_start") {
      const payload = JSON.parse(dataText) as {
        taskId: string;
        agentName: string;
        taskType: TaskType;
      };
      setLiveTasks((current) => ({
        ...current,
        [payload.taskId]: {
          status: "running",
          agentName: payload.agentName,
          taskType: payload.taskType,
        },
      }));
    } else if (event === "task_result") {
      const payload = JSON.parse(dataText) as {
        taskId: string;
        status: TaskStatus;
        summary: string;
        confidence: number | null;
        error: string | null;
      };
      setLiveTasks((current) => ({
        ...current,
        [payload.taskId]: {
          ...(current[payload.taskId] ?? { status: payload.status }),
          status: payload.status,
          summary: payload.summary,
          confidence: payload.confidence,
          error: payload.error,
        },
      }));
    } else if (event === "observation") {
      const payload = JSON.parse(dataText) as {
        isReplan: boolean;
        replannedClaims: string[];
        observation: ObservationView;
      };
      setLiveObservation(payload.observation);
      if (payload.isReplan) {
        setLiveReplans((count) => count + 1);
        setLiveTasks((current) => {
          const next = { ...current };
          for (const taskId of payload.replannedClaims) {
            if (!next[taskId]) next[taskId] = { status: "pending" };
          }
          return next;
        });
      }
    } else if (event === "memo") {
      const payload = JSON.parse(dataText) as { answer: string };
      setMemo(payload.answer);
    } else if (event === "done") {
      if (plan) {
        void loadDetail(plan.runId);
      }
    } else if (event === "error") {
      const payload = JSON.parse(dataText) as { message?: string };
      notify.error(payload.message ?? dataText);
    }
  };

  const loadDetail = async (runId: string) => {
    try {
      const result = await dfGet<RunDetailView>(`/workflow-runs/${runId}`);
      setDetail(result);
      if (result.finalAnswer) setMemo(result.finalAnswer);
      if (result.observation) setLiveObservation(result.observation);
      const states: Record<string, LiveTaskState> = {};
      for (const task of result.tasks) {
        states[task.taskId] = {
          status: task.status,
          agentName: task.agentName,
          taskType: task.taskType,
          summary: task.result?.summary,
          confidence: task.result?.confidence ?? null,
          error: task.error,
        };
      }
      setLiveTasks(states);
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    }
  };

  const openRun = async (runId: string) => {
    setPlan(null);
    setMemo(null);
    setLiveReplans(0);
    await loadDetail(runId);
  };

  const displaySpec = useMemo<SpecView | null>(() => {
    if (plan) return plan.spec;
    return detail?.spec ?? null;
  }, [plan, detail]);

  const displayGoal = displaySpec?.goal ?? detail?.goal ?? "";

  const taskRows = useMemo(() => {
    const rows: Array<{
      taskId: string;
      taskType?: TaskType;
      agentName?: string;
      entityRef?: string;
      entityType?: EntityType;
      state: LiveTaskState;
    }> = [];
    const claimByTaskId = new Map<string, ClaimView>();
    for (const claim of displaySpec?.claims ?? []) {
      claimByTaskId.set(claim.id, claim);
    }
    const taskIds = new Set<string>([
      ...(displaySpec?.claims ?? []).map((claim) => claim.id),
      ...Object.keys(liveTasks),
    ]);
    for (const taskId of taskIds) {
      const claim = claimByTaskId.get(taskId);
      const state = liveTasks[taskId] ?? { status: "pending" as TaskStatus };
      rows.push({
        taskId,
        taskType: state.taskType ?? claim?.task_type,
        agentName: state.agentName,
        entityRef: claim?.entity_ref,
        entityType: claim?.entity_type,
        state,
      });
    }
    return rows;
  }, [displaySpec, liveTasks]);

  const busy = planning || executing;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <PageHeader
        title={t("title")}
        description={
          repo
            ? t("descriptionRepo", { repo: repo.fullName })
            : t("descriptionNone")
        }
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRunsReloadKey((key) => key + 1)}
            disabled={runsLoading}
          >
            {runsLoading ? (
              <Spinner className="size-3.5" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            {t("refresh")}
          </Button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Workflow className="size-4" />
                {t("composerTitle")}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Textarea
                rows={2}
                placeholder={
                  repoId ? t("goalPlaceholder") : t("selectRepoFirst")
                }
                value={goal}
                disabled={!repoId || busy}
                onChange={(e) => setGoal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void handlePlan();
                  }
                }}
              />
              <div className="flex items-center gap-2">
                <Button
                  onClick={() => void handlePlan()}
                  disabled={!repoId || !goal.trim() || busy}
                >
                  {planning ? (
                    <Spinner className="size-4" />
                  ) : (
                    <ListTree className="size-4" />
                  )}
                  {t("plan")}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => void handleExecute()}
                  disabled={!plan || executing || planning}
                >
                  {executing ? (
                    <Spinner className="size-4" />
                  ) : (
                    <Play className="size-4" />
                  )}
                  {t("execute")}
                </Button>
                {liveReplans > 0 ? (
                  <Badge variant="outline">
                    {t("replanCount", { count: liveReplans })}
                  </Badge>
                ) : null}
              </div>
            </CardContent>
          </Card>

          {displaySpec ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("claimsTitle")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-muted-foreground text-sm">{displayGoal}</p>
                {displaySpec.claims.length === 0 ? (
                  <p className="text-muted-foreground text-xs italic">
                    {t("noClaims")}
                  </p>
                ) : (
                  <div className="space-y-3">
                    {displaySpec.claims.map((claim) => (
                      <div
                        key={claim.id}
                        className="border-border bg-muted/30 rounded-lg border p-3"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-xs font-medium">
                            {claim.id}
                          </span>
                          <Badge variant="outline">
                            {t(`entity.${ENTITY_KEYS[claim.entity_type]}`)}
                          </Badge>
                          <span className="font-mono text-xs">
                            {claim.entity_ref}
                          </span>
                          <Badge variant="secondary">
                            {t(`taskType.${TASK_TYPE_KEYS[claim.task_type]}`)}
                          </Badge>
                        </div>
                        <ul className="text-muted-foreground mt-2 list-disc space-y-0.5 pl-5 text-xs">
                          {claim.acceptance_criteria.map((criterion) => (
                            <li key={criterion}>{criterion}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          ) : null}

          {taskRows.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("tasksTitle")}</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("colTaskId")}</TableHead>
                      <TableHead>{t("colTaskType")}</TableHead>
                      <TableHead>{t("colEntity")}</TableHead>
                      <TableHead>{t("colStatus")}</TableHead>
                      <TableHead>{t("colConfidence")}</TableHead>
                      <TableHead>{t("colSummary")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {taskRows.map((row) => (
                      <TableRow key={row.taskId}>
                        <TableCell className="font-mono text-xs">
                          {row.taskId}
                        </TableCell>
                        <TableCell className="text-xs">
                          {row.taskType
                            ? t(`taskType.${TASK_TYPE_KEYS[row.taskType]}`)
                            : "-"}
                        </TableCell>
                        <TableCell className="text-xs">
                          {row.entityType
                            ? `${t(`entity.${ENTITY_KEYS[row.entityType]}`)} ${row.entityRef ?? ""}`
                            : "-"}
                        </TableCell>
                        <TableCell>
                          <Badge
                            className={TASK_STATUS_STYLE[row.state.status]}
                          >
                            {t(
                              `taskStatus.${TASK_STATUS_KEYS[row.state.status]}`,
                            )}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {typeof row.state.confidence === "number" ? (
                            <ConfidenceBadge
                              confidence={row.state.confidence}
                            />
                          ) : (
                            "-"
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground max-w-md text-xs">
                          {row.state.error
                            ? row.state.error
                            : (row.state.summary ?? "-")}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ) : null}

          {liveObservation ? (
            <Card>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-3 text-base">
                  {t("observationTitle")}
                  <ConfidenceBadge
                    confidence={liveObservation.overall_confidence}
                  />
                  {liveObservation.human_review_required ? (
                    <Badge
                      variant="outline"
                      className="border-amber-500/40 text-amber-700 dark:text-amber-300"
                    >
                      {t("humanReviewRequired")}
                    </Badge>
                  ) : null}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="text-muted-foreground text-sm">
                  {liveObservation.summary}
                </p>
                {liveObservation.findings.length === 0 ? (
                  <p className="text-muted-foreground text-xs italic">
                    {t("noFindings")}
                  </p>
                ) : (
                  liveObservation.findings.map((finding, index) => (
                    <div
                      key={`${finding.finding_type}-${index}`}
                      className="border-border rounded-lg border p-3"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge className={SEVERITY_STYLE[finding.severity]}>
                          {t(`severity.${SEVERITY_KEYS[finding.severity]}`)}
                        </Badge>
                        <span className="font-mono text-xs">
                          {finding.finding_type}
                        </span>
                        {finding.claim_ids.map((claimId) => (
                          <span
                            key={claimId}
                            className="text-muted-foreground font-mono text-[10px]"
                          >
                            {claimId}
                          </span>
                        ))}
                      </div>
                      <p className="mt-1.5 text-sm">{finding.message}</p>
                      {finding.recommendation ? (
                        <p className="text-muted-foreground mt-1 text-xs">
                          {t("recommendation")} {finding.recommendation}
                        </p>
                      ) : null}
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          ) : null}

          {memo ? (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <FileText className="size-4" />
                  {t("memoTitle")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <DevflowMarkdown content={memo} streaming={false} />
              </CardContent>
            </Card>
          ) : null}
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">{t("historyTitle")}</h2>
          </div>
          {runsLoading ? (
            <div className="flex justify-center py-8">
              <Spinner className="size-4" />
            </div>
          ) : runs.length === 0 ? (
            <p className="text-muted-foreground text-xs italic">
              {t("emptyRuns")}
            </p>
          ) : (
            <div className="space-y-2">
              {runs.map((run) => (
                <button
                  key={run.id}
                  onClick={() => void openRun(run.id)}
                  className={cn(
                    "border-border bg-card hover:bg-accent/50 w-full rounded-lg border p-3 text-left transition-colors",
                    detail?.id === run.id && "bg-accent",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm">{run.goal}</span>
                    <Badge className={RUN_STATUS_STYLE[run.status]}>
                      {t(`runStatus.${RUN_STATUS_KEYS[run.status]}`)}
                    </Badge>
                  </div>
                  <div className="text-muted-foreground mt-1 text-[11px]">
                    {formatTime(run.createdAt)} ·{" "}
                    {t("historyTasks", {
                      count: run.taskCount,
                      success: run.successCount,
                      failed: run.failedCount,
                    })}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
