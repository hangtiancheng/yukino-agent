"use client";

// CI / Actions: workflow runs with jobs & steps, plus AI debugging of failed
// runs (root cause, first error, fix steps).
import { useEffect, useState } from "react";
import {
  Activity,
  ChevronRight,
  ExternalLink,
  Inbox,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { notify } from "@/components/devflow/notify";
import PageHeader from "@/components/devflow/page-header";
import { CIDebugView } from "@/components/devflow/analysis-views";
import { CiConclusionBadge } from "@/components/devflow/badges";
import { dfGet, dfPost, useDevflow } from "@/components/devflow/provider";
import type { AnalysisRecord, CIDebug, RunSummary } from "@/lib/devflow/types";

function shortTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function DevflowCiPage() {
  const { repoId, repo } = useDevflow();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState<RunSummary | null>(null);
  const [debug, setDebug] = useState<CIDebug | null>(null);
  const [debugLoading, setDebugLoading] = useState(false);
  const [debugging, setDebugging] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // Fetches live in inline async IIFEs — see the note in provider.tsx
  // (react-hooks/set-state-in-effect). Manual reloads bump reloadKey.
  useEffect(() => {
    if (!repoId) {
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (filter === "failed") params.set("conclusion", "failure");
        const items = await dfGet<RunSummary[]>(
          `/repos/${repoId}/runs?${params.toString()}`,
        );
        if (cancelled) return;
        setRuns(items);
        setSelected((current) => {
          if (current && items.some((r) => r.id === current.id)) return current;
          return items[0] ?? null;
        });
      } catch (e) {
        if (cancelled) return;
        notify.error(e instanceof Error ? e.message : String(e));
        setRuns([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoId, filter, reloadKey]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    (async () => {
      setDebugLoading(true);
      try {
        const records = await dfGet<AnalysisRecord[]>(
          `/analyses?targetType=workflow_run&targetId=${selected.id}&limit=1`,
        );
        if (cancelled) return;
        setDebug(records.length > 0 ? (records[0].result as CIDebug) : null);
      } catch {
        if (!cancelled) setDebug(null);
      } finally {
        if (!cancelled) setDebugLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const runDebug = async () => {
    if (!selected) return;
    setDebugging(true);
    try {
      const record = await dfPost<{ id: string; result: CIDebug }>(
        `/runs/${selected.id}/debug`,
      );
      setDebug(record.result);
      notify.success("CI failure analyzed");
      setReloadKey((k) => k + 1);
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setDebugging(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-6">
      <PageHeader
        title="CI / Actions"
        description={
          repo
            ? `Workflow runs of ${repo.fullName}. Failed runs carry logs for AI debugging.`
            : "Select a repository to browse its CI runs"
        }
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => setReloadKey((k) => k + 1)}
            disabled={loading}
          >
            <RefreshCw className={loading ? "animate-spin" : ""} />
            Refresh
          </Button>
        }
      />

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[380px_1fr]">
        <Card className="flex min-h-0 flex-col py-0">
          <div className="p-3 pb-2">
            <Tabs value={filter} onValueChange={setFilter}>
              <TabsList className="w-full">
                <TabsTrigger value="all" className="flex-1">
                  All runs
                </TabsTrigger>
                <TabsTrigger value="failed" className="flex-1">
                  Failed
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          <Separator />
          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-1 p-2">
              {loading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-14 rounded-lg" />
                ))
              ) : runs.length === 0 ? (
                <div className="text-muted-foreground flex flex-col items-center gap-2 py-10 text-center text-sm">
                  <Inbox className="size-6" />
                  No workflow runs found. Sync the repository first.
                </div>
              ) : (
                runs.map((run) => (
                  <button
                    key={run.id}
                    onClick={() => setSelected(run)}
                    className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                      selected?.id === run.id
                        ? "border-primary/50 bg-primary/5"
                        : "hover:bg-accent/50 border-transparent"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-foreground truncate text-sm font-medium">
                        {run.name}
                      </span>
                      <CiConclusionBadge
                        status={run.status}
                        conclusion={run.conclusion}
                      />
                      {run.latestAnalysis ? (
                        <Sparkles className="text-primary ml-auto size-3.5 shrink-0" />
                      ) : null}
                    </div>
                    <div className="text-muted-foreground mt-1 flex items-center gap-2 text-xs">
                      {run.headBranch ? (
                        <span className="font-mono">{run.headBranch}</span>
                      ) : null}
                      <span>· {shortTime(run.githubCreatedAt)}</span>
                      {run.hasLogs ? (
                        <Badge
                          variant="outline"
                          className="ml-auto text-[10px]"
                        >
                          logs
                        </Badge>
                      ) : null}
                    </div>
                  </button>
                ))
              )}
            </div>
          </ScrollArea>
        </Card>

        <div className="min-h-0 space-y-4 overflow-y-auto pr-1">
          {!selected ? (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center gap-2 py-16 text-center">
                <Activity className="text-muted-foreground size-8" />
                <p className="text-muted-foreground text-sm">
                  Select a workflow run to inspect its jobs and debug failures.
                </p>
              </CardContent>
            </Card>
          ) : (
            <>
              <Card>
                <CardContent className="space-y-3 pt-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h2 className="text-foreground text-lg font-semibold">
                        {selected.name}
                      </h2>
                      <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-2 text-xs">
                        <CiConclusionBadge
                          status={selected.status}
                          conclusion={selected.conclusion}
                        />
                        {selected.headBranch ? (
                          <span className="font-mono">
                            {selected.headBranch}
                          </span>
                        ) : null}
                        <span>{shortTime(selected.githubCreatedAt)}</span>
                        {selected.htmlUrl ? (
                          <a
                            href={selected.htmlUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-primary inline-flex items-center gap-1 hover:underline"
                          >
                            View on GitHub
                            <ExternalLink className="size-3" />
                          </a>
                        ) : null}
                      </div>
                    </div>
                    {selected.conclusion === "failure" ? (
                      <Button onClick={runDebug} disabled={debugging}>
                        {debugging ? (
                          <RefreshCw className="animate-spin" />
                        ) : (
                          <Sparkles />
                        )}
                        {debugging
                          ? "Analyzing…"
                          : debug
                            ? "Re-run debug"
                            : "Debug with AI"}
                      </Button>
                    ) : null}
                  </div>

                  {selected.jobs && selected.jobs.length > 0 ? (
                    <>
                      <Separator />
                      <div className="space-y-1.5">
                        {selected.jobs.map((job, i) => (
                          <Collapsible key={job.id ?? i}>
                            <CollapsibleTrigger className="hover:bg-accent/50 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left">
                              <ChevronRight className="text-muted-foreground size-4 transition-transform [[data-state=open]_&]:rotate-90" />
                              <span className="text-foreground text-sm">
                                {job.name ?? `Job ${i + 1}`}
                              </span>
                              <CiConclusionBadge
                                status={job.status ?? "unknown"}
                                conclusion={job.conclusion ?? null}
                              />
                            </CollapsibleTrigger>
                            <CollapsibleContent>
                              <div className="ml-6 space-y-1 border-l pl-3">
                                {(job.steps ?? []).map((step, j) => (
                                  <div
                                    key={j}
                                    className="flex items-center gap-2 py-0.5 text-xs"
                                  >
                                    <span
                                      className={`size-1.5 shrink-0 rounded-full ${
                                        step.conclusion === "success"
                                          ? "bg-emerald-500"
                                          : step.conclusion === "failure"
                                            ? "bg-red-500"
                                            : "bg-zinc-300 dark:bg-zinc-600"
                                      }`}
                                    />
                                    <span className="text-muted-foreground">
                                      {step.number ?? j + 1}.
                                    </span>
                                    <span className="text-foreground">
                                      {step.name}
                                    </span>
                                    {step.conclusion &&
                                    step.conclusion !== "success" ? (
                                      <Badge
                                        variant="outline"
                                        className="ml-auto text-[10px] capitalize"
                                      >
                                        {step.conclusion}
                                      </Badge>
                                    ) : null}
                                  </div>
                                ))}
                                {(job.steps ?? []).length === 0 ? (
                                  <p className="text-muted-foreground py-1 text-xs italic">
                                    No step metadata.
                                  </p>
                                ) : null}
                              </div>
                            </CollapsibleContent>
                          </Collapsible>
                        ))}
                      </div>
                    </>
                  ) : null}
                </CardContent>
              </Card>

              {selected.conclusion === "failure" ? (
                debugLoading ? (
                  <div className="space-y-3">
                    <Skeleton className="h-36 rounded-xl" />
                    <Skeleton className="h-28 rounded-xl" />
                  </div>
                ) : debug ? (
                  <CIDebugView debug={debug} />
                ) : (
                  <Card className="border-dashed">
                    <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
                      <Sparkles className="text-muted-foreground size-6" />
                      <p className="text-foreground text-sm font-medium">
                        Failed run not analyzed yet
                      </p>
                      <p className="text-muted-foreground max-w-sm text-xs">
                        Debug with AI to get the first error, root cause,
                        concrete fix steps and further investigation hints.
                      </p>
                    </CardContent>
                  </Card>
                )
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
