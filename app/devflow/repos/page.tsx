"use client";

// Repositories: connect GitHub repos, sync data, inspect sync health, delete.
import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import {
  CalendarClock,
  FolderGit2,
  HardDrive,
  KeyRound,
  Plus,
  RefreshCw,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { notify } from "@/components/devflow/notify";
import PageHeader from "@/components/devflow/page-header";
import { dfDelete, dfPost, useDevflow } from "@/components/devflow/provider";
import type { RepoSummary } from "@/lib/devflow/types";

type ReposTranslations = ReturnType<typeof useTranslations<"devflow.repos">>;

// The lead-owned RepoSummary (lib/devflow/types.ts) has not picked up the
// checkout columns yet; the /repos API already returns them, so this page
// reads them through a local extension (RepoSummary is assignable to it).
type RepoRow = RepoSummary & {
  checkoutMode?: string;
  localPath?: string | null;
  cloneParentDir?: string | null;
};

// Module-level (called during render): Date.now() is impure, so the React
// Compiler rejects it inside the component body.
function timeAgo(t: ReposTranslations, iso: string | null): string {
  if (!iso) return t("never");
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return t("justNow");
  if (minutes < 60) return t("minutesAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("hoursAgo", { count: hours });
  return t("daysAgo", { count: Math.floor(hours / 24) });
}

function ConnectDialog({
  open,
  onOpenChange,
  onConnected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: () => Promise<void>;
}) {
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  // legacy repos.py:157-175 — connect either a GitHub repo or a local git
  // working tree (checkout_mode="local", browsed read-only, never cloned).
  const [mode, setMode] = useState<"github" | "local">("github");
  const [localPath, setLocalPath] = useState("");
  const [cloneParentDir, setCloneParentDir] = useState("");
  const [provider, setProvider] = useState<"github" | "github_compatible">(
    "github",
  );
  const [apiBaseUrl, setApiBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [connecting, setConnecting] = useState(false);
  const t = useTranslations("devflow.repos");
  const tc = useTranslations("common");

  const connect = async () => {
    if (mode === "local" && !localPath.trim()) {
      notify.error(t("connect.localPathRequired"));
      return;
    }
    if (mode === "github" && (!owner.trim() || !repo.trim())) {
      notify.error(t("connect.ownerRepoRequired"));
      return;
    }
    setConnecting(true);
    try {
      const result = await dfPost<{
        repoId: string;
        fullName: string;
        syncError: string | null;
        note?: string | null;
      }>("/repos", {
        ...(mode === "local"
          ? { localPath: localPath.trim() }
          : {
              owner: owner.trim(),
              repo: repo.trim(),
              provider,
              ...(provider === "github_compatible" && apiBaseUrl.trim()
                ? { apiBaseUrl: apiBaseUrl.trim() }
                : {}),
              ...(cloneParentDir.trim()
                ? { cloneParentDir: cloneParentDir.trim() }
                : {}),
            }),
        ...(token.trim() ? { token: token.trim() } : {}),
      });
      notify.success(t("connect.connected", { repo: result.fullName }));
      if (result.note) {
        // Raw server diagnostic (local-mode metadata degraded to git-derived).
        notify.info(result.note);
      }
      if (result.syncError) {
        notify.error(
          t("connect.initialSyncFailed", { error: result.syncError }),
        );
      }
      onOpenChange(false);
      setOwner("");
      setRepo("");
      setLocalPath("");
      setCloneParentDir("");
      setToken("");
      await onConnected();
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("connect.title")}</DialogTitle>
          <DialogDescription>{t("connect.description")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Field>
            <FieldLabel>{t("connect.mode")}</FieldLabel>
            <Select
              value={mode}
              onValueChange={(v) => setMode(v as "github" | "local")}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="github">
                  {t("connect.modeGithub")}
                </SelectItem>
                <SelectItem value="local">{t("connect.modeLocal")}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {mode === "local" ? (
            <Field>
              <FieldLabel htmlFor="df-local-path">
                {t("connect.localPath")}
              </FieldLabel>
              <FieldDescription>{t("connect.localHint")}</FieldDescription>
              <Input
                id="df-local-path"
                placeholder={t("connect.localPathPlaceholder")}
                value={localPath}
                onChange={(e) => setLocalPath(e.target.value)}
              />
            </Field>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Field>
                  <FieldLabel htmlFor="df-owner">
                    {t("connect.owner")}
                  </FieldLabel>
                  <Input
                    id="df-owner"
                    placeholder={t("connect.ownerPlaceholder")}
                    value={owner}
                    onChange={(e) => setOwner(e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="df-repo">
                    {t("connect.repository")}
                  </FieldLabel>
                  <Input
                    id="df-repo"
                    placeholder={t("connect.repositoryPlaceholder")}
                    value={repo}
                    onChange={(e) => setRepo(e.target.value)}
                  />
                </Field>
              </div>
              <Field>
                <FieldLabel>{t("connect.provider")}</FieldLabel>
                <Select
                  value={provider}
                  onValueChange={(v) =>
                    setProvider(v as "github" | "github_compatible")
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="github">
                      {t("connect.providerGithub")}
                    </SelectItem>
                    <SelectItem value="github_compatible">
                      {t("connect.providerCompatible")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              {provider === "github_compatible" ? (
                <Field>
                  <FieldLabel htmlFor="df-base">
                    {t("connect.apiBaseUrl")}
                  </FieldLabel>
                  <Input
                    id="df-base"
                    placeholder={t("connect.apiBaseUrlPlaceholder")}
                    value={apiBaseUrl}
                    onChange={(e) => setApiBaseUrl(e.target.value)}
                  />
                </Field>
              ) : null}
              <Field>
                <FieldLabel htmlFor="df-clone-parent">
                  {t("connect.cloneParentDir")}{" "}
                  <span className="text-muted-foreground">
                    {t("connect.optional")}
                  </span>
                </FieldLabel>
                <FieldDescription>
                  {t("connect.cloneParentDirHint")}
                </FieldDescription>
                <Input
                  id="df-clone-parent"
                  placeholder={t("connect.cloneParentDirPlaceholder")}
                  value={cloneParentDir}
                  onChange={(e) => setCloneParentDir(e.target.value)}
                />
              </Field>
            </>
          )}
          <Field>
            <FieldLabel htmlFor="df-token">
              {t("connect.accessToken")}{" "}
              <span className="text-muted-foreground">
                {t("connect.optional")}
              </span>
            </FieldLabel>
            <FieldDescription>{t("connect.tokenDescription")}</FieldDescription>
            <Input
              id="df-token"
              type="password"
              placeholder={t("connect.tokenPlaceholder")}
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {tc("cancel")}
          </Button>
          <Button onClick={connect} disabled={connecting}>
            {connecting ? <RefreshCw className="animate-spin" /> : <Plus />}
            {connecting ? t("connect.connecting") : t("connect.connect")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function DevflowReposPage() {
  const { repos, reposLoading, refreshRepos, repoId, setRepoId } = useDevflow();
  const t = useTranslations("devflow.repos");
  const tc = useTranslations("common");
  const [connectOpen, setConnectOpen] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RepoSummary | null>(null);

  const sync = useCallback(
    async (repo: RepoSummary) => {
      setSyncingId(repo.id);
      try {
        const result = await dfPost<{
          synced: {
            issues: number;
            pullRequests: number;
            workflowRuns: number;
          };
        }>(`/repos/${repo.id}/sync`, { limit: 30 });
        notify.success(
          t("synced", {
            repo: repo.fullName,
            issues: result.synced.issues,
            prs: result.synced.pullRequests,
            runs: result.synced.workflowRuns,
          }),
        );
        await refreshRepos();
      } catch (e) {
        notify.error(e instanceof Error ? e.message : String(e));
      } finally {
        setSyncingId(null);
      }
    },
    [refreshRepos, t],
  );

  const remove = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      await dfDelete(`/repos/${deleteTarget.id}`);
      notify.success(t("deleted", { repo: deleteTarget.fullName }));
      setDeleteTarget(null);
      await refreshRepos();
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    }
  }, [deleteTarget, refreshRepos, t]);

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <Button onClick={() => setConnectOpen(true)}>
            <Plus />
            {t("connectRepository")}
          </Button>
        }
      />

      {reposLoading ? (
        <div className="grid gap-4 md:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-44 rounded-xl" />
          ))}
        </div>
      ) : repos.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
            <FolderGit2 className="text-muted-foreground size-8" />
            <p className="text-foreground font-medium">{t("noRepos")}</p>
            <p className="text-muted-foreground max-w-sm text-sm">
              {t("noReposDescription")}
            </p>
            <Button onClick={() => setConnectOpen(true)}>
              <Plus />
              {t("connectRepository")}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {repos.map((rawRepo) => {
            const repo: RepoRow = rawRepo;
            return (
              <Card
                key={repo.id}
                className={
                  repo.id === repoId
                    ? "border-primary/50 ring-primary/20 ring-1"
                    : ""
                }
              >
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <CardTitle className="truncate text-base">
                        {repo.fullName}
                      </CardTitle>
                      {repo.description ? (
                        <p className="text-muted-foreground mt-1 line-clamp-2 text-xs">
                          {repo.description}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {repo.checkoutMode === "local" ? (
                        <Badge variant="outline">
                          <HardDrive className="size-3" />
                          {t("localBadge")}
                        </Badge>
                      ) : null}
                      {repo.hasToken ? (
                        <Badge variant="outline">
                          <KeyRound className="size-3" />
                          {t("token")}
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex flex-wrap gap-1.5 text-xs">
                    <Badge variant="secondary">
                      {t("issuesCount", { count: repo.counts.issues })}
                    </Badge>
                    <Badge variant="secondary">
                      {t("prsCount", { count: repo.counts.pullRequests })}
                    </Badge>
                    <Badge variant="secondary">
                      {t("runsCount", { count: repo.counts.workflowRuns })}
                    </Badge>
                    <Badge variant="secondary">
                      {t("docsCount", {
                        count: repo.counts.knowledgeDocuments,
                      })}
                    </Badge>
                  </div>
                  <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
                    <CalendarClock className="size-3.5" />
                    {t("lastSync", { time: timeAgo(t, repo.lastSyncAt) })}
                    {repo.lastSyncError ? (
                      <span
                        className="text-destructive ml-1 max-w-48 truncate"
                        title={repo.lastSyncError}
                      >
                        · {repo.lastSyncError}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2 pt-1">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void sync(repo)}
                      disabled={syncingId !== null}
                    >
                      <RefreshCw
                        className={syncingId === repo.id ? "animate-spin" : ""}
                      />
                      {syncingId === repo.id ? t("syncing") : t("sync")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setRepoId(repo.id)}
                      disabled={repo.id === repoId}
                    >
                      {repo.id === repoId ? t("selected") : t("select")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive ml-auto"
                      onClick={() => setDeleteTarget(repo)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <ConnectDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        onConnected={refreshRepos}
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
              {t("delete.title", { repo: deleteTarget?.fullName ?? "" })}
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
