import assert from "node:assert/strict";
import {
  CIDebugSchema,
  IssueAnalysisSchema,
  PRReviewSchema,
  type CIDebug,
  type IssueAnalysis,
  type PRReview,
} from "@/lib/devflow/schemas";
import {
  buildOwnerAllowList,
  chooseMergeRecommendation,
  classifyCiFailure,
  classifyIssueCategory,
  classifyIssuePriority,
  deterministicCiDebug,
  deterministicIssueAnalysis,
  deterministicPrReview,
  estimateIssueComplexity,
  extractFirstError,
  extractRelatedFiles,
  findSensitiveFiles,
  findTestFiles,
  isAllowedOwner,
  lexicalDuplicateScore,
  mergeCiDebug,
  mergeIssueAnalysis,
  mergePrReview,
  type CiFacts,
  type IssueFacts,
  type PrFacts,
} from "@/lib/devflow/agents/analysis";
import { deterministicWeeklyReport } from "@/lib/devflow/agents/report";
import {
  TeamMemberCreateSchema,
  TeamMemberUpdateSchema,
  toTeamMemberProfile,
} from "@/lib/devflow/team";

let checks = 0;
function check(label: string, fn: () => void) {
  fn();
  checks += 1;
  console.log(`ok - ${label}`);
}

const baseIssueFacts: IssueFacts = {
  number: 1,
  title: "API returns 500",
  body: "Login fails",
  state: "open",
  labels: ["bug"],
  author: "reporter",
  assignees: [],
};

check("issue: bug classification + P1 priority", () => {
  const text = "api returns 500 login fails";
  assert.equal(classifyIssueCategory(text, ["bug"]), "bug");
  assert.equal(classifyIssuePriority(text, ["bug"]), "P1");
});

check(
  "issue: deterministic baseline is schema-valid and confidence-clamped",
  () => {
    const analysis = deterministicIssueAnalysis(baseIssueFacts, {
      duplicateCandidates: [],
      knowledgeEvidence: [],
      teamMembers: [],
    });
    assert.deepEqual(IssueAnalysisSchema.parse(analysis), analysis);
    assert.equal(analysis.category, "bug");
    assert.equal(analysis.conclusion, "needs_clarification");
    assert.ok(analysis.checklist.length > 0);
    assert.ok(analysis.confidence >= 0.35 && analysis.confidence <= 0.86);
    assert.equal(analysis.suggested_owner, "unassigned");
    assert.match(analysis.owner_reason, /No team members are configured/);
  },
);

check("issue: strong duplicate forces merge_duplicate", () => {
  const analysis = deterministicIssueAnalysis(
    {
      ...baseIssueFacts,
      title: "Login API returns 500 when token expires",
      body: "Steps: expire JWT, call /login, expected 401 but actual 500. Impact: users cannot renew sessions.",
    },
    {
      duplicateCandidates: [
        { number: 9, title: "JWT expiry returns 500", score: 0.91 },
      ],
      knowledgeEvidence: [],
      teamMembers: [],
    },
  );
  assert.equal(analysis.conclusion, "merge_duplicate");
  assert.ok(analysis.duplicate_candidates.length === 1);
  assert.ok(analysis.evidence.some((e) => e.source_type === "similar_issue"));
});

check("issue: closed state forces close", () => {
  const analysis = deterministicIssueAnalysis(
    { ...baseIssueFacts, state: "closed" },
    { duplicateCandidates: [], knowledgeEvidence: [], teamMembers: [] },
  );
  assert.equal(analysis.conclusion, "close");
});

check("issue: XL architecture forces split", () => {
  assert.equal(
    estimateIssueComplexity(
      "the auth architecture migration spans modules",
      [],
    ),
    "XL",
  );
  const analysis = deterministicIssueAnalysis(
    {
      ...baseIssueFacts,
      title: "Refactor the authentication architecture and migrate sessions",
      body: `Architecture migration across modules. ${"- a\n".repeat(10)}Steps: expected actual impact scope.`,
      labels: ["refactor"],
    },
    { duplicateCandidates: [], knowledgeEvidence: [], teamMembers: [] },
  );
  assert.equal(analysis.complexity, "XL");
  assert.equal(analysis.conclusion, "split");
});

