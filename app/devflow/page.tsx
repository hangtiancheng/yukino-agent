"use client";

// DevFlow dashboard: workspace health at a glance plus recent activity.
import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
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

// API state values → typed keys under devflow.badges; unmapped states fall
// back to the raw string.
const ISSUE_STATE_KEYS: Record<string, "open" | "closed" | undefined> = {
  open: "open",
  closed: "closed",
} as const;

const PR_STATE_KEYS: Record<string, "open" | "closed" | "merged" | undefined> =
  {
    open: "open",
    closed: "closed",
    merged: "merged",
  } as const;

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
    <Card className="group/stat shadow-soft hover:shadow-lift transition-all duration-200 hover:-translate-y-0.5">
      <CardContent className="flex items-center gap-3.5 pt-5 pb-5">
        <div className="from-primary/12 to-chart-2/20 text-primary ring-primary/10 flex size-10 shrink-0 items-center justify-center rounded-xl bg-linear-to-br ring-1 transition-transform duration-200 group-hover/stat:scale-105">
          <Icon className="size-5" />
        </div>
        <div className="min-w-0">
          <div className="text-foreground text-2xl leading-none font-semibold tabular-nums">
            {value}
          </div>
          <div className="text-muted-foreground mt-1.5 truncate text-xs">
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
  const t = useTranslations("devflow.dashboard");
  const tb = useTranslations("devflow.badges");
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
        t("synced", {
          issues: result.synced.issues,
          prs: result.synced.pullRequests,
          runs: result.synced.workflowRuns,
        }),
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
        <PageHeader title={t("title")} description={t("descriptionEmpty")} />
        <Empty className="border-border rounded-xl border border-dashed py-16">
          <EmptyMedia variant="icon">
            <FolderGit2 />
          </EmptyMedia>
          <EmptyTitle>{t("noReposTitle")}</EmptyTitle>
          <EmptyDescription>{t("noReposDescription")}</EmptyDescription>
          <EmptyContent>
            <Link href="/devflow/repos">
              <Button>
                <Sparkles className="size-4" />
                {t("connectFirst")}
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
        title={t("title")}
        description={
          repo
            ? t("descriptionRepo", { repo: repo.fullName })
            : t("descriptionAll")
        }
        actions={
          <Button
            onClick={handleSync}
            disabled={syncing || !repoId}
            variant="outline"
          >
            <RefreshCw className={syncing ? "animate-spin" : ""} />
            {t("syncNow")}
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
              label={t("openIssues")}
              value={stats.openIssues}
              hint={t("closedCount", { count: stats.closedIssues })}
              href="/devflow/issues"
            />
            <StatCard
              icon={GitPullRequest}
              label={t("openPrs")}
              value={stats.openPrs}
              hint={t("mergedCount", { count: stats.mergedPrs })}
              href="/devflow/pulls"
            />
            <StatCard
              icon={Activity}
              label={t("failedRuns")}
              value={stats.failedRuns}
              hint={t("totalCount", { count: stats.totalRuns })}
              href="/devflow/ci"
            />
            <StatCard
              icon={BookOpen}
              label={t("knowledgeDocs")}
              value={stats.knowledgeDocs}
              href="/devflow/knowledge"
            />
            <StatCard
              icon={ClipboardCheck}
              label={t("pendingDrafts")}
              value={stats.pendingDrafts}
              href="/devflow/drafts"
            />
            <StatCard
              icon={Sparkles}
              label={t("aiAnalyses")}
              value={stats.analyses}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="shadow-soft">
              <CardHeader className="py-3">
                <CardTitle className="text-sm">{t("recentIssues")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {stats.recentIssues.length === 0 ? (
                  <p className="text-muted-foreground text-sm italic">
                    {t("noIssues")}
                  </p>
                ) : (
                  stats.recentIssues.map((issue) => {
                    const stateKey = ISSUE_STATE_KEYS[issue.state];
                    return (
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
                            className="ml-auto shrink-0"
                          >
                            {stateKey
                              ? tb(`issueState.${stateKey}`)
                              : issue.state}
                          </Badge>
                        </div>
                      </Link>
                    );
                  })
                )}
              </CardContent>
            </Card>
            <Card className="shadow-soft">
              <CardHeader className="py-3">
                <CardTitle className="text-sm">{t("recentPrs")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {stats.recentPrs.length === 0 ? (
                  <p className="text-muted-foreground text-sm italic">
                    {t("noPrs")}
                  </p>
                ) : (
                  stats.recentPrs.map((pr) => {
                    const stateKey = PR_STATE_KEYS[pr.state];
                    return (
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
                            className="ml-auto shrink-0"
                          >
                            {stateKey ? tb(`prState.${stateKey}`) : pr.state}
                          </Badge>
                        </div>
                      </Link>
                    );
                  })
                )}
              </CardContent>
            </Card>
            <Card className="shadow-soft">
              <CardHeader className="py-3">
                <CardTitle className="text-sm">{t("failedRuns")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {stats.recentFailedRuns.length === 0 ? (
                  <p className="text-muted-foreground text-sm italic">
                    {t("noFailedRuns")}
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
