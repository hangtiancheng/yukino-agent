import assert from "node:assert/strict";
import { z } from "zod/v4";
import {
  GitHubIssueSchema,
  GitHubPullRequestFileSchema,
  GitHubPullRequestSchema,
  GitHubRepoSchema,
  GitHubReviewCommentSchema,
  GitHubWorkflowJobSchema,
  GitHubWorkflowJobsResponseSchema,
  GitHubWorkflowRunSchema,
  GitHubWorkflowRunsResponseSchema,
} from "@/lib/devflow/schemas";

{
  const repo = GitHubRepoSchema.parse({
    id: 186853261,
    node_id: "MDEwOlJlcG9zaXRvcnkxODY4NTMyNjE=",
    name: "yukino-agent",
    full_name: "hangtiancheng/yukino-agent",
    private: false,
    description: "AI intelligent OnCall assistant",
    default_branch: "main",
    clone_url: "https://github.com/hangtiancheng/yukino-agent.git",
    html_url: "https://github.com/hangtiancheng/yukino-agent",
    stargazers_count: 42,
  });
  assert.equal(repo.id, 186853261);
  assert.equal(repo.default_branch, "main");
  const passthrough = repo as Record<string, unknown>;
  assert.equal(passthrough.node_id, "MDEwOlJlcG9zaXRvcnkxODY4NTMyNjE=");
  assert.equal(passthrough.stargazers_count, 42);
  assert.throws(() => GitHubRepoSchema.parse({ ...repo, id: "186853261" }));
}

{
  const issue = GitHubIssueSchema.parse({
    id: 2379472020,
    number: 101,
    title: "Login page 500s on empty password",
    body: "Repro: submit the form without a password.\r\n\r\nExpected: 400.",
    state: "open",
    labels: [
      {
        id: 1,
        name: "bug",
        color: "d73a4a",
        description: "Something is broken",
      },
      { id: 2, name: "P1", color: null, description: null },
    ],
    user: { login: "alice", id: 1001, avatar_url: "https://…" },
    assignees: [
      { login: "bob", id: 1002 },
      { login: null, id: null },
    ],
    created_at: "2026-09-30T08:12:00Z",
    updated_at: "2026-10-01T09:00:00Z",
    closed_at: null,
    comments: 3,
  });
  assert.equal(issue.number, 101);
  assert.equal(issue.pull_request, undefined);
  assert.equal(issue.closed_at, null);

  const stringLabels = GitHubIssueSchema.parse({
    id: 1,
    number: 1,
    labels: ["bug", "urgent"],
  });
  assert.deepEqual(stringLabels.labels, ["bug", "urgent"]);

  const prEntry = GitHubIssueSchema.parse({
    id: 2379472999,
    number: 102,
    title: "Fix empty-password handling",
    state: "open",
    pull_request: {
      url: "https://api.github.com/repos/o/r/pulls/102",
      html_url: "https://github.com/o/r/pull/102",
      diff_url: "https://github.com/o/r/pull/102.diff",
    },
  });
  assert.ok(prEntry.pull_request);

  const filtered = [issue, prEntry].filter((item) => !item.pull_request);
  assert.equal(filtered.length, 1);

  assert.throws(() => GitHubIssueSchema.parse({ id: 1 }));
}

{
  const pr = GitHubPullRequestSchema.parse({
    id: 2103108997,
    number: 102,
    title: "Fix empty-password handling",
    body: null,
    state: "closed",
    merged_at: null,
    closed_at: "2026-10-02T10:00:00Z",
    user: { login: "bob", id: 1002 },
    base: { ref: "main", sha: "aaa", label: "o:main" },
    head: { ref: "fix/login-500", sha: "bbb", label: "o:fix/login-500" },
    labels: [],
    additions: 12,
    deletions: 3,
    changed_files: 2,
    created_at: "2026-10-01T10:00:00Z",
    updated_at: "2026-10-02T10:00:00Z",
    draft: false,
  });
  assert.equal(pr.base?.ref, "main");
  assert.equal(pr.merged_at, null);

  const minimal = GitHubPullRequestSchema.parse({ id: 7, number: 7 });
  assert.equal(minimal.base, undefined);
}