check("issue: first assignee wins over team matching", () => {
  const analysis = deterministicIssueAnalysis(
    { ...baseIssueFacts, assignees: ["alice", "bob"] },
    { duplicateCandidates: [], knowledgeEvidence: [], teamMembers: [] },
  );
  assert.equal(analysis.suggested_owner, "alice");
});

check("issue: desktop/electron profile match suggests the team member", () => {
  const analysis = deterministicIssueAnalysis(
    {
      ...baseIssueFacts,
      title: "Feature: 增加桌面化能力",
      body: "### What problem does this solve?\n可以把这个项目桌面化\n\n### Proposed solution\n解决需要打开网页才能使用的问题",
      labels: [],
    },
    {
      duplicateCandidates: [],
      knowledgeEvidence: [],
      teamMembers: [
        {
          name: "liyonghong",
          displayName: "李勇宏",
          skills: ["擅长electron、js"],
          availability: "",
          notes: "前端工程师",
        },
      ],
    },
  );
  assert.equal(analysis.category, "feature");
  assert.equal(analysis.suggested_owner, "liyonghong");
  assert.match(analysis.owner_reason, /desktop\/electron|electron/);
});

check(
  "issue: lexical duplicate scoring is bounded and order-preserving",
  () => {
    const identical = lexicalDuplicateScore(
      "JWT expiry returns 500",
      "JWT expiry returns 500",
    );
    const unrelated = lexicalDuplicateScore(
      "JWT expiry returns 500",
      "Add dark mode to settings page",
    );
    assert.equal(identical, 1);
    assert.ok(unrelated < 0.3);
  },
);

const ruleAnalysis = deterministicIssueAnalysis(baseIssueFacts, {
  duplicateCandidates: [],
  knowledgeEvidence: [],
  teamMembers: [],
});
const allowList = buildOwnerAllowList({
  assignees: ["alice"],
  author: "reporter",
  historicalAuthors: ["carol"],
  teamLogins: ["bob"],
});

check(
  "issue: allow-list covers assignees ∪ authors ∪ team ∪ issue author",
  () => {
    assert.ok(isAllowedOwner("Alice", allowList));
    assert.ok(isAllowedOwner("bob", allowList));
    assert.ok(isAllowedOwner("carol", allowList));
    assert.ok(isAllowedOwner("reporter", allowList));
    assert.ok(isAllowedOwner("unassigned", allowList));
    assert.ok(!isAllowedOwner("布偶猫", allowList));
  },
);

check(
  "issue: LLM-invented owner is rejected and the rule value restored",
  () => {
    const llm: IssueAnalysis = {
      ...ruleAnalysis,
      suggested_owner: "布偶猫",
      owner_reason: "仓库文档里提到了布偶猫",
      summary: "LLM summary",
    };
    const merged = mergeIssueAnalysis(llm, ruleAnalysis, allowList);
    assert.equal(merged.ownerValidation.status, "replaced");
    assert.equal(merged.result.suggested_owner, ruleAnalysis.suggested_owner);
    assert.ok(!merged.result.owner_reason.includes("布偶猫"));
    assert.deepEqual(IssueAnalysisSchema.parse(merged.result), merged.result);
  },
);

check(
  "issue: LLM fields override rules when valid; question→rule category",
  () => {
    const llm: IssueAnalysis = {
      ...ruleAnalysis,
      category: "question",
      priority: "P0",
      evidence: [],
      summary: "Better summary",
      suggested_owner: "alice",
    };
    const merged = mergeIssueAnalysis(llm, ruleAnalysis, allowList);
    assert.equal(merged.result.priority, "P0");
    assert.equal(merged.result.summary, "Better summary");
    assert.equal(merged.result.category, ruleAnalysis.category);
    assert.deepEqual(merged.result.evidence, ruleAnalysis.evidence);
    assert.equal(merged.ownerValidation.status, "accepted");
  },
);

