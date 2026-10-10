import assert from "node:assert/strict";
import { z } from "zod/v4";
import type { RetrievedDoc } from "@/lib/milvus/retriever";
import {
  CI_LOG_CHUNK_CHARS,
  CI_LOG_MAX_CHUNKS,
  buildItemPayloads,
  buildReviewChecklist,
  ciLogChunks,
  contentRepoPrefix,
  contentScopeFilter,
  contentSource,
  itemChunkRows,
  mapSimilarHits,
  retrievalMode,
  shouldVectorize,
  type ChecklistInput,
  type IssueContentInput,
  type PrContentInput,
  type RunContentInput,
} from "@/lib/devflow/content-index";
import {
  KB_CONFIG_FALLBACK,
  KnowledgeConfigUpdateSchema,
  answerTerms,
  buildExtractiveAnswer,
} from "@/lib/devflow/rag";

function checkSourcePolicy() {
  assert.equal(retrievalMode("issue"), "rag");
  assert.equal(retrievalMode("pull_request"), "rag");
  assert.equal(retrievalMode("workflow_run"), "rag");
  assert.equal(retrievalMode("weekly_report"), "direct");
  assert.equal(retrievalMode("something_unknown"), "direct");
  assert.equal(shouldVectorize("knowledge_file"), true);
  assert.equal(shouldVectorize("team_member"), false);
}

function checkSourceNaming() {
  assert.equal(contentSource("r1", "issue", "i1"), "devflow:item:r1:issue:i1");
  assert.equal(contentRepoPrefix("r1"), "devflow:item:r1:");
  assert.equal(
    contentScopeFilter("r1", "issue"),
    'source like "devflow:item:r1:issue:%"',
  );
  assert.ok(!contentScopeFilter("r1", "issue").includes("pull_request"));
  assert.equal(contentScopeFilter("r1"), 'source like "devflow:item:r1:%"');
}

function checkCiLogChunks() {
  const mid = ciLogChunks("a".repeat(10_000));
  assert.deepEqual(
    mid.chunks.map((c) => c.length),
    [CI_LOG_CHUNK_CHARS, 2_000],
  );
  assert.equal(mid.truncated, false);

  const big = ciLogChunks("b".repeat(50_000));
  assert.equal(big.chunks.length, CI_LOG_MAX_CHUNKS);
  assert.ok(
    big.chunks.every((c) => c.length <= CI_LOG_CHUNK_CHARS),
    "each window within the 8000-char cap",
  );
  assert.equal(big.chunks.join("").length, 48_000);
  assert.equal(big.truncated, true);

  const secret = ciLogChunks(
    `found ghp_ABCDEF012345678901234567890123456789 in output\n${"c".repeat(100)}`,
  );
  assert.ok(
    secret.chunks.join("").includes("[REDACTED_GITHUB_TOKEN]"),
    "tokens sanitized before windowing",
  );
  assert.ok(!secret.chunks.join("").includes("ghp_ABCDEF"), "raw token gone");

  const blank = ciLogChunks("   \n  ");
  assert.deepEqual(blank.chunks, []);
}

const issueFixture: IssueContentInput = {
  id: "issue-1",
  number: 41,
  title: "Milvus sync times out on large collections",
  body: [
    "Steps to reproduce:",
    "1. upload a 200MB doc",
    "2. wait for the embedding job",
    "The worker exits with a `sync timeout` after 60s.".repeat(30),
  ].join("\n"),
  labels: ["bug", "infra"],
  state: "open",
  author: "alice",
  assignees: ["bob"],
  createdAt: new Date("2026-09-01T00:00:00Z"),
  updatedAt: new Date("2026-09-02T00:00:00Z"),
  closedAt: null,
};

