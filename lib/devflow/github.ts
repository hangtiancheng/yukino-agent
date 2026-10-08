// GitHub REST client (fetch-based). Replaces the Python httpx client and the
// per-resource helper modules (issues / pull_requests / actions).
//
// Read-path responses are validated at this boundary with the zod schemas in
// ./schemas.ts — loose objects, so fields DevFlow does not consume survive
// untouched while everything sync.ts reads is statically typed. Write-path
// responses are returned as `unknown` on purpose: they are only summarized
// into the draft audit trail, and a validation failure must never mask a
// write that already succeeded on GitHub's side.
import { z } from "zod/v4";
import { config } from "@/lib/config";
import {
  GitHubIssueSchema,
  GitHubPullRequestFileSchema,
  GitHubPullRequestSchema,
  GitHubRepoSchema,
  GitHubReviewCommentSchema,
  GitHubWorkflowJobsResponseSchema,
  GitHubWorkflowRunsResponseSchema,
  type GitHubIssue,
  type GitHubPullRequest,
  type GitHubPullRequestFile,
  type GitHubRepo,
  type GitHubReviewComment,
  type GitHubWorkflowJob,
  type GitHubWorkflowRun,
} from "./schemas";

export interface GitHubContext {
  token?: string | null;
  baseUrl?: string | null;
}

export class GitHubApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

function resolveBaseUrl(ctx: GitHubContext): string {
  return (ctx.baseUrl || config.github.apiBaseUrl).replace(/\/+$/, "");
}

function resolveToken(ctx: GitHubContext): string {
  return ctx.token || config.github.token;
}

async function ghFetch(
  path: string,
  ctx: GitHubContext,
  init?: RequestInit & { params?: Record<string, string | number | undefined> },
): Promise<unknown> {
  const url = new URL(`${resolveBaseUrl(ctx)}${path}`);
  if (init?.params) {
    for (const [key, value] of Object.entries(init.params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "yukino-devflow",
  };
  const token = resolveToken(ctx);
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init?.body) headers["Content-Type"] = "application/json";

  const response = await fetch(url, {
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string>) },
    redirect: "follow",
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new GitHubApiError(
      response.status,
      `GitHub API ${response.status} for ${path}: ${text.slice(0, 400)}`,
    );
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) return response.json();
  return response.text();
}

// Validates one decoded GitHub response against its schema. Throws with the
// offending path so sync.ts's per-section error capture stays informative.
function parseResponse<T>(
  schema: z.ZodType<T>,
  payload: unknown,
  what: string,
): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `Unexpected GitHub API response for ${what}: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

export async function getRepo(
  owner: string,
  repo: string,
  ctx: GitHubContext = {},
): Promise<GitHubRepo> {
  const path = `/repos/${owner}/${repo}`;
  return parseResponse(
    GitHubRepoSchema,
    await ghFetch(path, ctx),
    `GET ${path}`,
  );
}

// The issues endpoint also returns pull requests; filter them out.
export async function listIssues(
  owner: string,
  repo: string,
  ctx: GitHubContext = {},
  limit = 50,
): Promise<GitHubIssue[]> {
  const path = `/repos/${owner}/${repo}/issues`;
  const items = parseResponse(
    z.array(GitHubIssueSchema),
    await ghFetch(path, ctx, {
      params: { state: "all", per_page: Math.min(limit, 100), sort: "updated" },
    }),
    `GET ${path}`,
  );
  return items.filter((item) => !item.pull_request);
}

export async function listPullRequests(
  owner: string,
  repo: string,
  ctx: GitHubContext = {},
  limit = 50,
): Promise<GitHubPullRequest[]> {
  const path = `/repos/${owner}/${repo}/pulls`;
  return parseResponse(
    z.array(GitHubPullRequestSchema),
    await ghFetch(path, ctx, {
      params: { state: "all", per_page: Math.min(limit, 100), sort: "updated" },
    }),
    `GET ${path}`,
  );
}

export async function listPullRequestFiles(
  owner: string,
  repo: string,
  prNumber: number,
  ctx: GitHubContext = {},
): Promise<GitHubPullRequestFile[]> {
  const path = `/repos/${owner}/${repo}/pulls/${prNumber}/files`;
  return parseResponse(
    z.array(GitHubPullRequestFileSchema),
    await ghFetch(path, ctx, { params: { per_page: 100 } }),
    `GET ${path}`,
  );
}

export async function listPullRequestReviewComments(
  owner: string,
  repo: string,
  prNumber: number,
  ctx: GitHubContext = {},
): Promise<GitHubReviewComment[]> {
  const path = `/repos/${owner}/${repo}/pulls/${prNumber}/comments`;
  return parseResponse(
    z.array(GitHubReviewCommentSchema),
    await ghFetch(path, ctx, { params: { per_page: 100 } }),
    `GET ${path}`,
  );
}

export async function listWorkflowRuns(
  owner: string,
  repo: string,
  ctx: GitHubContext = {},
  limit = 30,
): Promise<GitHubWorkflowRun[]> {
  const path = `/repos/${owner}/${repo}/actions/runs`;
  const data = parseResponse(
    GitHubWorkflowRunsResponseSchema,
    await ghFetch(path, ctx, { params: { per_page: Math.min(limit, 100) } }),
    `GET ${path}`,
  );
  return data.workflow_runs ?? [];
}

export async function listWorkflowRunJobs(
  owner: string,
  repo: string,
  runId: number,
  ctx: GitHubContext = {},
): Promise<GitHubWorkflowJob[]> {
  const path = `/repos/${owner}/${repo}/actions/runs/${runId}/jobs`;
  const data = parseResponse(
    GitHubWorkflowJobsResponseSchema,
    await ghFetch(path, ctx, { params: { per_page: 100 } }),
    `GET ${path}`,
  );
  return data.jobs ?? [];
}

// Plain-text log for a single job (the endpoint redirects to blob storage).
export async function getJobLogs(
  owner: string,
  repo: string,
  jobId: number,
  ctx: GitHubContext = {},
): Promise<string> {
  const text = await ghFetch(
    `/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`,
    ctx,
  );
  return typeof text === "string" ? text : JSON.stringify(text);
}

// ---------------------------------------------------------------------------
// Write actions — only used after a human confirms an action draft.
// Responses are deliberately `unknown` (see file header).
// ---------------------------------------------------------------------------

export async function createIssueComment(
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
  ctx: GitHubContext = {},
): Promise<unknown> {
  return ghFetch(
    `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    ctx,
    {
      method: "POST",
      body: JSON.stringify({ body }),
    },
  );
}

export async function createIssue(
  owner: string,
  repo: string,
  title: string,
  body: string,
  ctx: GitHubContext = {},
): Promise<unknown> {
  return ghFetch(`/repos/${owner}/${repo}/issues`, ctx, {
    method: "POST",
    body: JSON.stringify({ title, body }),
  });
}

export async function closeIssue(
  owner: string,
  repo: string,
  issueNumber: number,
  ctx: GitHubContext = {},
): Promise<unknown> {
  return ghFetch(`/repos/${owner}/${repo}/issues/${issueNumber}`, ctx, {
    method: "PATCH",
    body: JSON.stringify({ state: "closed" }),
  });
}

export async function addIssueLabels(
  owner: string,
  repo: string,
  issueNumber: number,
  labels: string[],
  ctx: GitHubContext = {},
): Promise<unknown> {
  return ghFetch(`/repos/${owner}/${repo}/issues/${issueNumber}/labels`, ctx, {
    method: "POST",
    body: JSON.stringify({ labels }),
  });
}