{
  const files = z.array(GitHubPullRequestFileSchema).parse([
    {
      sha: "8b3d6c9",
      filename: "app/login.tsx",
      status: "modified",
      additions: 12,
      deletions: 3,
      changes: 15,
      patch: "@@ -1,5 +1,9 @@ …",
      blob_url: "https://…",
    },
    {
      sha: "ff1e2d3",
      filename: "assets/logo.png",
      status: "added",
      additions: 0,
      deletions: 0,
      changes: 0,
    },
  ]);
  assert.equal(files.length, 2);
  assert.equal(files[1].patch, undefined);
}

{
  const comments = z.array(GitHubReviewCommentSchema).parse([
    {
      id: 1234567890,
      body: "Nit: use the shared validator here.",
      path: "app/login.tsx",
      line: 42,
      user: { login: "alice", id: 1001 },
      created_at: "2026-10-01T12:00:00Z",
      updated_at: "2026-10-01T12:00:00Z",
    },
    {
      id: 1234567891,
      body: "Outdated suggestion",
      path: "app/login.tsx",
      line: null,
      original_line: 30,
      user: { login: "carol", id: 1003 },
      created_at: "2026-10-01T13:00:00Z",
    },
  ]);
  assert.equal(comments[1].line, null);
  assert.equal(comments[1].id, 1234567891);
}

{
  const runsResponse = GitHubWorkflowRunsResponseSchema.parse({
    total_count: 2,
    workflow_runs: [
      {
        id: 8860437514,
        name: "CI",
        display_title: "Fix empty-password handling",
        event: "push",
        run_number: 128,
        status: "completed",
        conclusion: "failure",
        head_branch: "main",
        html_url: "https://github.com/o/r/actions/runs/8860437514",
        created_at: "2026-10-02T02:00:00Z",
        updated_at: "2026-10-02T02:11:00Z",
      },
      {
        id: 8860437515,
        name: "CI",
        status: "in_progress",
        conclusion: null,
        head_branch: "dev",
        created_at: "2026-10-02T03:00:00Z",
        updated_at: "2026-10-02T03:01:00Z",
      },
    ],
  });
  assert.equal(runsResponse.workflow_runs?.length, 2);
  assert.equal(runsResponse.workflow_runs?.[1].conclusion, null);

  const empty = GitHubWorkflowRunsResponseSchema.parse({ total_count: 0 });
  assert.deepEqual(empty.workflow_runs ?? [], []);

  assert.throws(() => GitHubWorkflowRunSchema.parse({ name: "CI" }));

  const jobsResponse = GitHubWorkflowJobsResponseSchema.parse({
    total_count: 2,
    jobs: [
      {
        id: 24518889894,
        name: "build",
        status: "completed",
        conclusion: "failure",
        html_url: "https://github.com/o/r/actions/runs/…/job/…",
        started_at: "2026-10-02T02:00:05Z",
        completed_at: "2026-10-02T02:10:59Z",
        steps: [
          {
            name: "Set up job",
            status: "completed",
            conclusion: "success",
            number: 1,
          },
          {
            name: "pnpm build",
            status: "completed",
            conclusion: "failure",
            number: 2,
          },
          {
            name: "Upload logs",
            status: "completed",
            conclusion: "skipped",
            number: 3,
          },
        ],
      },
      {
        id: 24518889895,
        name: "lint",
        status: "in_progress",
        conclusion: null,
        started_at: "2026-10-02T02:00:06Z",
        completed_at: null,
        steps: [],
      },
    ],
  });
  const jobs = jobsResponse.jobs ?? [];
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].steps?.length, 3);
  assert.equal(jobs[1].conclusion, null);
  assert.throws(() => GitHubWorkflowJobSchema.parse({ steps: "not-an-array" }));
}

console.log("devflow github schemas smoke OK: 7 entity groups verified");
