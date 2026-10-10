"use client";

import { useEffect, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import {
  Boxes,
  CalendarRange,
  FileText,
  Plus,
  Sparkles,
  Trash2,
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
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
import PageHeader from "@/components/devflow/page-header";
import DevflowMarkdown from "@/components/devflow/markdown";
import {
  dfDelete,
  dfGet,
  dfPost,
  useDevflow,
} from "@/components/devflow/provider";

interface WorkspaceRepoCount {
  repoId: string;
  fullName: string | null;
  issues: number;
  pullRequests: number;
  workflowRuns: number;
}

interface WorkspaceListItem {
  id: string;
  name: string;
  description: string | null;
  repoIds: string[];
  createdAt: string;
  updatedAt: string;
  repos: WorkspaceRepoCount[];
}

interface RepoAggregate {
  repoId: string;
  fullName: string | null;
  issues: number;
  openIssues: number;
  pullRequests: number;
  openPrs: number;
  mergedPrs: number;
  runs: number;
  failedRuns: number;
  knowledgeDocs: number;
}

interface WorkspaceTotals {
  repos: number;
  issues: number;
  openIssues: number;
  pullRequests: number;
  openPrs: number;
  mergedPrs: number;
  runs: number;
  failedRuns: number;
  knowledgeDocs: number;
}

interface WorkspaceDetail {
  workspace: Omit<WorkspaceListItem, "repos">;
  stats: {
    workspaceId: string;
    repos: RepoAggregate[];
    totals: WorkspaceTotals;
  };
}

type WorkspaceRiskLevel = "P0" | "P1" | "P2";

interface RiskItem {
  repoId: string;
  fullName: string | null;
  level: WorkspaceRiskLevel;
  reasons: string[];
}

interface MultiRepoReport {
  workspaceId: string;
  workspaceName: string;
  startDate: string;
  endDate: string;
  reportMarkdown: string;
  metrics: {
    repos: number;
    rangeIssues: number;
    rangePrs: number;
    rangeRuns: number;
    openIssues: number;
    openPrs: number;
    mergedPrs: number;
    failedCi: number;
    staleOpenPrs: number;
  };
  repoSummaries: unknown[];
  riskItems: RiskItem[];
  generationMode: "llm" | "deterministic";
  repoReportsTriggered: string[];
}

function isoDaysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="space-y-1 py-4">
        <div className="text-muted-foreground text-xs">{label}</div>
        <div className="text-foreground text-2xl font-semibold">{value}</div>
      </CardContent>
    </Card>
  );
}

function CreateWorkspaceDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => Promise<void>;
}) {
  const { repos } = useDevflow();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selectedRepoIds, setSelectedRepoIds] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const t = useTranslations("devflow.workspaces");
  const tc = useTranslations("common");

  const toggleRepo = (repoId: string, checked: boolean) => {
    setSelectedRepoIds((current) =>
      checked ? [...current, repoId] : current.filter((id) => id !== repoId),
    );
  };

  const create = async () => {
    if (!name.trim()) {
      notify.error(t("dialog.nameRequired"));
      return;
    }
    setCreating(true);
    try {
      const workspace = await dfPost<WorkspaceListItem>("/workspaces", {
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        repoIds: selectedRepoIds,
      });
      notify.success(t("created", { name: workspace.name }));
      onOpenChange(false);
      setName("");
      setDescription("");
      setSelectedRepoIds([]);
      await onCreated(workspace.id);
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("dialog.title")}</DialogTitle>
          <DialogDescription>{t("dialog.description")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Field>
            <FieldLabel htmlFor="ws-name">{t("dialog.name")}</FieldLabel>
            <Input
              id="ws-name"
              placeholder={t("dialog.namePlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="ws-description">
              {t("dialog.descriptionField")}{" "}
              <span className="text-muted-foreground">
                ({t("dialog.optional")})
              </span>
            </FieldLabel>
            <Textarea
              id="ws-description"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <div className="space-y-2">
            <FieldLabel>{t("dialog.repos")}</FieldLabel>
            {repos.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                {t("dialog.noRepos")}
              </p>
            ) : (
              <div className="border-input max-h-56 space-y-1 overflow-auto rounded-md border p-2">
                {repos.map((repo) => (
                  <label
                    key={repo.id}
                    className="hover:bg-accent flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm"
                  >
                    <Checkbox
                      checked={selectedRepoIds.includes(repo.id)}
                      onCheckedChange={(checked) =>
                        toggleRepo(repo.id, checked === true)
                      }
                    />
                    {repo.fullName}
                  </label>
                ))}
              </div>
            )}
            <p className="text-muted-foreground text-xs">
              {t("dialog.repoCount", { count: selectedRepoIds.length })}
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {tc("cancel")}
          </Button>
          <Button onClick={() => void create()} disabled={creating}>
            {creating ? <Sparkles className="animate-pulse" /> : <Plus />}
            {creating ? t("dialog.creating") : t("dialog.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function DevflowWorkspacesPage() {
  const t = useTranslations("devflow.workspaces");
  const tc = useTranslations("common");
  const format = useFormatter();
  const [workspaces, setWorkspaces] = useState<WorkspaceListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<WorkspaceDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailReloadKey, setDetailReloadKey] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceListItem | null>(
    null,
  );
  const [startDate, setStartDate] = useState(isoDaysAgo(7));
  const [endDate, setEndDate] = useState(isoDaysAgo(0));
  const [report, setReport] = useState<MultiRepoReport | null>(null);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const items = await dfGet<WorkspaceListItem[]>("/workspaces");
        if (cancelled) return;
        setWorkspaces(items);
        setSelectedId((current) =>
          items.some((item) => item.id === current)
            ? current
            : (items[0]?.id ?? ""),
        );
      } catch {
        if (!cancelled) setWorkspaces([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!selectedId) {
        setDetail(null);
        return;
      }
      setDetailLoading(true);
      try {
        const data = await dfGet<WorkspaceDetail>(`/workspaces/${selectedId}`);
        if (cancelled) return;
        setDetail(data);
      } catch (e) {
        if (cancelled) return;
        setDetail(null);
        notify.error(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId, detailReloadKey]);

  const selectWorkspace = (id: string) => {
    setSelectedId(id);
    setReport(null);
  };

  const remove = async () => {
    if (!deleteTarget) return;
    try {
      await dfDelete(`/workspaces/${deleteTarget.id}`);
      notify.success(t("deleted", { name: deleteTarget.name }));
      const next = workspaces.filter((item) => item.id !== deleteTarget.id);
      setWorkspaces(next);
      if (selectedId === deleteTarget.id) {
        selectWorkspace(next[0]?.id ?? "");
      }
      setDeleteTarget(null);
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    }
  };

  const generate = async () => {
    if (!selectedId) return;
    if (startDate > endDate) {
      notify.error(t("invalidRange"));
      return;
    }
    setGenerating(true);
    setReport(null);
    try {
      const result = await dfPost<MultiRepoReport>(
        `/workspaces/${selectedId}/report`,
        { startDate, endDate },
      );
      setReport(result);
      notify.success(t("generated"));
      setTimeout(() => setDetailReloadKey((key) => key + 1), 3_000);
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  };

  const totals = detail ? detail.stats.totals : null;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus />
            {t("create")}
          </Button>
        }
      />

      {loading ? (
        <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
          <Skeleton className="h-72 rounded-xl" />
          <Skeleton className="h-72 rounded-xl" />
        </div>
      ) : workspaces.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-14">
            <Empty>
              <EmptyMedia>
                <Boxes />
              </EmptyMedia>
              <EmptyTitle>{t("empty")}</EmptyTitle>
              <EmptyDescription>{t("emptyDescription")}</EmptyDescription>
            </Empty>
          </CardContent>
        </Card>
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-[320px_1fr]">
          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-sm">{t("list")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {workspaces.map((item) => (
                <div
                  key={item.id}
                  className={`relative rounded-lg border ${
                    item.id === selectedId
                      ? "border-primary/50 ring-primary/20 ring-1"
                      : ""
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => selectWorkspace(item.id)}
                    className="hover:bg-accent/50 w-full rounded-lg p-3 pr-9 text-left transition-colors"
                  >
                    <div className="text-foreground truncate text-sm font-medium">
                      {item.name}
                    </div>
                    {item.description ? (
                      <p className="text-muted-foreground mt-1 line-clamp-2 text-xs">
                        {item.description}
                      </p>
                    ) : null}
                    <div className="text-muted-foreground mt-1.5 flex items-center justify-between text-xs">
                      <span>
                        {t("repoCount", { count: item.repoIds.length })}
                      </span>
                      <span>
                        {format.dateTime(new Date(item.updatedAt), "short")}
                      </span>
                    </div>
                  </button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="text-muted-foreground hover:text-destructive absolute top-1.5 right-1.5 size-7"
                    onClick={() => setDeleteTarget(item)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>

          <div className="space-y-4">
            {detailLoading || !detail || !totals ? (
              <div className="space-y-3">
                <Skeleton className="h-24 rounded-xl" />
                <Skeleton className="h-48 rounded-xl" />
              </div>
            ) : (
              <>
                <Card>
                  <CardHeader className="py-3">
                    <CardTitle className="flex items-center gap-2 text-sm">
                      <Boxes className="text-muted-foreground size-4" />
                      {detail.workspace.name}
                      <span className="text-muted-foreground font-normal">
                        {t("updatedOn", {
                          time: format.dateTime(
                            new Date(detail.workspace.updatedAt),
                            "medium",
                          ),
                        })}
                      </span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                      <StatCard label={t("statRepos")} value={totals.repos} />
                      <StatCard label={t("statIssues")} value={totals.issues} />
                      <StatCard
                        label={t("statOpenIssues")}
                        value={totals.openIssues}
                      />
                      <StatCard
                        label={t("statPrs")}
                        value={totals.pullRequests}
                      />
                      <StatCard
                        label={t("statOpenPrs")}
                        value={totals.openPrs}
                      />
                      <StatCard
                        label={t("statMerged")}
                        value={totals.mergedPrs}
                      />
                      <StatCard label={t("statRuns")} value={totals.runs} />
                      <StatCard
                        label={t("statFailedRuns")}
                        value={totals.failedRuns}
                      />
                      <StatCard
                        label={t("statDocs")}
                        value={totals.knowledgeDocs}
                      />
                    </div>

                    {detail.stats.repos.length > 0 ? (
                      <div className="mt-4 rounded-lg border">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>{t("colRepo")}</TableHead>
                              <TableHead className="text-right">
                                {t("colIssues")}
                              </TableHead>
                              <TableHead className="text-right">
                                {t("colPrs")}
                              </TableHead>
                              <TableHead className="text-right">
                                {t("colRuns")}
                              </TableHead>
                              <TableHead className="text-right">
                                {t("colDocs")}
                              </TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {detail.stats.repos.map((row) => (
                              <TableRow key={row.repoId}>
                                <TableCell className="font-medium">
                                  {row.fullName ?? (
                                    <span className="text-destructive">
                                      {t("repoMissing")}
                                    </span>
                                  )}
                                </TableCell>
                                <TableCell className="text-right">
                                  {row.issues} ({row.openIssues} {t("open")})
                                </TableCell>
                                <TableCell className="text-right">
                                  {row.pullRequests} ({row.openPrs} {t("open")}
                                  {" / "}
                                  {row.mergedPrs} {t("merged")})
                                </TableCell>
                                <TableCell className="text-right">
                                  {row.runs} ({row.failedRuns} {t("failed")})
                                </TableCell>
                                <TableCell className="text-right">
                                  {row.knowledgeDocs}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    ) : null}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="py-3">
                    <CardTitle className="flex items-center gap-2 text-sm">
                      <FileText className="text-muted-foreground size-4" />
                      {t("reportTitle")}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="flex flex-wrap items-end gap-4">
                      <div className="space-y-1.5">
                        <FieldLabel htmlFor="ws-start">
                          {t("startDate")}
                        </FieldLabel>
                        <Input
                          id="ws-start"
                          type="date"
                          value={startDate}
                          onChange={(e) => setStartDate(e.target.value)}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <FieldLabel htmlFor="ws-end">{t("endDate")}</FieldLabel>
                        <Input
                          id="ws-end"
                          type="date"
                          value={endDate}
                          onChange={(e) => setEndDate(e.target.value)}
                        />
                      </div>
                      <Button
                        className="ml-auto"
                        onClick={() => void generate()}
                        disabled={generating || !selectedId}
                      >
                        {generating ? (
                          <Sparkles className="animate-pulse" />
                        ) : (
                          <CalendarRange />
                        )}
                        {generating ? t("generating") : t("generateReport")}
                      </Button>
                    </div>

                    {generating ? (
                      <div className="space-y-3">
                        <Skeleton className="h-10 w-2/3 rounded-lg" />
                        <Skeleton className="h-48 rounded-xl" />
                      </div>
                    ) : report ? (
                      <div className="space-y-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge
                            variant={
                              report.riskItems.some(
                                (item) => item.level === "P0",
                              )
                                ? "destructive"
                                : "secondary"
                            }
                          >
                            {t("riskCount", { count: report.riskItems.length })}
                          </Badge>
                          <Badge variant="secondary">
                            {t(`mode.${report.generationMode}`)}
                          </Badge>
                          {report.repoReportsTriggered.length > 0 ? (
                            <Badge variant="outline">
                              {t("savedToKb", {
                                count: report.repoReportsTriggered.length,
                              })}
                            </Badge>
                          ) : null}
                        </div>

                        <div className="space-y-2">
                          <h3 className="text-sm font-medium">
                            {t("riskTitle")}
                          </h3>
                          {report.riskItems.length === 0 ? (
                            <p className="text-muted-foreground text-sm">
                              {t("riskEmpty")}
                            </p>
                          ) : (
                            report.riskItems.map((item) => (
                              <div
                                key={item.repoId}
                                className="flex items-start gap-2 rounded-md border p-2.5"
                              >
                                <Badge
                                  variant={
                                    item.level === "P0"
                                      ? "destructive"
                                      : "secondary"
                                  }
                                >
                                  {item.level}
                                </Badge>
                                <div className="min-w-0 space-y-0.5">
                                  <div className="text-sm font-medium">
                                    {item.fullName ?? t("repoMissing")}
                                  </div>
                                  {item.reasons.map((reason) => (
                                    <p
                                      key={reason}
                                      className="text-muted-foreground text-xs"
                                    >
                                      - {reason}
                                    </p>
                                  ))}
                                </div>
                              </div>
                            ))
                          )}
                        </div>

                        <div className="rounded-lg border p-4">
                          <DevflowMarkdown content={report.reportMarkdown} />
                        </div>
                      </div>
                    ) : (
                      <p className="text-muted-foreground text-sm">
                        {t("noReportDescription")}
                      </p>
                    )}
                  </CardContent>
                </Card>
              </>
            )}
          </div>
        </div>
      )}

      <CreateWorkspaceDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={async (id) => {
          const items = await dfGet<WorkspaceListItem[]>("/workspaces");
          setWorkspaces(items);
          selectWorkspace(id);
        }}
      />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("delete.title", { name: deleteTarget?.name ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("delete.description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tc("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void remove()}>
              {tc("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
