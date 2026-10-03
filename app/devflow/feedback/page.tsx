"use client";

// Feedback review: aggregate quality metrics for the selected repository plus a
// review queue over rated answers. Negative feedback can be resolved/dismissed
// with a note, and any entry can be opened as a trace (question + answer +
// tool calls). Backed by /api/devflow/feedback* (Category C).
import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Eye,
  ThumbsDown,
  ThumbsUp,
  XCircle,
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
import { Skeleton } from "@/components/ui/skeleton";
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
import {
  Empty,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { notify } from "@/components/devflow/notify";
import PageHeader from "@/components/devflow/page-header";
import DevflowMarkdown from "@/components/devflow/markdown";
import { dfGet, dfPatch, useDevflow } from "@/components/devflow/provider";
import type {
  FeedbackMetrics,
  FeedbackReason,
  FeedbackTrace,
  FeedbackView,
} from "@/lib/devflow/types";

const REASON_LABELS: Record<FeedbackReason, string> = {
  inaccurate: "Inaccurate content",
  not_relevant: "Did not solve the problem",
  missing_context: "Missing key context",
  unreliable_citation: "Unreliable citation",
  tool_error: "Tool execution error",
  other: "Other",
};

const REVIEW_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> =
  {
    open: "destructive",
    in_review: "default",
    resolved: "secondary",
    dismissed: "outline",
  };

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function MetricCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <Card>
      <CardContent className="pt-5">
        <div className="text-foreground text-2xl leading-none font-semibold tabular-nums">
          {value}
        </div>
        <div className="text-muted-foreground mt-1 text-xs">
          {label}
          {hint ? <span className="ml-1 opacity-70">· {hint}</span> : null}
        </div>
      </CardContent>
    </Card>
  );
}