const prFixture: PrContentInput = {
  id: "pr-1",
  number: 7,
  title: "fix(login): guard null token",
  body: "Handles the null-token crash.",
  state: "open",
  author: "carol",
  baseBranch: "main",
  headBranch: "fix/null-token",
  additions: 40,
  deletions: 3,
  changedFiles: 2,
  mergedAt: null,
  createdAt: new Date("2026-09-03T00:00:00Z"),
  updatedAt: new Date("2026-09-04T00:00:00Z"),
  files: [
    {
      filename: "src/auth/login.ts",
      status: "modified",
      additions: 30,
      deletions: 3,
    },
    {
      filename: "tests/auth/login.test.ts",
      status: "added",
      additions: 10,
      deletions: 0,
    },
  ],
  reviewComments: [
    {
      path: "src/auth/login.ts",
      line: null,
      originalLine: 42,
      author: "dave",
      body: "Why not throw here?",
    },
  ],
};

const runFixture: RunContentInput = {
  id: "run-1",
  name: "ci/build",
  headBranch: "fix/null-token",
  status: "completed",
  conclusion: "failure",
  htmlUrl: "https://github.com/o/r/actions/runs/1",
  jobs: [{ name: "test", conclusion: "failure" }, "junk", { name: 42 }],
  logsText: `npm ERR! test failed\nsecret ghp_ABCDEF012345678901234567890123456789 leaked\n${"x".repeat(CI_LOG_CHUNK_CHARS * 2 + 500)}`,
  createdAt: new Date("2026-09-04T00:00:00Z"),
  updatedAt: new Date("2026-09-04T00:00:00Z"),
};

function checkBuildItemPayloads() {
  const payloads = buildItemPayloads({
    issues: [
      issueFixture,
      { ...issueFixture, id: "issue-blank", title: " ", body: "  " },
    ],
    pullRequests: [prFixture],
    workflowRuns: [
      runFixture,
      { ...runFixture, id: "run-ok", conclusion: "success" },
      { ...runFixture, id: "run-nologs", logsText: "  " },
    ],
  });

  const issue = payloads.find((p) => p.itemId === "issue-1");
  assert.ok(issue);
  assert.equal(issue.sourceType, "issue");
  assert.ok(issue.content.startsWith(`${issueFixture.title}\n`));
  assert.equal(issue.metadata.number, 41);
  assert.deepEqual(issue.metadata.labels, ["bug", "infra"]);
  assert.equal(issue.metadata.closed_at, null);
  assert.equal(issue.metadata.created_at, "2026-09-01T00:00:00.000Z");

  assert.equal(
    payloads.find((p) => p.itemId === "issue-blank"),
    undefined,
  );

  const long = buildItemPayloads({
    issues: [{ ...issueFixture, title: "t".repeat(600) }],
    pullRequests: [],
    workflowRuns: [],
  });
  assert.equal(long[0].title.length, 500);

  const pr = payloads.find((p) => p.itemId === "pr-1");
  assert.ok(pr);
  assert.ok(pr.content.includes("changed files:"));
  assert.ok(pr.content.includes("src/auth/login.ts"));
  assert.ok(pr.content.includes("review comments:"));
  assert.ok(
    pr.content.includes("src/auth/login.ts:42 dave: Why not throw here?"),
  );
  assert.deepEqual(pr.metadata.files, [
    "src/auth/login.ts",
    "tests/auth/login.test.ts",
  ]);
  assert.equal(pr.metadata.path, "pull/main...fix/null-token");

  const runPayloads = payloads.filter((p) => p.itemId === "run-1");
  assert.equal(runPayloads.length, 3);
  assert.equal(runPayloads[0].title, "ci/build#1");
  assert.equal(runPayloads[2].metadata.chunk_index, 2);
  assert.equal(runPayloads[0].metadata.secrets_redacted, true);
  assert.equal(runPayloads[0].metadata.logs_truncated, false);
  assert.deepEqual(runPayloads[0].metadata.jobs, ["test"]);
  assert.ok(
    runPayloads.every((p) => !p.content.includes("ghp_ABCDEF")),
    "sanitized before windowing",
  );
  assert.equal(
    payloads.find((p) => p.itemId === "run-ok"),
    undefined,
  );
  assert.equal(
    payloads.find((p) => p.itemId === "run-nologs"),
    undefined,
  );
}