check("issue: generic LLM owner is replaced by the concrete rule owner", () => {
  const ruleWithOwner: IssueAnalysis = {
    ...ruleAnalysis,
    suggested_owner: "liyonghong",
    owner_reason:
      "Team profile matches issue/code/document signals: electron (score 8).",
  };
  const genericList = buildOwnerAllowList({
    assignees: [],
    author: null,
    historicalAuthors: [],
    teamLogins: ["backend"],
  });
  const llm: IssueAnalysis = { ...ruleAnalysis, suggested_owner: "backend" };
  const merged = mergeIssueAnalysis(llm, ruleWithOwner, genericList);
  assert.equal(merged.result.suggested_owner, "liyonghong");
  assert.equal(merged.ownerValidation.status, "replaced");
});

const cleanFacts: PrFacts = {
  number: 7,
  title: "Fix typo in README",
  body: "Docs only.",
  state: "open",
  author: "alice",
  mergedAt: false,
  files: [
    {
      filename: "README.md",
      status: "modified",
      additions: 2,
      deletions: 1,
      patch: "+x\n-y",
    },
  ],
  comments: [],
};
const emptyCi = { recentRuns: 0, failedRuns: 0, failed: [] };
const cleanContext = {
  ciSummary: emptyCi,
  relatedIssues: [],
  codeReferences: 0,
  knowledgeEvidence: 0,
  conversationEvidence: 0,
};

check("pr: sensitive/test file detection", () => {
  assert.deepEqual(
    findSensitiveFiles([
      "lib/auth/token.ts",
      "prisma/schema.prisma",
      "README.md",
    ]),
    ["lib/auth/token.ts", "prisma/schema.prisma"],
  );
  assert.deepEqual(findTestFiles(["tests/a.py", "app/site.spec.tsx"]), [
    "tests/a.py",
    "app/site.spec.tsx",
  ]);
});

check("pr: small clean PR approves deterministically", () => {
  const review = deterministicPrReview(cleanFacts, cleanContext);
  assert.deepEqual(PRReviewSchema.parse(review), review);
  assert.equal(review.merge_recommendation, "approve");
  assert.equal(review.blocking_issues.length, 0);
  assert.ok(review.review_findings.every((f) => f.severity === "P3"));
  assert.ok(review.confidence >= 0.38 && review.confidence <= 0.88);
});

check("pr: failed CI forces blocking findings and hold", () => {
  const review = deterministicPrReview(
    {
      ...cleanFacts,
      files: [
        {
          filename: "src/server/auth.ts",
          status: "modified",
          additions: 300,
          deletions: 40,
          patch: "x".repeat(50),
        },
      ],
    },
    {
      ...cleanContext,
      ciSummary: {
        recentRuns: 4,
        failedRuns: 2,
        failed: [
          { name: "ci", conclusion: "failure", logsExcerpt: "npm ERR!" },
        ],
      },
    },
  );
  assert.ok(review.blocking_issues.length > 0);
  assert.ok(
    review.review_findings.some((f) => f.severity === "P1" && f.blocking),
  );
  assert.equal(review.merge_recommendation, "hold");
});

check("pr: sensitive files without tests block the merge", () => {
  const review = deterministicPrReview(
    {
      ...cleanFacts,
      files: [
        {
          filename: "db/migration/001.sql",
          status: "added",
          additions: 120,
          deletions: 0,
          patch: "CREATE TABLE",
        },
        {
          filename: "src/app/page.tsx",
          status: "modified",
          additions: 30,
          deletions: 10,
          patch: "y",
        },
      ],
    },
    cleanContext,
  );
  assert.ok(
    review.blocking_issues.some(
      (b) => b.includes("Sensitive") || b.includes("test"),
    ),
  );
  assert.ok(
    ["merge_with_changes", "hold"].includes(review.merge_recommendation),
  );
  assert.notEqual(review.merge_recommendation, "approve");
});

