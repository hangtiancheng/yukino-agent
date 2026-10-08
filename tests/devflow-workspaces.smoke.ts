// Offline smoke test for the W2-E multi-repository workspace subsystem
// (lib/devflow/workspaces.ts — port of legacy DevFlow-AI workspaces.py):
// repoIds validation helpers, the pure aggregate folds, the P0/P1/P2 risk
// grading rule (legacy high/medium/low thresholds + the stale-open-PR signal),
// the risk-item ordering, the deterministic cross-repo report template, and
// the zod request contracts. No network / PG / Milvus required:
//   npx tsx tests/devflow-workspaces.smoke.ts
// The DB-backed CRUD + aggregateWorkspaceStats + generateMultiRepoReport paths
// are verified row-level against the local PostgreSQL instead (see task #16).
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

// ---------------------------------------------------------------------------
// repoIds validation helpers (workspaces.py:41-47 dedup, :56-59 missing check)
// ---------------------------------------------------------------------------

function checkRepoIdValidation() {
  // Order-preserving dedup (legacy _repo_ids_from_payload).
  assert.deepEqual(dedupeRepoIds(["r2", "r1", "r2", "r3", "r1"]), [
    "r2",
    "r1",
    "r3",
  ]);
  assert.deepEqual(dedupeRepoIds([]), []);

  // Missing detection against the known repository rows.
  assert.deepEqual(missingRepoIds(["r1", "r2", "r3"], ["r1", "r3"]), ["r2"]);
  assert.deepEqual(missingRepoIds(["r1"], ["r1"]), []);
  assert.deepEqual(missingRepoIds([], []), []);
}

// ---------------------------------------------------------------------------
// zod request contracts
// ---------------------------------------------------------------------------

function checkSchemas() {
  const created = WorkspaceCreateSchema.safeParse({
    name: "  Platform Team  ",
    repoIds: ["r1", "r1"],
  });
  assert.ok(created.success);
  assert.equal(created.data.name, "Platform Team");
  assert.equal(created.data.description, undefined);
  assert.deepEqual(created.data.repoIds, ["r1", "r1"]); // dedup happens at persist

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
  // repoIds defaults to [] — legacy create_workspace allowed an empty set.
  const noRepos = WorkspaceCreateSchema.safeParse({ name: "solo" });
  assert.ok(noRepos.success);
  assert.deepEqual(noRepos.data.repoIds, []);

  // PATCH: at least one field required.
  assert.equal(WorkspaceUpdateSchema.safeParse({}).success, false);
  assert.ok(WorkspaceUpdateSchema.safeParse({ name: "renamed" }).success);
  assert.ok(
    WorkspaceUpdateSchema.safeParse({ description: null }).success,
    "description can be cleared",
  );
  assert.ok(WorkspaceUpdateSchema.safeParse({ repoIds: [] }).success);

  // Report body: strict YYYY-MM-DD dates.
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

// ---------------------------------------------------------------------------
// Aggregate folds (fake data — mirrors aggregateWorkspaceStats groupBy output)
// ---------------------------------------------------------------------------

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
    fullName: null, // deleted repository — stale repoId remains
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

// ---------------------------------------------------------------------------
// Risk grading (workspaces.py:119 thresholds + round-2 stale-open-PR rule)
// ---------------------------------------------------------------------------

function checkRiskGrading() {
  // Legacy "high" → P0 via failed CI.
  const failed = classifyRepoRisk({
    failedCi: 2,
    staleOpenPrs: 0,
    openPrs: 1,
    openIssues: 0,
  });
  assert.equal(failed.level, "P0");
  assert.equal(failed.reasons.length, 1);
  assert.ok(failed.reasons[0].includes("failed CI"));

  // Legacy "high" → P0 via open PR backlog > 5.
  const backlog = classifyRepoRisk({
    failedCi: 0,
    staleOpenPrs: 0,
    openPrs: OPEN_PR_BACKLOG + 1,
    openIssues: 0,
  });
  assert.equal(backlog.level, "P0");

  // Exactly OPEN_PR_BACKLOG open PRs is NOT high (legacy strict >).
  const atThreshold = classifyRepoRisk({
    failedCi: 0,
    staleOpenPrs: 0,
    openPrs: OPEN_PR_BACKLOG,
    openIssues: OPEN_ISSUE_BACKLOG,
  });
  assert.equal(atThreshold.level, "P2");
  assert.deepEqual(atThreshold.reasons, []);

  // Round-2 addition: long-untouched open PRs are a P0 signal on their own.
  const stale = classifyRepoRisk({
    failedCi: 0,
    staleOpenPrs: 1,
    openPrs: 2,
    openIssues: 0,
  });
  assert.equal(stale.level, "P0");
  assert.ok(stale.reasons[0].includes(`${STALE_PR_DAYS}+ days`));

  // Legacy "medium" → P1 via open issue backlog > 5.
  const issues = classifyRepoRisk({
    failedCi: 0,
    staleOpenPrs: 0,
    openPrs: 1,
    openIssues: OPEN_ISSUE_BACKLOG + 1,
  });
  assert.equal(issues.level, "P1");

  // Everything quiet → P2 with no reasons.
  const quiet = classifyRepoRisk({
    failedCi: 0,
    staleOpenPrs: 0,
    openPrs: 0,
    openIssues: 0,
  });
  assert.equal(quiet.level, "P2");
  assert.deepEqual(quiet.reasons, []);

  // Multiple P0 signals accumulate all reasons (CI first).
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
  // P2 repos are not risk items; P0 sorts before P1.
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

// ---------------------------------------------------------------------------
// Deterministic template (workspaces.py:123-141, English translation)
// ---------------------------------------------------------------------------

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
      fullName: null, // deleted repo gets a placeholder, never crashes
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
  // legacy totals block (workspaces.py:127-130)
  assert.ok(md.includes("- Repositories: 2"));
  assert.ok(md.includes("- Open Issues: 14"));
  assert.ok(md.includes("- Open PRs: 8"));
  assert.ok(md.includes("- Merged PRs in range: 12"));
  assert.ok(md.includes("- Failed CI in range: 4"));
  // per-repo breakdown line shape (workspaces.py:134-137)
  assert.ok(
    md.includes(
      "- acme/frontend: open issues 12, open PRs 7, merged 9, failed CI 4, risk P0",
    ),
  );
  assert.ok(md.includes("deleted repo (r2)"));
  // key focus lists the concrete P0 reasons (legacy workspaces.py:138)
  assert.ok(md.includes("- acme/frontend: 4 failed CI run(s) in range."));
  assert.ok(md.includes("- acme/frontend: open PR backlog of 7 (> 5)."));
  // P0 present → the no-risk fallback line is absent
  assert.ok(!md.includes("No high-risk repositories"));
  assert.ok(md.endsWith("\n"));

  // No P0 repos → the legacy fallback line (workspaces.py:139-140).
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

  // Empty workspace still renders a valid document.
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
