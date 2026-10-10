import assert from "node:assert/strict";
import {
  MultiRepoReportSchema,
  OPEN_ISSUE_BACKLOG,
  OPEN_PR_BACKLOG,
  STALE_PR_DAYS,
  WorkspaceCreateSchema,
  WorkspaceUpdateSchema,
  buildRiskItems,
  classifyRepoRisk,
  dedupeRepoIds,
  deterministicMultiRepoReport,
  missingRepoIds,
  reportTotalsFromSummaries,
  totalsFromRepoStats,
  type RepoAggregate,
  type RepoReportSummary,
} from "@/lib/devflow/workspaces";

function checkRepoIdValidation() {
  assert.deepEqual(dedupeRepoIds(["r2", "r1", "r2", "r3", "r1"]), [
    "r2",
    "r1",
    "r3",
  ]);
  assert.deepEqual(dedupeRepoIds([]), []);

  assert.deepEqual(missingRepoIds(["r1", "r2", "r3"], ["r1", "r3"]), ["r2"]);
  assert.deepEqual(missingRepoIds(["r1"], ["r1"]), []);
  assert.deepEqual(missingRepoIds([], []), []);
}

function checkSchemas() {
  const created = WorkspaceCreateSchema.safeParse({
    name: "  Platform Team  ",
    repoIds: ["r1", "r1"],
  });
  assert.ok(created.success);
  assert.equal(created.data.name, "Platform Team");
  assert.equal(created.data.description, undefined);
  assert.deepEqual(created.data.repoIds, ["r1", "r1"]);

  assert.equal(
    WorkspaceCreateSchema.safeParse({ name: "" }).success,
    false,
    "empty name rejected",
  );
  assert.equal(
    WorkspaceCreateSchema.safeParse({ name: "x".repeat(101), repoIds: [] })
      .success,
    false,
    "over-long name rejected",
  );
  const noRepos = WorkspaceCreateSchema.safeParse({ name: "solo" });
  assert.ok(noRepos.success);
  assert.deepEqual(noRepos.data.repoIds, []);

  assert.equal(WorkspaceUpdateSchema.safeParse({}).success, false);
  assert.ok(WorkspaceUpdateSchema.safeParse({ name: "renamed" }).success);
  assert.ok(
    WorkspaceUpdateSchema.safeParse({ description: null }).success,
    "description can be cleared",
  );
  assert.ok(WorkspaceUpdateSchema.safeParse({ repoIds: [] }).success);

  assert.ok(
    MultiRepoReportSchema.safeParse({
      startDate: "2026-09-29",
      endDate: "2026-10-06",
    }).success,
  );
  assert.equal(
    MultiRepoReportSchema.safeParse({
      startDate: "2026-9-29",
      endDate: "2026-10-06",
    }).success,
    false,
  );
}

const fakeRepoStats: RepoAggregate[] = [
  {
    repoId: "r1",
    fullName: "acme/frontend",
    issues: 30,
    openIssues: 12,
    pullRequests: 20,
    openPrs: 7,
    mergedPrs: 9,
    runs: 50,
    failedRuns: 4,
    knowledgeDocs: 3,
  },
  {
    repoId: "r2",
    fullName: null,
    issues: 10,
    openIssues: 2,
    pullRequests: 5,
    openPrs: 1,
    mergedPrs: 3,
    runs: 12,
    failedRuns: 0,
    knowledgeDocs: 1,
  },
];

function checkAggregateFolds() {
  const totals = totalsFromRepoStats(fakeRepoStats);
  assert.deepEqual(totals, {
    repos: 2,
    issues: 40,
    openIssues: 14,
    pullRequests: 25,
    openPrs: 8,
    mergedPrs: 12,
    runs: 62,
    failedRuns: 4,
    knowledgeDocs: 4,
  });
  assert.deepEqual(totalsFromRepoStats([]).repos, 0);
}

function checkRiskGrading() {
  const failed = classifyRepoRisk({
    failedCi: 2,
    staleOpenPrs: 0,
    openPrs: 1,
    openIssues: 0,
  });
  assert.equal(failed.level, "P0");
  assert.equal(failed.reasons.length, 1);
  assert.ok(failed.reasons[0].includes("failed CI"));

  const backlog = classifyRepoRisk({
    failedCi: 0,
    staleOpenPrs: 0,
    openPrs: OPEN_PR_BACKLOG + 1,
    openIssues: 0,
  });
  assert.equal(backlog.level, "P0");

  const atThreshold = classifyRepoRisk({
    failedCi: 0,
    staleOpenPrs: 0,
    openPrs: OPEN_PR_BACKLOG,
    openIssues: OPEN_ISSUE_BACKLOG,
  });
  assert.equal(atThreshold.level, "P2");
  assert.deepEqual(atThreshold.reasons, []);

  const stale = classifyRepoRisk({
    failedCi: 0,
    staleOpenPrs: 1,
    openPrs: 2,
    openIssues: 0,
  });
  assert.equal(stale.level, "P0");
  assert.ok(stale.reasons[0].includes(`${STALE_PR_DAYS}+ days`));

  const issues = classifyRepoRisk({
    failedCi: 0,
    staleOpenPrs: 0,
    openPrs: 1,
    openIssues: OPEN_ISSUE_BACKLOG + 1,
  });
  assert.equal(issues.level, "P1");

  const quiet = classifyRepoRisk({
    failedCi: 0,
    staleOpenPrs: 0,
    openPrs: 0,
    openIssues: 0,
  });
  assert.equal(quiet.level, "P2");
  assert.deepEqual(quiet.reasons, []);

  const multi = classifyRepoRisk({
    failedCi: 3,
    staleOpenPrs: 2,
    openPrs: 9,
    openIssues: 1,
  });
  assert.equal(multi.level, "P0");
  assert.equal(multi.reasons.length, 3);
}