check(
  "pr: LLM approve with P1/P2 findings is downgraded to merge_with_changes",
  () => {
    const rule = deterministicPrReview(cleanFacts, cleanContext);
    const llm: PRReview = {
      ...rule,
      merge_recommendation: "approve",
      review_findings: [
        {
          severity: "P1",
          title: "Destructive migration",
          evidence: "Drops the sessions table.",
          required_action: "Add a rollback plan.",
          blocking: true,
        },
      ],
      blocking_issues: [],
    };
    const merged = mergePrReview(llm, rule);
    assert.equal(merged.merge_recommendation, "merge_with_changes");
    assert.ok(merged.blocking_issues.length > 0);
    assert.match(merged.recommendation_reason, /P1\/P2/);
    assert.deepEqual(PRReviewSchema.parse(merged), merged);
  },
);

check("pr: empty LLM lists are backfilled from the rule output", () => {
  const rule = deterministicPrReview(cleanFacts, cleanContext);
  const llm: PRReview = {
    ...rule,
    plan: [],
    test_suggestions: [],
    files_need_attention: [],
    summary: "",
  };
  const merged = mergePrReview(llm, rule);
  assert.deepEqual(merged.plan, rule.plan);
  assert.deepEqual(merged.test_suggestions, rule.test_suggestions);
  assert.equal(merged.summary, rule.summary);
});

check("pr: WIP signal holds even without blockers", () => {
  const { recommendation } = chooseMergeRecommendation(
    { ...cleanFacts, title: "WIP: explore new parser" },
    [],
    [],
    0,
  );
  assert.equal(recommendation, "hold");
});

const ciLog = [
  "Run pnpm install",
  "Scope: all 3 projects",
  "> jest run",
  "FAIL tests/unit/auth.spec.ts",
  "AssertionError: expected 200 to be 401",
  "Tests 1 failed 3 passed",
  "Error: process completed with exit code 1",
].join("\n");

check("ci: six-category ordered classification", () => {
  assert.equal(
    classifyCiFailure("got Permission denied writing /etc"),
    "permission",
  );
  assert.equal(classifyCiFailure("SECRET is not set"), "environment");
  assert.equal(classifyCiFailure("npm ERR! cannot find module"), "dependency");
  assert.equal(classifyCiFailure("✖ eslint found problems"), "lint");
  assert.equal(classifyCiFailure("next build failed: type error"), "build");
  assert.equal(classifyCiFailure("pytest exited with assertion"), "test");
  assert.equal(classifyCiFailure("something weird happened"), "unknown");
});

check("ci: first error window extraction", () => {
  const extracted = extractFirstError(ciLog);
  assert.ok(extracted);
  assert.ok(extracted.includes("AssertionError"));
  assert.ok(extracted.length <= 900);
  assert.equal(extractFirstError("   "), undefined);
});

check("ci: related file extraction normalizes paths", () => {
  const files = extractRelatedFiles(
    "`src/a.ts` failed at tests\\b.py and app\\config.yml",
  );
  assert.ok(files.includes("src/a.ts"));
  assert.ok(files.includes("tests/b.py"));
  assert.ok(files.includes("app/config.yml"));
});

const ciFacts: CiFacts = {
  name: "CI",
  status: "completed",
  conclusion: "failure",
  logsText: ciLog,
  jobs: [
    {
      name: "unit-tests",
      conclusion: "failure",
      steps: [
        { name: "Checkout", conclusion: "success" },
        { name: "Run tests", conclusion: "failure" },
      ],
    },
  ],
};
const ciContext = {
  recentPrs: [{ number: 7, title: "Fix typo", state: "open" }],
  matchedPrNumber: 7,
  codeReferences: 0,
};

