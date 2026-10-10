"use client";

import { useEffect, useState } from "react";
import { useFormatter, useTranslations, type Messages } from "next-intl";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  Inbox,
  Play,
  RefreshCw,
  ScrollText,
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

type DraftTypeKey = keyof Messages["devflow"]["drafts"]["type"];

interface AuditRow {
  id: string;
  userId: string | null;
  userName: string | null;
  repoId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  status: string;
  createdAt: string;
}

type AuditStatusKey = "statusSuccess" | "statusFailed" | "statusDenied";
const AUDIT_STATUS_KEYS: Record<string, AuditStatusKey | undefined> = {
  success: "statusSuccess",
  failed: "statusFailed",
  denied: "statusDenied",
};

const DRAFT_TYPE_KEYS: Record<string, DraftTypeKey | undefined> = {
  issue_comment: "issueComment",
  create_issue: "createIssue",
  close_issue: "closeIssue",
  add_labels: "addLabels",
  send_report: "sendReport",
} as const;

export default function DevflowDraftsPage() {
  const { repoId } = useDevflow();
  const t = useTranslations("devflow.drafts");
  const tc = useTranslations("common");
  const format = useFormatter();
  const [drafts, setDrafts] = useState<ActionDraft[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState("pending_confirmation");
  const [selected, setSelected] = useState<ActionDraft | null>(null);
  const [acting, setActing] = useState(false);
  const [executeTarget, setExecuteTarget] = useState<ActionDraft | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [auditOpen, setAuditOpen] = useState(false);
  const [audits, setAudits] = useState<AuditRow[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);

  const draftTypeLabel = (draftType: string) => {
    const key = DRAFT_TYPE_KEYS[draftType];
    return key ? t(`type.${key}`) : draftType;
  };

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

  useEffect(() => {
    if (!auditOpen) return;
    let cancelled = false;
    (async () => {
      setAuditLoading(true);
      try {
        const params = new URLSearchParams({ limit: "50" });
        if (repoId) params.set("repoId", repoId);
        const items = await dfGet<AuditRow[]>(`/audit-logs?${params}`);
        if (cancelled) return;
        setAudits(items);
      } catch (e) {
        if (cancelled) return;
        notify.error(e instanceof Error ? e.message : String(e));
        setAudits([]);
      } finally {
        if (!cancelled) setAuditLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [auditOpen, repoId, reloadKey]);

  const act = async (draft: ActionDraft, action: "execute" | "reject") => {
    setActing(true);
    try {
      const result = await dfPatch<{
        status: string;
        errorMessage: string | null;
      }>(`/drafts/${draft.id}`, { action });
      if (action === "execute" && result.status === "failed") {
        notify.error(
          t("executionFailed", {
            message: result.errorMessage ?? tc("unknownError"),
          }),
        );
      } else if (action === "execute") {
        notify.success(t("executedOnGithub"));
      } else {
        notify.success(t("draftRejected"));
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
      notify.success(t("draftDeleted"));
      setReloadKey((k) => k + 1);
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-6">
      <PageHeader
        title={t("title")}
        description={t("description")}
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

      <Tabs value={statusFilter} onValueChange={setStatusFilter}>
        <TabsList>
          <TabsTrigger value="pending_confirmation">
            {t("tabPending")}
          </TabsTrigger>
          <TabsTrigger value="executed">{t("tabExecuted")}</TabsTrigger>
          <TabsTrigger value="rejected">{t("tabRejected")}</TabsTrigger>
          <TabsTrigger value="failed">{t("tabFailed")}</TabsTrigger>
          <TabsTrigger value="all">{t("tabAll")}</TabsTrigger>
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
                <p className="text-muted-foreground text-sm">{t("empty")}</p>
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
                    {draftTypeLabel(draft.draftType)}
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
                    t("emptyDraft")}
                </p>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  {draft.repoFullName} ·{" "}
                  {format.dateTime(new Date(draft.createdAt), "medium")}
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
                  {t("selectPrompt")}
                </p>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="space-y-4 pt-5">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">
                    {draftTypeLabel(selected.draftType)}
                  </Badge>
                  {selected.targetNumber ? (
                    <Badge variant="secondary">
                      {selected.targetType === "pull_request"
                        ? t("targetPr")
                        : t("targetIssue")}{" "}
                      #{selected.targetNumber}
                    </Badge>
                  ) : null}
                  {selected.labels.length > 0 ? (
                    <Badge variant="secondary">
                      {t("labels", { labels: selected.labels.join(", ") })}
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
                      {t("executeOnGithub")}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => void act(selected, "reject")}
                      disabled={acting}
                    >
                      <XCircle />
                      {t("reject")}
                    </Button>
                    <Button
                      variant="ghost"
                      className="text-muted-foreground hover:text-destructive ml-auto"
                      onClick={() => void remove(selected)}
                    >
                      <Trash2 />
                      {tc("delete")}
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 pt-2">
                    {selected.status === "executed" ? (
                      <span className="text-muted-foreground inline-flex items-center gap-1.5 text-sm">
                        <CheckCircle2 className="size-4 text-emerald-500" />
                        {t("executedAt", {
                          date: format.dateTime(
                            new Date(selected.updatedAt),
                            "medium",
                          ),
                        })}
                      </span>
                    ) : null}
                    <Button
                      variant="ghost"
                      className="text-muted-foreground hover:text-destructive ml-auto"
                      onClick={() => void remove(selected)}
                    >
                      <Trash2 />
                      {tc("delete")}
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <Card>
        <CardContent className="pt-5">
          <button
            onClick={() => setAuditOpen((open) => !open)}
            className="hover:bg-accent/50 flex w-full items-center gap-2 rounded-md text-left"
          >
            {auditOpen ? (
              <ChevronDown className="text-muted-foreground size-4" />
            ) : (
              <ChevronRight className="text-muted-foreground size-4" />
            )}
            <ScrollText className="text-muted-foreground size-4" />
            <span className="text-foreground text-sm font-medium">
              {t("audit.title")}
            </span>
            <span className="text-muted-foreground ml-auto text-xs">
              {auditLoading ? "\u2026" : audits.length}
            </span>
          </button>
          {auditOpen ? (
            <>
              <Separator className="my-3" />
              {auditLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <Skeleton key={i} className="h-8 rounded-md" />
                  ))}
                </div>
              ) : audits.length === 0 ? (
                <p className="text-muted-foreground py-2 text-sm">
                  {t("audit.empty")}
                </p>
              ) : (
                <ul className="max-h-64 space-y-1 overflow-y-auto">
                  {audits.map((row) => {
                    const statusKey = AUDIT_STATUS_KEYS[row.status];
                    return (
                      <li
                        key={row.id}
                        className="hover:bg-accent/40 flex flex-wrap items-center gap-2 rounded-md px-2 py-1.5 text-xs"
                      >
                        <span className="text-foreground font-mono">
                          {row.action}
                        </span>
                        <Badge
                          variant={
                            row.status === "success"
                              ? "secondary"
                              : row.status === "failed"
                                ? "destructive"
                                : "outline"
                          }
                        >
                          {statusKey ? t(`audit.${statusKey}`) : row.status}
                        </Badge>
                        {row.targetId ? (
                          <span className="text-muted-foreground max-w-40 truncate font-mono">
                            {row.targetType ?? ""}#{row.targetId.slice(0, 8)}
                          </span>
                        ) : null}
                        <span className="text-muted-foreground ml-auto">
                          {row.userName ?? row.repoId?.slice(0, 8) ?? "—"} ·{" "}
                          {format.dateTime(new Date(row.createdAt), "medium")}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          ) : null}
        </CardContent>
      </Card>

      <AlertDialog
        open={executeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setExecuteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("confirmTitle", {
                type: draftTypeLabel(executeTarget?.draftType ?? ""),
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {executeTarget?.targetNumber
                ? t("confirmDescriptionTarget", {
                    repo: executeTarget.repoFullName,
                    number: executeTarget.targetNumber,
                  })
                : t("confirmDescriptionPlain", {
                    repo: executeTarget?.repoFullName ?? "",
                  })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tc("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                executeTarget && void act(executeTarget, "execute")
              }
            >
              {t("execute")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