export default function DevflowFeedbackPage() {
  const { repoId, repo } = useDevflow();
  const [metrics, setMetrics] = useState<FeedbackMetrics | null>(null);
  const [rows, setRows] = useState<FeedbackView[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "open" | "resolved">("all");

  const [trace, setTrace] = useState<FeedbackTrace | null>(null);
  const [traceLoading, setTraceLoading] = useState(false);
  const [reviewTarget, setReviewTarget] = useState<FeedbackView | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [reviewStatus, setReviewStatus] = useState<"resolved" | "dismissed">(
    "resolved",
  );
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!repoId) {
        setMetrics(null);
        setRows([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const [m, list] = await Promise.all([
          dfGet<FeedbackMetrics>(`/feedback/metrics?repoId=${repoId}`),
          dfGet<FeedbackView[]>(`/feedback?repoId=${repoId}&limit=200`),
        ]);
        if (cancelled) return;
        setMetrics(m);
        setRows(list);
      } catch {
        if (!cancelled) {
          setMetrics(null);
          setRows([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoId]);

  const filtered = useMemo(() => {
    if (filter === "all") return rows;
    if (filter === "open")
      return rows.filter(
        (r) => r.reviewStatus === "open" || r.reviewStatus === "in_review",
      );
    return rows.filter(
      (r) => r.reviewStatus === "resolved" || r.reviewStatus === "dismissed",
    );
  }, [rows, filter]);

  const openTrace = async (row: FeedbackView) => {
    setTraceLoading(true);
    setTrace(null);
    try {
      const data = await dfGet<FeedbackTrace>(
        `/feedback/trace/${row.assistantMessageId}`,
      );
      setTrace(data);
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
      setTraceLoading(false);
      return;
    }
    setTraceLoading(false);
  };

  const submitReview = async () => {
    if (!reviewTarget) return;
    setSubmitting(true);
    try {
      const updated = await dfPatch<FeedbackView>(`/feedback/${reviewTarget.id}`, {
        reviewStatus,
        ...(reviewNote.trim() ? { reviewNote: reviewNote.trim() } : {}),
      });
      setRows((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
      setReviewTarget(null);
      setReviewNote("");
      notify.success(`Marked ${reviewStatus}`);
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <PageHeader
        title="Feedback"
        description={
          repo
            ? `Answer quality signals for ${repo.fullName}`
            : "Select a repository to review chat feedback"
        }
        actions={
          <div className="flex items-center gap-1.5">
            {(["all", "open", "resolved"] as const).map((f) => (
              <Button
                key={f}
                size="sm"
                variant={filter === f ? "default" : "outline"}
                className="capitalize"
                onClick={() => setFilter(f)}
              >
                {f}
              </Button>
            ))}
          </div>
        }
      />

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
      ) : metrics ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            label="Helpful rate"
            value={pct(metrics.helpfulRate)}
            hint={`${metrics.helpful}/${metrics.ratedMessages} rated`}
          />
          <MetricCard
            label="Unhelpful rate"
            value={pct(metrics.unhelpfulRate)}
            hint={`${metrics.unhelpful} negative`}
          />
          <MetricCard
            label="Open reviews"
            value={String(metrics.openReviews)}
            hint="awaiting triage"
          />
          <MetricCard
            label="Coverage"
            value={pct(metrics.feedbackCoverage)}
            hint={`${metrics.ratedMessages}/${metrics.assistantMessages} answers rated`}
          />
        </div>
      ) : null}

      {metrics && Object.keys(metrics.reasonCounts).length > 0 ? (
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm">Negative reasons</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {Object.entries(metrics.reasonCounts)
              .sort((a, b) => b[1] - a[1])
              .map(([key, count]) => (
                <Badge key={key} variant="outline" className="gap-1.5">
                  {REASON_LABELS[key as FeedbackReason] ?? key}
                  <span className="text-muted-foreground tabular-nums">
                    {count}
                  </span>
                </Badge>
              ))}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-sm">Review queue</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex justify-center py-10">
              <Spinner className="size-5" />
            </div>
          ) : filtered.length === 0 ? (
            <Empty className="py-10">
              <EmptyMedia variant="icon">
                <ThumbsUp />
              </EmptyMedia>
              <EmptyTitle>No feedback yet</EmptyTitle>
              <EmptyDescription>
                Rate answers in Agent Chat to build the review queue.
              </EmptyDescription>
            </Empty>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Rating</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Comment</TableHead>
                    <TableHead>Review</TableHead>
                    <TableHead>Notification</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>
                        {row.rating === "helpful" ? (
                          <Badge variant="secondary" className="gap-1">
                            <ThumbsUp className="size-3" />
                            Helpful
                          </Badge>
                        ) : (
                          <Badge variant="destructive" className="gap-1">
                            <ThumbsDown className="size-3" />
                            Unhelpful
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground max-w-40 truncate text-xs">
                        {row.reason
                          ? (REASON_LABELS[row.reason] ?? row.reason)
                          : "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground max-w-56 truncate text-xs">
                        {row.comment ?? "—"}
                      </TableCell>
                      <TableCell>
                        <Badge variant={REVIEW_VARIANT[row.reviewStatus] ?? "outline"}>
                          {row.reviewStatus.replace("_", " ")}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {row.notificationStatus.replace("_", " ")}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void openTrace(row)}
                          >
                            <Eye className="size-3.5" />
                            Trace
                          </Button>
                          {row.rating === "unhelpful" &&
                          (row.reviewStatus === "open" ||
                            row.reviewStatus === "in_review") ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setReviewStatus("resolved");
                                setReviewNote("");
                                setReviewTarget(row);
                              }}
                            >
                              <CheckCircle2 className="size-3.5" />
                              Review
                            </Button>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Trace dialog */}
      <Dialog open={trace !== null || traceLoading} onOpenChange={(o) => !o && setTrace(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Answer trace</DialogTitle>
            <DialogDescription>
              {trace?.repository?.fullName ?? "Loading…"}
              {trace?.conversation ? ` · ${trace.conversation.title}` : ""}
            </DialogDescription>
          </DialogHeader>
          {traceLoading ? (
            <div className="flex justify-center py-10">
              <Spinner className="size-5" />
            </div>
          ) : trace ? (
            <div className="max-h-[60vh] space-y-4 overflow-y-auto">
              {trace.messages.user ? (
                <div>
                  <div className="text-muted-foreground mb-1 text-xs font-medium">
                    Question
                  </div>
                  <div className="bg-muted rounded-lg p-3 text-sm whitespace-pre-wrap">
                    {trace.messages.user.content}
                  </div>
                </div>
              ) : null}
              {trace.messages.assistant ? (
                <div>
                  <div className="text-muted-foreground mb-1 flex items-center gap-2 text-xs font-medium">
                    Answer
                    {(trace.messages.assistant.toolCalls ?? []).length > 0 ? (
                      <span className="text-muted-foreground font-normal">
                        · {trace.messages.assistant.toolCalls.length} tool calls
                      </span>
                    ) : null}
                  </div>
                  <div className="border-border rounded-lg border p-3">
                    <DevflowMarkdown content={trace.messages.assistant.content} />
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Review dialog */}
      <Dialog
        open={reviewTarget !== null}
        onOpenChange={(o) => !o && setReviewTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Review feedback</DialogTitle>
            <DialogDescription>
              Resolve or dismiss this negative feedback with an optional note.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="flex gap-2">
              <Button
                size="sm"
                variant={reviewStatus === "resolved" ? "default" : "outline"}
                onClick={() => setReviewStatus("resolved")}
              >
                <CheckCircle2 className="size-3.5" />
                Resolve
              </Button>
              <Button
                size="sm"
                variant={reviewStatus === "dismissed" ? "default" : "outline"}
                onClick={() => setReviewStatus("dismissed")}
              >
                <XCircle className="size-3.5" />
                Dismiss
              </Button>
            </div>
            <Textarea
              rows={3}
              placeholder="Review note (optional)…"
              value={reviewNote}
              onChange={(e) => setReviewNote(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setReviewTarget(null)} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={() => void submitReview()} disabled={submitting}>
              {submitting ? <Spinner className="size-4" /> : null}
              Save review
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
