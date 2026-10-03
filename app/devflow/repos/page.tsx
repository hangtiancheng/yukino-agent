"use client";

// Repositories: connect GitHub repos, sync data, inspect sync health, delete.
import { useCallback, useState } from "react";
import {
  CalendarClock,
  FolderGit2,
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

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
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
  const [provider, setProvider] = useState<"github" | "github_compatible">(
    "github",
  );
  const [apiBaseUrl, setApiBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [connecting, setConnecting] = useState(false);

  const connect = async () => {
    if (!owner.trim() || !repo.trim()) {
      notify.error("Owner and repository name are required.");
      return;
    }
    setConnecting(true);
    try {
      const result = await dfPost<{
        repoId: string;
        fullName: string;
        syncError: string | null;
      }>("/repos", {
        owner: owner.trim(),
        repo: repo.trim(),
        provider,
        ...(provider === "github_compatible" && apiBaseUrl.trim()
          ? { apiBaseUrl: apiBaseUrl.trim() }
          : {}),
        ...(token.trim() ? { token: token.trim() } : {}),
      });
      notify.success(`Connected ${result.fullName}`);
      if (result.syncError) {
        notify.error(`Initial sync failed: ${result.syncError}`);
      }
      onOpenChange(false);
      setOwner("");
      setRepo("");
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
          <DialogTitle>Connect a repository</DialogTitle>
          <DialogDescription>
            DevFlow verifies the repository through the GitHub API, then runs an
            initial sync of issues, pull requests and CI runs.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="df-owner">Owner</FieldLabel>
              <Input
                id="df-owner"
                placeholder="e.g. vercel"
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="df-repo">Repository</FieldLabel>
              <Input
                id="df-repo"
                placeholder="e.g. ai"
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
              />
            </Field>
          </div>
          <Field>
            <FieldLabel>Provider</FieldLabel>
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
                <SelectItem value="github">GitHub</SelectItem>
                <SelectItem value="github_compatible">
                  GitHub-compatible API (Enterprise / Gitea)
                </SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {provider === "github_compatible" ? (
            <Field>
              <FieldLabel htmlFor="df-base">API base URL</FieldLabel>
              <Input
                id="df-base"
                placeholder="https://git.example.com/api/v3"
                value={apiBaseUrl}
                onChange={(e) => setApiBaseUrl(e.target.value)}
              />
            </Field>
          ) : null}
          <Field>
            <FieldLabel htmlFor="df-token">
              Personal access token{" "}
              <span className="text-muted-foreground">(optional)</span>
            </FieldLabel>
            <FieldDescription>
              Stored encrypted. Required for private repos; raises rate limits
              for public ones.
            </FieldDescription>
            <Input
              id="df-token"
              type="password"
              placeholder="ghp_…"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={connect} disabled={connecting}>
            {connecting ? <RefreshCw className="animate-spin" /> : <Plus />}
            {connecting ? "Connecting…" : "Connect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function DevflowReposPage() {
  const { repos, reposLoading, refreshRepos, repoId, setRepoId } = useDevflow();
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
          `${repo.fullName}: synced ${result.synced.issues} issues, ${result.synced.pullRequests} PRs, ${result.synced.workflowRuns} runs`,
        );
        await refreshRepos();
      } catch (e) {
        notify.error(e instanceof Error ? e.message : String(e));
      } finally {
        setSyncingId(null);
      }
    },
    [refreshRepos],
  );

  const remove = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      await dfDelete(`/repos/${deleteTarget.id}`);
      notify.success(`Deleted ${deleteTarget.fullName}`);
      setDeleteTarget(null);
      await refreshRepos();
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    }
  }, [deleteTarget, refreshRepos]);

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <PageHeader
        title="Repositories"
        description="Connected GitHub repositories and their sync state. Sync pulls issues, pull requests, review comments and CI logs."
        actions={
          <Button onClick={() => setConnectOpen(true)}>
            <Plus />
            Connect repository
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
            <p className="text-foreground font-medium">No repositories yet</p>
            <p className="text-muted-foreground max-w-sm text-sm">
              Connect a repository to start analyzing its issues, pull requests
              and CI runs with AI.
            </p>
            <Button onClick={() => setConnectOpen(true)}>
              <Plus />
              Connect repository
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {repos.map((repo) => (
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
                  {repo.hasToken ? (
                    <Badge variant="outline">
                      <KeyRound className="size-3" />
                      token
                    </Badge>
                  ) : null}
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-1.5 text-xs">
                  <Badge variant="secondary">{repo.counts.issues} issues</Badge>
                  <Badge variant="secondary">
                    {repo.counts.pullRequests} PRs
                  </Badge>
                  <Badge variant="secondary">
                    {repo.counts.workflowRuns} runs
                  </Badge>
                  <Badge variant="secondary">
                    {repo.counts.knowledgeDocuments} docs
                  </Badge>
                </div>
                <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
                  <CalendarClock className="size-3.5" />
                  Last sync: {timeAgo(repo.lastSyncAt)}
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
                    {syncingId === repo.id ? "Syncing…" : "Sync"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setRepoId(repo.id)}
                    disabled={repo.id === repoId}
                  >
                    {repo.id === repoId ? "Selected" : "Select"}
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
          ))}
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
              Delete {deleteTarget?.fullName}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This removes the repository along with its synced issues, pull
              requests, CI runs, knowledge documents and action drafts. The
              GitHub repository itself is not touched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void remove()}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