function checkItemChunkRows() {
  const payloads = buildItemPayloads({
    issues: [issueFixture],
    pullRequests: [prFixture],
    workflowRuns: [runFixture],
  });
  const issueRows = payloads
    .filter((p) => p.itemId === "issue-1")
    .flatMap((p) => itemChunkRows("r1", p));
  assert.ok(issueRows.length >= 2, "2000-char body yields several 800-chunks");
  for (const [i, row] of issueRows.entries()) {
    assert.equal(row.id, `issue-1#${i}`);
    assert.ok(row.embedText.startsWith(`${issueFixture.title}\n`));
    assert.equal(row.metadata._source, contentSource("r1", "issue", "issue-1"));
    assert.equal(row.metadata.doc_id, "issue-1");
    assert.equal(row.metadata.item_id, "issue-1");
    assert.equal(row.metadata.source_type, "issue");
    assert.equal(row.metadata.doc_name, issueFixture.title);
    assert.equal(row.metadata.path, "items/issue/41");
    assert.equal(row.metadata.chunk_strategy, "structure_aware_v1");
    const siblings = row.metadata.sibling_ids;
    assert.ok(Array.isArray(siblings) && siblings.includes(row.id));
  }

  const runRows = payloads
    .filter((p) => p.itemId === "run-1")
    .flatMap((p) => itemChunkRows("r1", p));
  assert.equal(runRows.length, 3);
  assert.equal(runRows[1].id, "run-1#1");
  assert.ok(runRows[1].content.length > 800, "log window kept intact");
  assert.equal(runRows[1].metadata.parent_id, "run-1");
  assert.equal(runRows[1].metadata.chunk_type, "log_window");
  assert.ok(String(runRows[1].metadata.path).startsWith("items/workflow_run/"));

  const prRows = payloads
    .filter((p) => p.itemId === "pr-1")
    .flatMap((p) => itemChunkRows("r1", p));
  assert.equal(prRows[0].metadata.path, "pull/main...fix/null-token");
}

function fakeDoc(itemId: string, number: number, content = "c"): RetrievedDoc {
  return {
    id: `${itemId}#0`,
    content: content.repeat(400),
    source: contentSource("r1", "issue", itemId),
    metadata: {
      item_id: itemId,
      number,
      item_title: `Title ${number}`,
      doc_name: `Title ${number}`,
      state: "open",
    },
    score: 0.5,
  };
}

function checkMapSimilarHits() {
  const docs = [
    fakeDoc("issue-1", 41),
    fakeDoc("issue-2", 42),
    fakeDoc("issue-2", 42),
    fakeDoc("issue-3", 43),
    fakeDoc("issue-4", 44),
    fakeDoc("issue-5", 45),
    fakeDoc("issue-6", 46),
  ];
  const hits = mapSimilarHits(docs, {
    repoFullName: "acme/repo",
    excludeItemId: "issue-1",
    limit: 5,
  });
  assert.equal(hits.length, 5);
  assert.equal(hits[0].itemId, "issue-2");
  assert.equal(hits[0].url, "https://github.com/acme/repo/issues/42");
  assert.equal(hits[0].title, "Title 42");
  assert.equal(hits[0].excerpt.length, 300);
  assert.deepEqual(
    hits.map((h) => h.itemId),
    ["issue-2", "issue-3", "issue-4", "issue-5", "issue-6"],
  );
}

const baseChecklistInput: ChecklistInput = {
  number: 7,
  title: "fix(login): guard null token",
  body: "Description here.",
  state: "open",
  baseBranch: "main",
  headBranch: "fix/null-token",
  additions: 40,
  deletions: 3,
  changedFiles: 2,
  files: [
    { filename: "src/core/login.ts" },
    { filename: "tests/core/login.test.ts" },
  ],
  reviewCommentCount: 0,
  runs: [{ name: "ci/build", status: "completed", conclusion: "success" }],
};