function summaryOf(
  overrides: Partial<RepoReportSummary> & { repoId: string },
): RepoReportSummary {
  return {
    fullName: "acme/x",
    rangeIssues: 0,
    rangePrs: 0,
    rangeRuns: 0,
    openIssues: 0,
    openPrs: 0,
    mergedPrs: 0,
    failedCi: 0,
    staleOpenPrs: 0,
    knowledgeDocs: 0,
    riskLevel: "P2",
    riskReasons: [],
    ...overrides,
  };
}

function checkRiskItemsAndTotals() {
  const summaries = [
    summaryOf({
      repoId: "r-low",
      fullName: "acme/quiet",
      riskLevel: "P2",
    }),
    summaryOf({
      repoId: "r-p1",
      fullName: "acme/backlog",
      openIssues: 9,
      riskLevel: "P1",
      riskReasons: ["open issue backlog of 9 (> 5)"],
    }),
    summaryOf({
      repoId: "r-p0",
      fullName: "acme/broken",
      failedCi: 4,
      openPrs: 7,
      riskLevel: "P0",
      riskReasons: [
        "4 failed CI run(s) in range",
        "open PR backlog of 7 (> 5)",
      ],
    }),
  ];
  const items = buildRiskItems(summaries);
  assert.deepEqual(
    items.map((item) => `${item.level}:${item.repoId}`),
    ["P0:r-p0", "P1:r-p1"],
  );
  assert.equal(items[0].reasons.length, 2);

  const totals = reportTotalsFromSummaries(summaries);
  assert.equal(totals.repos, 3);
  assert.equal(totals.failedCi, 4);
  assert.equal(totals.openIssues, 9);
  assert.equal(totals.openPrs, 7);
}

function checkTemplate() {
  const summaries = [
    summaryOf({
      repoId: "r1",
      fullName: "acme/frontend",
      openIssues: 12,
      openPrs: 7,
      mergedPrs: 9,
      failedCi: 4,
      rangeIssues: 15,
      rangePrs: 11,
      rangeRuns: 50,
      riskLevel: "P0",
      riskReasons: [
        "4 failed CI run(s) in range",
        "open PR backlog of 7 (> 5)",
      ],
    }),
    summaryOf({
      repoId: "r2",
      fullName: null,
      openIssues: 2,
      openPrs: 1,
      mergedPrs: 3,
      failedCi: 0,
      riskLevel: "P2",
    }),
  ];
  const md = deterministicMultiRepoReport({
    workspaceName: "Platform",
    startDate: "2026-09-29",
    endDate: "2026-10-06",
    totals: reportTotalsFromSummaries(summaries),
    summaries,
  });

  assert.ok(md.startsWith("# Multi-repository engineering weekly report\n"));
  assert.ok(
    md.includes("> Range: 2026-09-29 to 2026-10-06 · Workspace: Platform"),
  );
  assert.ok(md.includes("- Repositories: 2"));
  assert.ok(md.includes("- Open Issues: 14"));
  assert.ok(md.includes("- Open PRs: 8"));
  assert.ok(md.includes("- Merged PRs in range: 12"));
  assert.ok(md.includes("- Failed CI in range: 4"));
  assert.ok(
    md.includes(
      "- acme/frontend: open issues 12, open PRs 7, merged 9, failed CI 4, risk P0",
    ),
  );
  assert.ok(md.includes("deleted repo (r2)"));
  assert.ok(md.includes("- acme/frontend: 4 failed CI run(s) in range."));
  assert.ok(md.includes("- acme/frontend: open PR backlog of 7 (> 5)."));
  assert.ok(!md.includes("No high-risk repositories"));
  assert.ok(md.endsWith("\n"));

  const quiet = deterministicMultiRepoReport({
    workspaceName: "Quiet",
    startDate: "2026-09-29",
    endDate: "2026-10-06",
    totals: reportTotalsFromSummaries([
      summaryOf({ repoId: "r1", fullName: "acme/quiet" }),
    ]),
    summaries: [summaryOf({ repoId: "r1", fullName: "acme/quiet" })],
  });
  assert.ok(
    quiet.includes(
      "No high-risk repositories; keep watching PR dwell time and review backlog.",
    ),
  );

  const empty = deterministicMultiRepoReport({
    workspaceName: "Empty",
    startDate: "2026-09-29",
    endDate: "2026-10-06",
    totals: reportTotalsFromSummaries([]),
    summaries: [],
  });
  assert.ok(empty.includes("- No repositories in this workspace yet."));
}

function main() {
  checkRepoIdValidation();
  checkSchemas();
  checkAggregateFolds();
  checkRiskGrading();
  checkRiskItemsAndTotals();
  checkTemplate();
  console.log("DEVFLOW-WORKSPACES SMOKE OK");
}

main();
