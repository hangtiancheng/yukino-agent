"use client";

// DevFlow dashboard: workspace health at a glance plus recent activity.
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Activity,
  BookOpen,
  CircleDot,
  ClipboardCheck,
  FolderGit2,
  GitPullRequest,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import PageHeader from "@/components/devflow/page-header";
import { dfGet, dfPost, useDevflow } from "@/components/devflow/provider";
import { notify } from "@/components/devflow/notify";
import type { DevflowStats } from "@/lib/devflow/types";

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  href,
}: {
  icon: typeof CircleDot;
  label: string;
  value: number;
  hint?: string;
  href?: string;
}) {
  const body = (
    <Card className="hover:bg-accent/40 transition-colors">
      <CardContent className="flex items-center gap-3 pt-5">
        <div className="bg-primary/10 text-primary flex size-10 shrink-0 items-center justify-center rounded-lg">
          <Icon className="size-5" />
        </div>
        <div className="min-w-0">
          <div className="text-foreground text-2xl leading-none font-semibold tabular-nums">
            {value}
          </div>
          <div className="text-muted-foreground mt-1 truncate text-xs">
            {label}
            {hint ? <span className="ml-1 opacity-70">· {hint}</span> : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

export default function DevflowDashboard() {
  const { repoId, repo, repos, reposLoading, refreshRepos } = useDevflow();
  const [stats, setStats] = useState<DevflowStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // Fetch lives in an inline async IIFE — see the note in provider.tsx
  // (react-hooks/set-state-in-effect).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const data = await dfGet<DevflowStats>(
          repoId ? `/stats?repoId=${repoId}` : "/stats",
        );
        if (!cancelled) setStats(data);
      } catch {
        if (!cancelled) setStats(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoId, reloadKey]);

  const handleSync = async () => {
    if (!repoId) return;
    setSyncing(true);
    try {
      const result = await dfPost<{
        synced: { issues: number; pullRequests: number; workflowRuns: number };
      }>(`/repos/${repoId}/sync`, { limit: 30 });
      notify.success(
        `Synced ${result.synced.issues} issues, ${result.synced.pullRequests} PRs, ${result.synced.workflowRuns} runs`,
      );
      await refreshRepos();
      setReloadKey((k) => k + 1);
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  };

  if (!reposLoading && repos.length === 0) {
    return (
      <div className="mx-auto max-w-5xl space-y-6 p-6">
        <PageHeader
          title="Dashboard"
          description="Connect a GitHub repository to unlock AI triage, PR review, CI debugging and a per-repo knowledge base."
        />
        <Empty className="border-border rounded-xl border border-dashed py-16">
          <EmptyMedia variant="icon">
            <FolderGit2 />
          </EmptyMedia>
          <EmptyTitle>No repositories connected</EmptyTitle>
          <EmptyDescription>
            DevFlow analyzes issues, pull requests and CI runs from your GitHub
            repositories.
          </EmptyDescription>
          <EmptyContent>
            <Link href="/devflow/repos">
              <Button>
                <Sparkles className="size-4" />
                Connect your first repository
              </Button>
            </Link>
          </EmptyContent>
        </Empty>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <PageHeader
        title="Dashboard"
        description={
          repo
            ? `Workspace health for ${repo.fullName}`
            : "Workspace health across all repositories"
        }
        actions={
          <Button
            onClick={handleSync}
            disabled={syncing || !repoId}
            variant="outline"
          >
            <RefreshCw className={syncing ? "animate-spin" : ""} />
            Sync now
          </Button>
        }
      />

      {loading || !stats ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              icon={CircleDot}
              label="Open issues"
              value={stats.openIssues}
              hint={`${stats.closedIssues} closed`}
              href="/devflow/issues"
            />
            <StatCard
              icon={GitPullRequest}
              label="Open pull requests"
              value={stats.openPrs}
              hint={`${stats.mergedPrs} merged`}
              href="/devflow/pulls"
            />
            <StatCard
              icon={Activity}
              label="Failed CI runs"
              value={stats.failedRuns}
              hint={`${stats.totalRuns} total`}
              href="/devflow/ci"
            />
            <StatCard
              icon={BookOpen}
              label="Knowledge docs"
              value={stats.knowledgeDocs}
              href="/devflow/knowledge"
            />
            <StatCard
              icon={ClipboardCheck}
              label="Pending drafts"
              value={stats.pendingDrafts}
              href="/devflow/drafts"
            />
            <StatCard
              icon={Sparkles}
              label="AI analyses run"
              value={stats.analyses}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader className="py-3">
                <CardTitle className="text-sm">
                  Recently updated issues
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {stats.recentIssues.length === 0 ? (
                  <p className="text-muted-foreground text-sm italic">
                    No issues synced yet.
                  </p>
                ) : (
                  stats.recentIssues.map((issue) => (
                    <Link
                      key={issue.id}
                      href="/devflow/issues"
                      className="hover:bg-accent/50 block rounded-md px-2 py-1.5 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-muted-foreground shrink-0 font-mono text-xs">
                          #{issue.number}
                        </span>
                        <span className="text-foreground truncate text-sm">
                          {issue.title}
                        </span>
                        <Badge
                          variant={
                            issue.state === "open" ? "default" : "secondary"
                          }
                          className="ml-auto shrink-0 capitalize"
                        >
                          {issue.state}
                        </Badge>
                      </div>
                    </Link>
                  ))
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="py-3">
                <CardTitle className="text-sm">Recently updated PRs</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {stats.recentPrs.length === 0 ? (
                  <p className="text-muted-foreground text-sm italic">
                    No pull requests synced yet.
                  </p>
                ) : (
                  stats.recentPrs.map((pr) => (
                    <Link
                      key={pr.id}
                      href="/devflow/pulls"
                      className="hover:bg-accent/50 block rounded-md px-2 py-1.5 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-muted-foreground shrink-0 font-mono text-xs">
                          #{pr.number}
                        </span>
                        <span className="text-foreground truncate text-sm">
                          {pr.title}
                        </span>
                        <Badge
                          variant="secondary"
                          className="ml-auto shrink-0 capitalize"
                        >
                          {pr.state}
                        </Badge>
                      </div>
                    </Link>
                  ))
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="py-3">
                <CardTitle className="text-sm">Failed CI runs</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {stats.recentFailedRuns.length === 0 ? (
                  <p className="text-muted-foreground text-sm italic">
                    No failed runs. 🎉
                  </p>
                ) : (
                  stats.recentFailedRuns.map((run) => (
                    <Link
                      key={run.id}
                      href="/devflow/ci"
                      className="hover:bg-accent/50 block rounded-md px-2 py-1.5 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-foreground truncate text-sm">
                          {run.name}
                        </span>
                        {run.headBranch ? (
                          <Badge
                            variant="outline"
                            className="ml-auto shrink-0 font-mono text-xs"
                          >
                            {run.headBranch}
                          </Badge>
                        ) : null}
                      </div>
                    </Link>
                  ))
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
