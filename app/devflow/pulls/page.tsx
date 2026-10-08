"use client";

// Pull Requests: master-detail workspace with AI review of diffs, files and
// existing review comments.
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import {
  ClipboardCheck,
  FileCode2,
  GitPullRequest,
  Inbox,
  ListChecks,
  MessageSquare,
  RefreshCw,
  Search,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { notify } from "@/components/devflow/notify";
import PageHeader from "@/components/devflow/page-header";
import DevflowMarkdown from "@/components/devflow/markdown";
import { PRReviewView } from "@/components/devflow/analysis-views";
import { PrStateBadge, SeverityBadge } from "@/components/devflow/badges";
import { dfGet, dfPost, useDevflow } from "@/components/devflow/provider";
import type {
  AnalysisRecord,
  PRReview,
  PullSummary,
} from "@/lib/devflow/types";

// Client-side mirror of lib/devflow/content-index.ts ReviewChecklistResult
// (POST /api/devflow/pulls/:id/review-checklist); the lib module owns runtime
// prisma/milvus imports, so only the shape is mirrored here.
type ChecklistSeverity = "P1" | "P2" | "P3";

interface ChecklistFinding {
  severity: ChecklistSeverity;
  title: string;
  evidence: string;
  blocking: boolean;
  action: string;
}

interface ReviewChecklist {
  prId: string;
  number: number;
  findings: ChecklistFinding[];
  checklist: string[];
  blocking: boolean;
}

const FILE_STATUS_KEYS: Record<
  string,
  | "added"
  | "removed"
  | "modified"
  | "renamed"
  | "copied"
  | "changed"
  | "unchanged"
> = {
  added: "added",
  removed: "removed",
  modified: "modified",
  renamed: "renamed",
  copied: "copied",
  changed: "changed",
  unchanged: "unchanged",
};

export default function DevflowPullsPage() {
  const { repoId, repo } = useDevflow();
  const t = useTranslations("devflow.pulls");
  const tc = useTranslations("common");
  const tf = useTranslations("devflow.badges.fileStatus");
  const tb = useTranslations("devflow.badges");
  const ta = useTranslations("devflow.analysis");
  const [pulls, setPulls] = useState<PullSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [state, setState] = useState("open");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<PullSummary | null>(null);
  const [review, setReview] = useState<PRReview | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // Deterministic pre-merge checklist (POST /pulls/:id/review-checklist)
  const [checklist, setChecklist] = useState<ReviewChecklist | null>(null);
  const [checklistLoading, setChecklistLoading] = useState(false);
  const [checklistOpen, setChecklistOpen] = useState(false);

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
        const items = await dfGet<PullSummary[]>(
          `/repos/${repoId}/pulls?${params.toString()}`,
        );
        if (cancelled) return;
        setPulls(items);
        setSelected((current) => {
          if (current && items.some((p) => p.id === current.id)) return current;
          return items[0] ?? null;
        });
      } catch (e) {
        if (cancelled) return;
        notify.error(e instanceof Error ? e.message : String(e));
        setPulls([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoId, state, query, reloadKey]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    (async () => {
      setReviewLoading(true);
      // The checklist dialog belongs to the previous selection, so it resets.
      setChecklist(null);
      setChecklistOpen(false);
      try {
        const records = await dfGet<AnalysisRecord[]>(
          `/analyses?targetType=pull_request&targetId=${selected.id}&limit=1`,
        );
        if (cancelled) return;
        setReview(records.length > 0 ? (records[0].result as PRReview) : null);
      } catch {
        if (!cancelled) setReview(null);
      } finally {
        if (!cancelled) setReviewLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const runReview = async () => {
    if (!selected) return;
    setReviewing(true);
    try {
      const record = await dfPost<{ id: string; result: PRReview }>(
        `/pulls/${selected.id}/analyze`,
      );
      setReview(record.result);
      notify.success(t("reviewed", { number: selected.number }));
      setReloadKey((k) => k + 1);
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setReviewing(false);
    }
  };

  const runChecklist = async () => {
    if (!selected) return;
    setChecklistLoading(true);
    setChecklistOpen(true);
    setChecklist(null);
    try {
      const result = await dfPost<ReviewChecklist>(
        `/pulls/${selected.id}/review-checklist`,
      );
      setChecklist(result);
    } catch (e) {
      setChecklistOpen(false);
      notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setChecklistLoading(false);
    }
  };

  const draftReviewComment = async () => {
    if (!selected || !repoId || !review) return;
    const body = [
      t("aiReviewHeading", { number: selected.number }),
      "",
      review.summary,
      "",
      review.review_findings.length > 0
        ? `${t("findingsLabel")}\n${review.review_findings
            .map((f) => `- [${f.severity}] ${f.title} — ${f.required_action}`)
            .join("\n")}`
        : "",
      "",
      review.test_suggestions.length > 0
        ? `${t("testSuggestionsLabel")}\n${review.test_suggestions.map((s) => `- ${s}`).join("\n")}`
        : "",
      "",
      t("generatedNote"),
    ]
      .filter((line) => line !== "")
      .join("\n");
    try {
      await dfPost("/drafts", {
        repoId,
        draftType: "issue_comment",
        targetType: "pull_request",
        targetNumber: selected.number,
        title: t("reviewCommentTitle", { number: selected.number }),
        content: body,
        riskLevel: "medium",
      });
      notify.success(t("reviewCommentDrafted"));
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-6">
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
            onClick={() => setReloadKey((k) => k + 1)}
            disabled={loading}
          >
            <RefreshCw className={loading ? "animate-spin" : ""} />
            {tc("refresh")}
          </Button>
        }
      />

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[360px_1fr]">
        <Card className="flex min-h-0 flex-col py-0">
          <div className="space-y-3 p-3 pb-2">
            <div className="relative">
              <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
              <Input
                className="pl-8"
                placeholder={t("searchPlaceholder")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Tabs value={state} onValueChange={setState}>
              <TabsList className="w-full">
                <TabsTrigger value="open" className="flex-1">
                  {t("tabOpen")}
                </TabsTrigger>
                <TabsTrigger value="merged" className="flex-1">
                  {t("tabMerged")}
                </TabsTrigger>
                <TabsTrigger value="all" className="flex-1">
                  {t("tabAll")}
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
              ) : pulls.length === 0 ? (
                <div className="text-muted-foreground flex flex-col items-center gap-2 py-10 text-center text-sm">
                  <Inbox className="size-6" />
                  {t("empty")}
                </div>
              ) : (
                pulls.map((pr) => (
                  <button
                    key={pr.id}
                    onClick={() => setSelected(pr)}
                    className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                      selected?.id === pr.id
                        ? "border-primary/50 bg-primary/5"
                        : "hover:bg-accent/50 border-transparent"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground shrink-0 font-mono text-xs">
                        #{pr.number}
                      </span>
                      <PrStateBadge state={pr.state} />
                      <span className="ml-auto shrink-0 font-mono text-[10px]">
                        <span className="text-emerald-600">
                          +{pr.additions}
                        </span>{" "}
                        <span className="text-red-500">−{pr.deletions}</span>
                      </span>
                      {pr.latestAnalysis ? (
                        <Sparkles className="text-primary size-3.5 shrink-0" />
                      ) : null}
                    </div>
                    <p className="text-foreground mt-1 line-clamp-2 text-sm leading-snug">
                      {pr.title}
                    </p>
                    {pr.author ? (
                      <p className="text-muted-foreground mt-0.5 text-xs">
                        {pr.author}
                        {pr.headBranch ? ` · ${pr.headBranch}` : ""}
                      </p>
                    ) : null}
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
                <GitPullRequest className="text-muted-foreground size-8" />
                <p className="text-muted-foreground text-sm">
                  {t("selectPrompt")}
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
                        <PrStateBadge state={selected.state} />
                        {selected.author ? (
                          <span>
                            {t("byAuthor", { author: selected.author })}
                          </span>
                        ) : null}
                        {selected.baseBranch && selected.headBranch ? (
                          <span className="font-mono">
                            {selected.headBranch} → {selected.baseBranch}
                          </span>
                        ) : null}
                        {selected.reviewCommentCount > 0 ? (
                          <span className="inline-flex items-center gap-1">
                            <MessageSquare className="size-3" />
                            {selected.reviewCommentCount}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <Button
                        variant="outline"
                        onClick={() => void runChecklist()}
                        disabled={checklistLoading}
                      >
                        {checklistLoading ? (
                          <RefreshCw className="animate-spin" />
                        ) : (
                          <ListChecks />
                        )}
                        {checklistLoading
                          ? t("checklist.generating")
                          : t("checklist.button")}
                      </Button>
                      <Button onClick={runReview} disabled={reviewing}>
                        {reviewing ? (
                          <RefreshCw className="animate-spin" />
                        ) : (
                          <Sparkles />
                        )}
                        {reviewing
                          ? t("reviewing")
                          : review
                            ? t("rerunReview")
                            : t("runReview")}
                      </Button>
                    </div>
                  </div>
                  {selected.body ? (
                    <>
                      <Separator />
                      <DevflowMarkdown content={selected.body} />
                    </>
                  ) : null}
                </CardContent>
              </Card>

              {selected.files.length > 0 ? (
                <Card>
                  <CardHeader className="py-3">
                    <CardTitle className="flex items-center gap-1.5 text-sm">
                      <FileCode2 className="text-muted-foreground size-4" />
                      {t("changedFiles")}
                      <Badge variant="secondary" className="ml-1">
                        {selected.files.length}
                      </Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-1">
                    {selected.files.slice(0, 40).map((file) => (
                      <div
                        key={file.filename}
                        className="odd:bg-muted/40 flex items-center gap-2 rounded-md px-2 py-1.5 text-sm"
                      >
                        <Badge
                          variant="outline"
                          className="w-16 shrink-0 justify-center text-[10px]"
                        >
                          {FILE_STATUS_KEYS[file.status]
                            ? tf(FILE_STATUS_KEYS[file.status])
                            : file.status}
                        </Badge>
                        <span className="text-foreground truncate font-mono text-xs">
                          {file.filename}
                        </span>
                        <span className="ml-auto shrink-0 font-mono text-xs">
                          <span className="text-emerald-600">
                            +{file.additions}
                          </span>{" "}
                          <span className="text-red-500">
                            −{file.deletions}
                          </span>
                        </span>
                      </div>
                    ))}
                    {selected.files.length > 40 ? (
                      <p className="text-muted-foreground px-2 pt-1 text-xs">
                        {t("moreFiles", {
                          count: selected.files.length - 40,
                        })}
                      </p>
                    ) : null}
                  </CardContent>
                </Card>
              ) : null}

              {reviewLoading ? (
                <div className="space-y-3">
                  <Skeleton className="h-40 rounded-xl" />
                  <Skeleton className="h-28 rounded-xl" />
                </div>
              ) : review ? (
                <>
                  <PRReviewView review={review} />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void draftReviewComment()}
                  >
                    <ClipboardCheck />
                    {t("draftReviewComment")}
                  </Button>
                </>
              ) : (
                <Card className="border-dashed">
                  <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
                    <Sparkles className="text-muted-foreground size-6" />
                    <p className="text-foreground text-sm font-medium">
                      {t("noReview")}
                    </p>
                    <p className="text-muted-foreground max-w-sm text-xs">
                      {t("noReviewDescription")}
                    </p>
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </div>
      </div>

      <Dialog
        open={checklistOpen}
        onOpenChange={(o) => !o && setChecklistOpen(false)}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("checklist.dialogTitle")}</DialogTitle>
            <DialogDescription>
              {selected
                ? t("checklist.dialogDescription", { number: selected.number })
                : t("checklist.dialogDescriptionGeneric")}
            </DialogDescription>
          </DialogHeader>
          {checklistLoading ? (
            <div className="flex justify-center py-10">
              <Spinner className="size-5" />
            </div>
          ) : checklist ? (
            <div className="max-h-[60vh] space-y-4 overflow-y-auto">
              <div className="flex flex-wrap items-center gap-2">
                {checklist.blocking ? (
                  <Badge variant="destructive">{t("checklist.blocking")}</Badge>
                ) : (
                  <Badge variant="outline">{t("checklist.clear")}</Badge>
                )}
                <Badge variant="secondary">
                  {tb("blockingCount", {
                    count: checklist.findings.filter((f) => f.blocking).length,
                  })}
                </Badge>
              </div>
              <div className="space-y-2">
                <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                  {t("checklist.findings")}
                </p>
                {checklist.findings.length === 0 ? (
                  <p className="text-muted-foreground text-sm italic">
                    {t("checklist.noFindings")}
                  </p>
                ) : (
                  checklist.findings.map((finding, i) => (
                    <div
                      key={i}
                      className="border-border rounded-lg border p-3"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <SeverityBadge severity={finding.severity} />
                        <span className="text-foreground text-sm font-medium">
                          {finding.title}
                        </span>
                        {finding.blocking ? (
                          <Badge variant="destructive">{tb("blocking")}</Badge>
                        ) : null}
                      </div>
                      <p className="text-muted-foreground mt-2 text-xs leading-relaxed">
                        <span className="font-medium">
                          {ta("evidenceLabel")}
                        </span>
                        {finding.evidence}
                      </p>
                      <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
                        <span className="font-medium">
                          {ta("requiredAction")}
                        </span>
                        {finding.action}
                      </p>
                    </div>
                  ))
                )}
              </div>
              <div className="space-y-2">
                <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                  {t("checklist.actions")}
                </p>
                <ol className="space-y-1.5">
                  {checklist.checklist.map((item, i) => (
                    <li
                      key={i}
                      className="text-foreground flex gap-2 text-sm leading-relaxed"
                    >
                      <span className="text-muted-foreground mt-0.5 shrink-0 text-xs">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
