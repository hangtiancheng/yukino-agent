// GitHub REST client (fetch-based). Replaces the Python httpx client and the
// per-resource helper modules (issues / pull_requests / actions).
import { config } from "@/lib/config";

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

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function getRepo(
  owner: string,
  repo: string,
  ctx: GitHubContext = {},
): Promise<any> {
  return ghFetch(`/repos/${owner}/${repo}`, ctx);
}

// The issues endpoint also returns pull requests; filter them out.
export async function listIssues(
  owner: string,
  repo: string,
  ctx: GitHubContext = {},
  limit = 50,
): Promise<any[]> {
  const items = (await ghFetch(`/repos/${owner}/${repo}/issues`, ctx, {
    params: { state: "all", per_page: Math.min(limit, 100), sort: "updated" },
  })) as any[];
  return items.filter((item) => !item?.pull_request);
}

export async function listPullRequests(
  owner: string,
  repo: string,
  ctx: GitHubContext = {},
  limit = 50,
): Promise<any[]> {
  return (await ghFetch(`/repos/${owner}/${repo}/pulls`, ctx, {
    params: { state: "all", per_page: Math.min(limit, 100), sort: "updated" },
  })) as any[];
}

export async function listPullRequestFiles(
  owner: string,
  repo: string,
  prNumber: number,
  ctx: GitHubContext = {},
): Promise<any[]> {
  return (await ghFetch(
    `/repos/${owner}/${repo}/pulls/${prNumber}/files`,
    ctx,
    {
      params: { per_page: 100 },
    },
  )) as any[];
}

export async function listPullRequestReviewComments(
  owner: string,
  repo: string,
  prNumber: number,
  ctx: GitHubContext = {},
): Promise<any[]> {
  return (await ghFetch(
    `/repos/${owner}/${repo}/pulls/${prNumber}/comments`,
    ctx,
    { params: { per_page: 100 } },
  )) as any[];
}

export async function listWorkflowRuns(
  owner: string,
  repo: string,
  ctx: GitHubContext = {},
  limit = 30,
): Promise<any[]> {
  const data = (await ghFetch(`/repos/${owner}/${repo}/actions/runs`, ctx, {
    params: { per_page: Math.min(limit, 100) },
  })) as { workflow_runs?: any[] };
  return data.workflow_runs ?? [];
}

export async function listWorkflowRunJobs(
  owner: string,
  repo: string,
  runId: number,
  ctx: GitHubContext = {},
): Promise<any[]> {
  const data = (await ghFetch(
    `/repos/${owner}/${repo}/actions/runs/${runId}/jobs`,
    ctx,
    { params: { per_page: 100 } },
  )) as { jobs?: any[] };
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
// ---------------------------------------------------------------------------

export async function createIssueComment(
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
  ctx: GitHubContext = {},
): Promise<any> {
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
): Promise<any> {
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
): Promise<any> {
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
): Promise<any> {
  return ghFetch(`/repos/${owner}/${repo}/issues/${issueNumber}/labels`, ctx, {
    method: "POST",
    body: JSON.stringify({ labels }),
  });
}
