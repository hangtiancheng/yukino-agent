import { prisma } from "@/lib/db";
import { decryptToken } from "./crypto";
import { sanitizeCiLog } from "./sanitize";
import { rebuildGraph } from "./knowledge-graph";
import {
  getJobLogs,
  getRepo,
  listIssues,
  listPullRequestFiles,
  listPullRequestReviewComments,
  listPullRequests,
  listWorkflowRunJobs,
  listWorkflowRuns,
  GitHubApiError,
  type GitHubContext,
} from "./github";

export interface SyncOptions {
  syncIssues?: boolean;
  syncPulls?: boolean;
  syncRuns?: boolean;
  limit?: number;
}

export interface SyncResult {
  issues: number;
  pullRequests: number;
  workflowRuns: number;
}

const LOG_HEAD_CHARS = 20_000;
const LOG_TAIL_CHARS = 20_000;
const MAX_FAILED_JOB_LOGS = 3;

function ghDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function loginOf(user: unknown): string | null {
  if (user && typeof user === "object" && "login" in user) {
    const login = (user as { login?: unknown }).login;
    if (typeof login === "string" && login) return login;
  }
  return null;
}

function truncateLog(text: string): string {
  if (text.length <= LOG_HEAD_CHARS + LOG_TAIL_CHARS) return text;
  return (
    text.slice(0, LOG_HEAD_CHARS) +
    "\n...[truncated]...\n" +
    text.slice(-LOG_TAIL_CHARS)
  );
}

type SyncedJobStep = {
  name?: string;
  status?: string;
  conclusion?: string;
  number?: number;
};
type SyncedJob = {
  id?: number;
  name?: string;
  status?: string;
  conclusion?: string;
  html_url?: string;
  started_at?: string;
  completed_at?: string;
  steps: SyncedJobStep[];
};

function contextFor(repo: {
  tokenEncrypted: string | null;
  apiBaseUrl: string | null;
}): GitHubContext {
  return {
    token: decryptToken(repo.tokenEncrypted),
    baseUrl: repo.apiBaseUrl,
  };
}