function checkReviewChecklist() {
  const clean = buildReviewChecklist(baseChecklistInput);
  assert.equal(clean.blocking, false);
  assert.ok(
    clean.checklist.some((item) => item.includes("No blocking findings")),
  );

  const noTests = buildReviewChecklist({
    ...baseChecklistInput,
    files: [{ filename: "src/core/sync.ts" }],
  });
  const cov = noTests.findings.find((f) => f.title === "No test files changed");
  assert.ok(cov);
  assert.equal(cov.severity, "P2");
  assert.equal(cov.blocking, true);

  const failingCi = buildReviewChecklist({
    ...baseChecklistInput,
    runs: [{ name: "ci/build", status: "completed", conclusion: "failure" }],
  });
  assert.ok(
    failingCi.findings.some(
      (f) => f.severity === "P1" && f.blocking && /CI/i.test(f.title),
    ),
  );

  const docsOnly = buildReviewChecklist({
    ...baseChecklistInput,
    files: [{ filename: "README.md" }],
  });
  assert.equal(
    docsOnly.findings.find((f) => f.title === "No test files changed"),
    undefined,
  );

  const sensitive = buildReviewChecklist({
    ...baseChecklistInput,
    files: [
      { filename: "src/auth/session.ts" },
      { filename: "tests/auth/session.test.ts" },
      { filename: "pnpm-lock.yaml" },
    ],
  });
  assert.ok(
    sensitive.findings.some((f) =>
      f.title.includes("authentication/authorization"),
    ),
  );
  assert.ok(
    sensitive.findings.some((f) => f.title.includes("dependency manifests")),
  );

  const breaking = buildReviewChecklist({
    ...baseChecklistInput,
    title: "feat(api)!: drop legacy endpoints",
  });
  assert.ok(
    breaking.findings.some((f) => f.title === "Breaking change" && f.blocking),
  );
  const breakingBody = buildReviewChecklist({
    ...baseChecklistInput,
    body: "BREAKING CHANGE: the old auth flow is gone.",
  });
  assert.ok(breakingBody.findings.some((f) => f.title === "Breaking change"));

  const withComments = buildReviewChecklist({
    ...baseChecklistInput,
    reviewCommentCount: 3,
  });
  assert.ok(
    withComments.findings.some(
      (f) => f.title === "Review comments pending" && f.severity === "P2",
    ),
  );

  const noCi = buildReviewChecklist({ ...baseChecklistInput, runs: [] });
  assert.ok(noCi.findings.some((f) => f.title === "No CI status recorded"));

  const all = buildReviewChecklist({
    ...baseChecklistInput,
    files: [{ filename: "src/core/sync.ts" }],
    reviewCommentCount: 2,
    runs: [{ name: "ci", status: "completed", conclusion: "failure" }],
    title: "feat!: x",
  });
  const order = all.findings.map((f) => f.severity);
  const rank: Record<string, number> = { P1: 0, P2: 1, P3: 2 };
  assert.deepEqual(
    order,
    [...order].sort((a, b) => rank[a] - rank[b]),
  );
  assert.equal(all.blocking, true);
}

function checkAnswerTerms() {
  const en = answerTerms("Milvus sync-timeout");
  assert.ok(en.has("milvus"));
  assert.ok(en.has("sync-timeout"));

  const zh = answerTerms("登录失败");
  assert.ok(zh.has("登录"), "bigram");
  assert.ok(zh.has("录失败"), "trigram");
  const shortZh = answerTerms("崩溃");
  assert.ok(shortZh.has("崩溃"), "≤3-char segment kept whole");
}

