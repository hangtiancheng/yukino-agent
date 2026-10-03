"use client";

// Action Drafts: the human confirmation gate for every GitHub write. Agents
// only ever create drafts; executing one performs the real API call.
import { useEffect, useState } from "react";
import {
  CheckCircle2,
  ClipboardCheck,
  Inbox,
  Play,
  RefreshCw,
  Trash2,
  XCircle,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { notify } from "@/components/devflow/notify";
import PageHeader from "@/components/devflow/page-header";
import DevflowMarkdown from "@/components/devflow/markdown";
import { DraftStatusBadge, RiskBadge } from "@/components/devflow/badges";
import {
  dfDelete,
  dfGet,
  dfPatch,
  useDevflow,
} from "@/components/devflow/provider";
import type { ActionDraft } from "@/lib/devflow/types";

const DRAFT_TYPE_LABELS: Record<string, string> = {
  issue_comment: "Comment",
  create_issue: "New issue",
  close_issue: "Close issue",
  add_labels: "Add labels",
};

export default function DevflowDraftsPage() {
  const { repoId } = useDevflow();
  const [drafts, setDrafts] = useState<ActionDraft[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState("pending_confirmation");
  const [selected, setSelected] = useState<ActionDraft | null>(null);
  const [acting, setActing] = useState(false);
  const [executeTarget, setExecuteTarget] = useState<ActionDraft | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Fetch lives in an inline async IIFE — see the note in provider.tsx
  // (react-hooks/set-state-in-effect). Manual reloads bump reloadKey.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (repoId) params.set("repoId", repoId);
        if (statusFilter !== "all") params.set("status", statusFilter);
        const items = await dfGet<ActionDraft[]>(
          `/drafts?${params.toString()}`,
        );
        if (cancelled) return;
        setDrafts(items);
        setSelected((current) => {
          if (current && items.some((d) => d.id === current.id)) return current;
          return items[0] ?? null;
        });
      } catch (e) {
        if (cancelled) return;
        notify.error(e instanceof Error ? e.message : String(e));
        setDrafts([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoId, statusFilter, reloadKey]);

  const act = async (draft: ActionDraft, action: "execute" | "reject") => {
    setActing(true);
    try {
      const result = await dfPatch<{
        status: string;
        errorMessage: string | null;
      }>(`/drafts/${draft.id}`, { action });
      if (action === "execute" && result.status === "failed") {
        notify.error(
          `Execution failed: ${result.errorMessage ?? "unknown error"}`,
        );
      } else if (action === "execute") {
        notify.success("Draft executed on GitHub");
      } else {
        notify.success("Draft rejected");
      }
      setExecuteTarget(null);
      setReloadKey((k) => k + 1);
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setActing(false);
    }
  };

  const remove = async (draft: ActionDraft) => {
    try {
      await dfDelete(`/drafts/${draft.id}`);
      notify.success("Draft deleted");
      setReloadKey((k) => k + 1);
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-6">
      <PageHeader
        title="Action Drafts"
        description="Every GitHub write proposed by AI lands here as a draft. Review the content, then execute or reject — nothing is posted without your confirmation."
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

      <Tabs value={statusFilter} onValueChange={setStatusFilter}>
        <TabsList>
          <TabsTrigger value="pending_confirmation">Pending</TabsTrigger>
          <TabsTrigger value="executed">Executed</TabsTrigger>
          <TabsTrigger value="rejected">Rejected</TabsTrigger>
          <TabsTrigger value="failed">Failed</TabsTrigger>
          <TabsTrigger value="all">All</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[380px_1fr]">
        <div className="min-h-0 space-y-2 overflow-y-auto pr-1">
          {loading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-20 rounded-xl" />
            ))
          ) : drafts.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
                <Inbox className="text-muted-foreground size-7" />
                <p className="text-muted-foreground text-sm">
                  No drafts in this view.
                </p>
              </CardContent>
            </Card>
          ) : (
            drafts.map((draft) => (
              <button
                key={draft.id}
                onClick={() => setSelected(draft)}
                className={`w-full rounded-xl border px-4 py-3 text-left transition-colors ${
                  selected?.id === draft.id
                    ? "border-primary/50 bg-primary/5"
                    : "border-border hover:bg-accent/50"
                }`}
              >
                <div className="flex items-center gap-2">
                  <Badge variant="outline">
                    {DRAFT_TYPE_LABELS[draft.draftType] ?? draft.draftType}
                  </Badge>
                  {draft.targetNumber ? (
                    <span className="text-muted-foreground font-mono text-xs">
                      #{draft.targetNumber}
                    </span>
                  ) : null}
                  <DraftStatusBadge status={draft.status} />
                </div>
                <p className="text-foreground mt-1.5 line-clamp-1 text-sm font-medium">
                  {draft.title ||
                    draft.content?.slice(0, 80) ||
                    "(empty draft)"}
                </p>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  {draft.repoFullName} ·{" "}
                  {new Date(draft.createdAt).toLocaleString()}
                </p>
              </button>
            ))
          )}
        </div>

        <div className="min-h-0 overflow-y-auto pr-1">
          {!selected ? (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center gap-2 py-16 text-center">
                <ClipboardCheck className="text-muted-foreground size-8" />
                <p className="text-muted-foreground text-sm">
                  Select a draft to review its content.
                </p>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="space-y-4 pt-5">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">
                    {DRAFT_TYPE_LABELS[selected.draftType] ??
                      selected.draftType}
                  </Badge>
                  {selected.targetNumber ? (
                    <Badge variant="secondary">
                      {selected.targetType === "pull_request" ? "PR" : "Issue"}{" "}
                      #{selected.targetNumber}
                    </Badge>
                  ) : null}
                  {selected.labels.length > 0 ? (
                    <Badge variant="secondary">
                      labels: {selected.labels.join(", ")}
                    </Badge>
                  ) : null}
                  <RiskBadge level={selected.riskLevel} />
                  <DraftStatusBadge status={selected.status} />
                </div>

                {selected.title ? (
                  <h2 className="text-foreground text-lg font-semibold">
                    {selected.title}
                  </h2>
                ) : null}
                {selected.content ? (
                  <>
                    <Separator />
                    <DevflowMarkdown content={selected.content} />
                  </>
                ) : null}

                {selected.errorMessage ? (
                  <p className="text-destructive bg-destructive/5 rounded-md px-3 py-2 text-sm">
                    {selected.errorMessage}
                  </p>
                ) : null}
                {selected.executionResult ? (
                  <pre className="bg-muted/50 text-foreground overflow-x-auto rounded-md p-3 text-xs">
                    {JSON.stringify(selected.executionResult, null, 2)}
                  </pre>
                ) : null}

                {selected.status === "pending_confirmation" ? (
                  <div className="flex flex-wrap gap-2 pt-2">
                    <Button
                      onClick={() => setExecuteTarget(selected)}
                      disabled={acting}
                    >
                      <Play />
                      Execute on GitHub
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => void act(selected, "reject")}
                      disabled={acting}
                    >
                      <XCircle />
                      Reject
                    </Button>
                    <Button
                      variant="ghost"
                      className="text-muted-foreground hover:text-destructive ml-auto"
                      onClick={() => void remove(selected)}
                    >
                      <Trash2 />
                      Delete
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 pt-2">
                    {selected.status === "executed" ? (
                      <span className="text-muted-foreground inline-flex items-center gap-1.5 text-sm">
                        <CheckCircle2 className="size-4 text-emerald-500" />
                        Executed {new Date(selected.updatedAt).toLocaleString()}
                      </span>
                    ) : null}
                    <Button
                      variant="ghost"
                      className="text-muted-foreground hover:text-destructive ml-auto"
                      onClick={() => void remove(selected)}
                    >
                      <Trash2 />
                      Delete
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <AlertDialog
        open={executeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setExecuteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Execute this{" "}
              {DRAFT_TYPE_LABELS[
                executeTarget?.draftType ?? ""
              ]?.toLowerCase() ?? "action"}
              ?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This performs a real write against {executeTarget?.repoFullName}
              {executeTarget?.targetNumber
                ? ` on #${executeTarget.targetNumber}`
                : ""}
              . This cannot be undone from DevFlow.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                executeTarget && void act(executeTarget, "execute")
              }
            >
              Execute
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