check("ci: deterministic debug is schema-valid and blocking", () => {
  const debug = deterministicCiDebug(ciFacts, ciContext);
  assert.deepEqual(CIDebugSchema.parse(debug), debug);
  assert.equal(debug.failure_type, "test");
  assert.equal(debug.is_merge_blocking, true);
  assert.ok(debug.fix_steps.length > 0);
  assert.ok(debug.confidence >= 0.36 && debug.confidence <= 0.86);
});

check("ci: LLM unknown is repaired by the rule classification", () => {
  const rule = deterministicCiDebug(ciFacts, ciContext);
  const llm: CIDebug = {
    ...rule,
    failure_type: "unknown",
    first_error: undefined,
    fix_steps: [],
  };
  const merged = mergeCiDebug(llm, rule);
  assert.equal(merged.failure_type, rule.failure_type);
  assert.equal(merged.first_error, rule.first_error);
  assert.deepEqual(merged.fix_steps, rule.fix_steps);
  assert.deepEqual(CIDebugSchema.parse(merged), merged);
});

check("ci: non-failing completed run does not block merging", () => {
  const debug = deterministicCiDebug(
    { ...ciFacts, conclusion: "success", logsText: "" },
    { ...ciContext, recentPrs: [], matchedPrNumber: null },
  );
  assert.equal(debug.is_merge_blocking, false);
});

check("report: deterministic template embeds exact aggregate numbers", () => {
  const markdown = deterministicWeeklyReport({
    repoName: "acme/widget",
    startDate: "2026-09-28",
    endDate: "2026-10-05",
    metrics: {
      issues: 137,
      pullRequests: 88,
      mergedPrs: 42,
      openPrs: 15,
      failedCi: 21,
      closedIssues: 60,
      totalRuns: 150,
    },
    sampleTruncated: true,
    mergedPrNumbers: [42, 41],
    closedIssueNumbers: [101],
    openPrs: [{ number: 50, title: "Add search" }],
    prsForAttention: [{ number: 50, title: "Add search" }],
    failedRuns: [{ name: "e2e", conclusion: "failure" }],
    repeatFailWorkflows: [{ name: "e2e", count: 12 }],
  });
  assert.ok(markdown.includes("Issues: 137 in range (60 closed)"));
  assert.ok(markdown.includes("88 in range, 42 merged, 15 open"));
  assert.ok(markdown.includes("21 of 150 runs"));
  assert.ok(markdown.includes("#42, #41"));
  assert.ok(markdown.includes('"e2e" failed 12 time(s)'));
  assert.ok(markdown.includes("most recent items only"));
});

check("team: create schema validates logins and skills", () => {
  assert.equal(
    TeamMemberCreateSchema.safeParse({
      githubLogin: "octocat",
      skills: ["react"],
    }).success,
    true,
  );
  assert.equal(
    TeamMemberCreateSchema.safeParse({ githubLogin: "-bad-" }).success,
    false,
  );
  assert.equal(
    TeamMemberCreateSchema.safeParse({ githubLogin: "ok", skills: [""] })
      .success,
    false,
  );
});

check(
  "team: update schema rejects empty bodies; profile mapping is stable",
  () => {
    assert.equal(TeamMemberUpdateSchema.safeParse({}).success, false);
    assert.equal(
      TeamMemberUpdateSchema.safeParse({ notes: null }).success,
      true,
    );
    const profile = toTeamMemberProfile({
      githubLogin: "octocat",
      displayName: null,
      skills: ["electron"],
      availability: null,
      notes: null,
    });
    assert.deepEqual(profile, {
      name: "octocat",
      displayName: "",
      skills: ["electron"],
      availability: "",
      notes: "",
    });
  },
);

console.log(`DEVFLOW-ANALYSIS SMOKE OK (${checks} checks)`);