function checkBuildExtractiveAnswer() {
  const empty = buildExtractiveAnswer("q", []);
  assert.deepEqual(empty.selected, []);
  assert.ok(/not retrieve enough evidence/i.test(empty.answer));

  const sources = [
    {
      title: "runbook",
      snippet:
        "# Section\nThe Milvus sync timeout is caused by an oversized batch.\nUnrelated sentence about cafeteria menus.\nThe fix is to lower EMBED_BATCH_SIZE to 10 inputs.",
    },
    {
      title: "faq",
      snippet:
        "Milvus timeout handling: restart the proxy when gRPC hangs.\nMilvus timeout handling: restart the proxy when gRPC hangs.",
    },
  ];
  const { answer, selected } = buildExtractiveAnswer(
    "how to fix milvus sync timeout",
    sources,
  );
  assert.ok(
    answer.startsWith(
      "Based on the evidence retrieved from the knowledge base:",
    ),
  );
  assert.ok(selected.length <= 4);
  assert.ok(selected.length >= 2);
  assert.ok(
    selected.some(
      (s) => s.citation === 1 && /oversized batch/.test(s.sentence),
    ),
    "best-overlap sentence surfaced with its citation",
  );
  assert.ok(
    selected.some(
      (s) => s.citation === 2 && /restart the proxy/.test(s.sentence),
    ),
    "faq sentence surfaced",
  );
  assert.ok(
    !selected.some((s) => /EMBED_BATCH_SIZE/.test(s.sentence)),
    "second sentence from an already-cited source dropped",
  );
  assert.ok(
    !selected.some((s) => /cafeteria/.test(s.sentence)),
    "low-overlap sentence dropped",
  );
  const proxyQuotes = selected.filter((s) =>
    /restart the proxy/.test(s.sentence),
  );
  assert.equal(proxyQuotes.length, 1);
  assert.ok(!selected.some((s) => s.sentence.startsWith("#")));
  assert.ok(/\[\d\]/.test(selected.length ? answer : ""));
}

function checkConfigSchema() {
  const full = KnowledgeConfigUpdateSchema.safeParse({
    repoId: "r1",
    retrievalMethod: "bm25",
    rerankEnabled: false,
    topK: 4,
    chunkSize: 1200,
    chunkOverlap: 150,
  });
  assert.ok(full.success);

  const partial = KnowledgeConfigUpdateSchema.safeParse({ repoId: "r1" });
  assert.ok(partial.success);
  assert.equal(partial.data.topK, undefined);

  const badChunking = KnowledgeConfigUpdateSchema.safeParse({
    repoId: "r1",
    chunkSize: 800,
    chunkOverlap: 900,
  });
  assert.equal(badChunking.success, false);

  const badMethod = KnowledgeConfigUpdateSchema.safeParse({
    repoId: "r1",
    retrievalMethod: "vector",
  });
  assert.equal(badMethod.success, false);

  const badTopK = KnowledgeConfigUpdateSchema.safeParse({
    repoId: "r1",
    topK: 0,
  });
  assert.equal(badTopK.success, false);

  assert.equal(KB_CONFIG_FALLBACK.chunkSize, 800);
  assert.equal(KB_CONFIG_FALLBACK.chunkOverlap, 100);
  assert.equal(KB_CONFIG_FALLBACK.topK, 5);

  const SearchShape = z.object({
    repoId: z.string().min(1),
    query: z.string().min(1),
    docId: z.string().min(1).optional(),
    scope: z.enum(["kb", "item", "project"]).optional(),
    sourceType: z.string().min(1).max(80).optional(),
  });
  assert.ok(
    SearchShape.safeParse({ repoId: "r", query: "q", scope: "item" }).success,
  );
  assert.equal(
    SearchShape.safeParse({ repoId: "r", query: "q", scope: "everything" })
      .success,
    false,
  );
}

function main() {
  checkSourcePolicy();
  checkSourceNaming();
  checkCiLogChunks();
  checkBuildItemPayloads();
  checkItemChunkRows();
  checkMapSimilarHits();
  checkReviewChecklist();
  checkAnswerTerms();
  checkBuildExtractiveAnswer();
  checkConfigSchema();
  console.log("DEVFLOW-CONTENT-INDEX SMOKE OK");
}

main();