export async function syncRepository(
  repoId: string,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const repo = await prisma.repository.findUnique({ where: { id: repoId } });
  if (!repo) throw new Error(`Repository ${repoId} not found`);
  if (repo.provider !== "github" && repo.provider !== "github_compatible") {
    throw new Error(`${repo.provider} sync is not implemented yet`);
  }

  const ctx = contextFor(repo);
  const limit = Math.min(Math.max(options.limit ?? 30, 1), 100);
  const synced: SyncResult = { issues: 0, pullRequests: 0, workflowRuns: 0 };
  const errors: string[] = [];

  if (options.syncIssues !== false) {
    try {
      const remote = await listIssues(repo.owner, repo.name, ctx, limit);
      for (const item of remote) {
        const githubIssueId = BigInt(item.id);
        await prisma.issue.upsert({
          where: {
            repoId_githubIssueId: { repoId, githubIssueId },
          },
          create: {
            repoId,
            githubIssueId,
            number: item.number ?? 0,
            title: item.title ?? "",
            body: item.body ?? null,
            state: item.state ?? "open",
            labels: labelsOf(item.labels),
            author: loginOf(item.user),
            assignees: (item.assignees ?? [])
              .map(loginOf)
              .filter((v: string | null): v is string => Boolean(v)),
            githubCreatedAt: ghDate(item.created_at),
            githubUpdatedAt: ghDate(item.updated_at),
            githubClosedAt: ghDate(item.closed_at),
          },
          update: {
            number: item.number ?? 0,
            title: item.title ?? "",
            body: item.body ?? null,
            state: item.state ?? "open",
            labels: labelsOf(item.labels),
            author: loginOf(item.user),
            assignees: (item.assignees ?? [])
              .map(loginOf)
              .filter((v: string | null): v is string => Boolean(v)),
            githubCreatedAt: ghDate(item.created_at),
            githubUpdatedAt: ghDate(item.updated_at),
            githubClosedAt: ghDate(item.closed_at),
          },
        });
        synced.issues += 1;
      }
    } catch (e) {
      errors.push(`issues: ${describeError(e)}`);
    }
  }

  if (options.syncPulls !== false) {
    try {
      const remote = await listPullRequests(repo.owner, repo.name, ctx, limit);
      for (const item of remote) {
        const githubPrId = BigInt(item.id);
        const pr = await prisma.pullRequest.upsert({
          where: { repoId_githubPrId: { repoId, githubPrId } },
          create: {
            repoId,
            githubPrId,
            number: item.number ?? 0,
            title: item.title ?? "",
          },
          update: { number: item.number ?? 0 },
        });
        await prisma.pullRequest.update({
          where: { id: pr.id },
          data: {
            title: item.title ?? "",
            body: item.body ?? null,
            state: item.merged_at ? "merged" : (item.state ?? "open"),
            author: loginOf(item.user),
            baseBranch: item.base?.ref ?? null,
            headBranch: item.head?.ref ?? null,
            additions: item.additions ?? 0,
            deletions: item.deletions ?? 0,
            changedFiles: item.changed_files ?? 0,
            mergedAt: ghDate(item.merged_at),
            githubCreatedAt: ghDate(item.created_at),
            githubUpdatedAt: ghDate(item.updated_at),
          },
        });

        try {
          const files = await listPullRequestFiles(
            repo.owner,
            repo.name,
            item.number,
            ctx,
          );
          await prisma.prFile.deleteMany({ where: { prId: pr.id } });
          if (files.length > 0) {
            await prisma.prFile.createMany({
              data: files.map((f) => ({
                prId: pr.id,
                filename: String(f.filename ?? ""),
                status: String(f.status ?? "modified"),
                additions: Number(f.additions ?? 0),
                deletions: Number(f.deletions ?? 0),
                patch: f.patch != null ? String(f.patch) : null,
              })),
            });
          }
        } catch {}
        try {
          const comments = await listPullRequestReviewComments(
            repo.owner,
            repo.name,
            item.number,
            ctx,
          );
          await prisma.prReviewComment.deleteMany({ where: { prId: pr.id } });
          if (comments.length > 0) {
            await prisma.prReviewComment.createMany({
              data: comments.map((c) => ({
                prId: pr.id,
                githubCommentId: c.id != null ? BigInt(c.id) : null,
                body: c.body != null ? String(c.body) : null,
                path: c.path != null ? String(c.path) : null,
                line: c.line != null ? Number(c.line) : null,
                originalLine:
                  c.original_line != null ? Number(c.original_line) : null,
                author: loginOf(c.user),
                githubCreatedAt: ghDate(c.created_at),
              })),
            });
          }
        } catch {}
        synced.pullRequests += 1;
      }
    } catch (e) {
      errors.push(`pull requests: ${describeError(e)}`);
    }
  }

  if (options.syncRuns !== false) {
    try {
      const remote = await listWorkflowRuns(repo.owner, repo.name, ctx, limit);
      for (const item of remote) {
        const githubRunId = BigInt(item.id);
        const run = await prisma.workflowRun.upsert({
          where: { repoId_githubRunId: { repoId, githubRunId } },
          create: {
            repoId,
            githubRunId,
            name: item.name ?? "workflow",
          },
          update: {},
        });

        let jobs: SyncedJob[] = [];
        try {
          const remoteJobs = await listWorkflowRunJobs(
            repo.owner,
            repo.name,
            Number(githubRunId),
            ctx,
          );
          jobs = remoteJobs.map((job) => ({
            id: job.id != null ? Number(job.id) : undefined,
            name: job.name != null ? String(job.name) : undefined,
            status: job.status != null ? String(job.status) : undefined,
            conclusion:
              job.conclusion != null ? String(job.conclusion) : undefined,
            html_url: job.html_url != null ? String(job.html_url) : undefined,
            started_at:
              job.started_at != null ? String(job.started_at) : undefined,
            completed_at:
              job.completed_at != null ? String(job.completed_at) : undefined,
            steps: (job.steps ?? []).map((step) => ({
              name: step.name ?? undefined,
              status: step.status ?? undefined,
              conclusion: step.conclusion ?? undefined,
              number: step.number ?? undefined,
            })),
          }));
        } catch {
          jobs = [];
        }

        let logsText: string | null = null;
        if (item.conclusion === "failure") {
          const failedJobs = jobs.filter((job) => job.conclusion === "failure");
          const parts: string[] = [];
          for (const job of failedJobs.slice(0, MAX_FAILED_JOB_LOGS)) {
            try {
              const text = await getJobLogs(
                repo.owner,
                repo.name,
                Number(job.id),
                ctx,
              );
              parts.push(
                `### Job: ${String(job.name ?? job.id)}\n${truncateLog(sanitizeCiLog(text))}`,
              );
            } catch {}
          }
          logsText = parts.length > 0 ? parts.join("\n\n") : null;
        }

        await prisma.workflowRun.update({
          where: { id: run.id },
          data: {
            name: item.name ?? run.name,
            headBranch: item.head_branch ?? null,
            status: item.status ?? "unknown",
            conclusion: item.conclusion ?? null,
            htmlUrl: item.html_url ?? null,
            jobs,
            ...(logsText !== null ? { logsText } : {}),
            githubCreatedAt: ghDate(item.created_at),
            githubUpdatedAt: ghDate(item.updated_at),
          },
        });
        synced.workflowRuns += 1;
      }
    } catch (e) {
      errors.push(`workflow runs: ${describeError(e)}`);
    }
  }

  await prisma.repository.update({
    where: { id: repoId },
    data: {
      lastSyncAt: new Date(),
      lastSyncError: errors.length > 0 ? errors.join("; ") : null,
    },
  });

  if (
    errors.length > 0 &&
    synced.issues + synced.pullRequests + synced.workflowRuns === 0
  ) {
    throw new Error(`GitHub sync failed — ${errors.join("; ")}`);
  }
  void rebuildGraph(repoId).catch((e) =>
    console.error(
      "[sync] knowledge graph rebuild failed:",
      e instanceof Error ? e.message : e,
    ),
  );
  return synced;
}

function labelsOf(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((label) =>
      label && typeof label === "object" && "name" in label
        ? String((label as { name?: unknown }).name ?? "")
        : String(label ?? ""),
    )
    .filter((name) => name !== "");
}

function describeError(e: unknown): string {
  if (e instanceof GitHubApiError)
    return `GitHub API ${e.status}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

export function repoMilvusCleanupPrefixes(repoId: string): string[] {
  return [
    `devflow:kb:${repoId}:`,
    `devflow:project:${repoId}:`,
    `devflow:item:${repoId}:`,
  ];
}

export async function fetchRepoMeta(
  owner: string,
  name: string,
  ctx: GitHubContext = {},
): Promise<{
  githubId: bigint;
  description: string | null;
  defaultBranch: string | null;
  cloneUrl: string | null;
}> {
  const meta = await getRepo(owner, name, ctx);
  return {
    githubId: BigInt(meta.id),
    description: meta.description != null ? String(meta.description) : null,
    defaultBranch:
      meta.default_branch != null ? String(meta.default_branch) : null,
    cloneUrl: meta.clone_url != null ? String(meta.clone_url) : null,
  };
}
