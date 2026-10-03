"use client";

// Issues: master-detail workspace. Select an issue, run AI triage, inspect the
// structured verdict, and turn suggested drafts into confirmable actions.
import { useEffect, useState } from "react";
import {
  CircleDot,
  ClipboardCheck,
  Inbox,
  RefreshCw,
  Search,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { notify } from "@/components/devflow/notify";
import PageHeader from "@/components/devflow/page-header";
import DevflowMarkdown from "@/components/devflow/markdown";
import { IssueAnalysisView } from "@/components/devflow/analysis-views";
import { IssueStateBadge } from "@/components/devflow/badges";
import { dfGet, dfPost, useDevflow } from "@/components/devflow/provider";
import type {
  AnalysisRecord,
  IssueAnalysis,
  IssueSummary,
} from "@/lib/devflow/types";

export default function DevflowIssuesPage() {
  const { repoId, repo } = useDevflow();
  const [issues, setIssues] = useState<IssueSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [state, setState] = useState("open");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<IssueSummary | null>(null);
  const [analysis, setAnalysis] = useState<IssueAnalysis | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
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
        if (state !== "all") params.set("state", state);
        if (query.trim()) params.set("q", query.trim());
        const items = await dfGet<IssueSummary[]>(
          `/repos/${repoId}/issues?${params.toString()}`,
        );
        if (cancelled) return;
        setIssues(items);
        setSelected((current) => {
          if (current && items.some((i) => i.id === current.id)) return current;
          return items[0] ?? null;
        });
      } catch (e) {
        if (cancelled) return;
        notify.error(e instanceof Error ? e.message : String(e));
        setIssues([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoId, state, query, reloadKey]);

  // Load the latest saved analysis whenever the selection changes.
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    (async () => {
      setAnalysisLoading(true);
      try {
        const records = await dfGet<AnalysisRecord[]>(
          `/analyses?targetType=issue&targetId=${selected.id}&limit=1`,
        );
        if (cancelled) return;
        setAnalysis(
          records.length > 0 ? (records[0].result as IssueAnalysis) : null,
        );
      } catch {
        if (!cancelled) setAnalysis(null);
      } finally {
        if (!cancelled) setAnalysisLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const runAnalysis = async () => {
    if (!selected) return;
    setAnalyzing(true);
    try {
      const record = await dfPost<{ id: string; result: IssueAnalysis }>(
        `/issues/${selected.id}/analyze`,
      );
      setAnalysis(record.result);
      notify.success(`Issue #${selected.number} triaged`);
      setReloadKey((k) => k + 1);
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setAnalyzing(false);
    }
  };

  const createDraft = async (
    draftType: "issue_comment" | "close_issue",
    title: string,
    content: string,
  ) => {
    if (!selected || !repoId) return;
    try {
      await dfPost("/drafts", {
        repoId,
        draftType,
        targetType: "issue",
        targetNumber: selected.number,
        title,
        content,
        riskLevel: draftType === "close_issue" ? "high" : "medium",
      });
      notify.success("Action draft created — review it on the Drafts page");
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-6">
      <PageHeader
        title="Issue Triage"
        description={
          repo
            ? `AI classification, priority, owner suggestion and next actions for ${repo.fullName}`
            : "Select a repository to browse its issues"
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

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[360px_1fr]">
        {/* Master: issue list */}
        <Card className="flex min-h-0 flex-col py-0">
          <div className="space-y-3 p-3 pb-2">
            <div className="relative">
              <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
              <Input
                className="pl-8"
                placeholder="Search issues…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Tabs value={state} onValueChange={setState}>
              <TabsList className="w-full">
                <TabsTrigger value="open" className="flex-1">
                  Open
                </TabsTrigger>
                <TabsTrigger value="closed" className="flex-1">
                  Closed
                </TabsTrigger>
                <TabsTrigger value="all" className="flex-1">
                  All
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          <Separator />
          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-1 p-2">
              {loading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-16 rounded-lg" />
                ))
              ) : issues.length === 0 ? (
                <div className="text-muted-foreground flex flex-col items-center gap-2 py-10 text-center text-sm">
                  <Inbox className="size-6" />
                  No issues found. Sync the repository first.
                </div>
              ) : (
                issues.map((issue) => (
                  <button
                    key={issue.id}
                    onClick={() => setSelected(issue)}
                    className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                      selected?.id === issue.id
                        ? "border-primary/50 bg-primary/5"
                        : "hover:bg-accent/50 border-transparent"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground shrink-0 font-mono text-xs">
                        #{issue.number}
                      </span>
                      <IssueStateBadge state={issue.state} />
                      {issue.latestAnalysis ? (
                        <Sparkles className="text-primary ml-auto size-3.5 shrink-0" />
                      ) : null}
                    </div>
                    <p className="text-foreground mt-1 line-clamp-2 text-sm leading-snug">
                      {issue.title}
                    </p>
                    {issue.labels.length > 0 ? (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {issue.labels.slice(0, 4).map((label) => (
                          <Badge
                            key={label}
                            variant="outline"
                            className="text-[10px] font-normal"
                          >
                            {label}
                          </Badge>
                        ))}
                      </div>
                    ) : null}
                  </button>
                ))
              )}
            </div>
          </ScrollArea>
        </Card>

        {/* Detail */}
        <div className="min-h-0 space-y-4 overflow-y-auto pr-1">
          {!selected ? (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center gap-2 py-16 text-center">
                <CircleDot className="text-muted-foreground size-8" />
                <p className="text-muted-foreground text-sm">
                  Select an issue to see details and run AI triage.
                </p>
              </CardContent>
            </Card>
          ) : (
            <>
              <Card>
                <CardContent className="space-y-3 pt-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="text-foreground text-lg leading-snug font-semibold">
                        <span className="text-muted-foreground font-mono">
                          #{selected.number}
                        </span>{" "}
                        {selected.title}
                      </h2>
                      <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-2 text-xs">
                        <IssueStateBadge state={selected.state} />
                        {selected.author ? (
                          <span>by {selected.author}</span>
                        ) : null}
                        {selected.assignees.length > 0 ? (
                          <span>
                            · assigned: {selected.assignees.join(", ")}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <Button onClick={runAnalysis} disabled={analyzing}>
                      {analyzing ? (
                        <RefreshCw className="animate-spin" />
                      ) : (
                        <Sparkles />
                      )}
                      {analyzing
                        ? "Analyzing…"
                        : analysis
                          ? "Re-run triage"
                          : "Run AI triage"}
                    </Button>
                  </div>
                  {selected.labels.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {selected.labels.map((label) => (
                        <Badge key={label} variant="secondary">
                          {label}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                  <Separator />
                  {selected.body ? (
                    <DevflowMarkdown content={selected.body} />
                  ) : (
                    <p className="text-muted-foreground text-sm italic">
                      No description provided.
                    </p>
                  )}
                </CardContent>
              </Card>

              {analysisLoading ? (
                <div className="space-y-3">
                  <Skeleton className="h-40 rounded-xl" />
                  <Skeleton className="h-28 rounded-xl" />
                </div>
              ) : analysis ? (
                <>
                  <IssueAnalysisView analysis={analysis} />
                  <div className="flex flex-wrap gap-2">
                    {analysis.drafts.clarification_comment ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          void createDraft(
                            "issue_comment",
                            `Clarification for #${selected.number}`,
                            analysis.drafts.clarification_comment ?? "",
                          )
                        }
                      >
                        <ClipboardCheck />
                        Draft clarification comment
                      </Button>
                    ) : null}
                    {analysis.conclusion === "close" ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          void createDraft(
                            "close_issue",
                            `Close #${selected.number}`,
                            analysis.conclusion_reason,
                          )
                        }
                      >
                        <ClipboardCheck />
                        Draft close action
                      </Button>
                    ) : null}
                  </div>
                </>
              ) : (
                <Card className="border-dashed">
                  <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
                    <Sparkles className="text-muted-foreground size-6" />
                    <p className="text-foreground text-sm font-medium">
                      No analysis yet
                    </p>
                    <p className="text-muted-foreground max-w-sm text-xs">
                      Run AI triage to classify this issue, suggest an owner,
                      find duplicates and produce next actions.
                    </p>
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
