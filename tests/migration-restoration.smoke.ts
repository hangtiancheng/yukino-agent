import assert from "node:assert/strict";
import { sanitizeCiLog } from "@/lib/devflow/sanitize";
import {
  applyScoreThreshold,
  evaluateAnswerGate,
  KB_CONFIG_FALLBACK,
  strongQuerySignals,
} from "@/lib/devflow/rag";
import { parseRerankResults } from "@/lib/ai/rerank";
import {
  FeedbackListQuerySchema,
  FeedbackUpsertSchema,
} from "@/lib/ai/feedback";
import {
  MemorySearchQuerySchema,
  RecallEventListQuerySchema,
} from "@/lib/devflow/memory";

function checkSanitize() {
  const raw = [
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIEowIBAAKCAQEA7crypted",
    "-----END RSA PRIVATE KEY-----",
    "found ghp_ABCDEF012345678901234567890123456789 in output",
    "aws AKIAIOSFODNN7EXAMPLE used",
    "jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U here",
    "Authorization: Bearer abc123token",
    "::add-mask::my-secret-value",
    "API_KEY=sk-1234567890",
    "db_password: hunter2",
    "plain text stays intact",
  ].join("\n");

  const sanitized = sanitizeCiLog(raw);
  assert.ok(
    sanitized.includes("[REDACTED_PRIVATE_KEY]"),
    "private key redacted",
  );
  assert.ok(
    sanitized.includes("[REDACTED_GITHUB_TOKEN]"),
    "github token redacted",
  );
  assert.ok(
    sanitized.includes("[REDACTED_AWS_ACCESS_KEY]"),
    "aws key redacted",
  );
  assert.ok(sanitized.includes("[REDACTED_JWT]"), "jwt redacted");
  assert.ok(
    /authorization: bearer \[REDACTED\]/i.test(sanitized),
    "bearer token redacted",
  );
  assert.ok(
    sanitized.includes("::add-mask::[REDACTED]"),
    "add-mask line redacted",
  );
  assert.ok(/API_KEY=\[REDACTED\]/.test(sanitized), "key=value redacted");
  assert.ok(/db_password: \[REDACTED\]/.test(sanitized), "key: value redacted");
  assert.ok(sanitized.includes("plain text stays intact"), "normal text kept");
  assert.ok(!sanitized.includes("hunter2"), "secret value gone");
  assert.ok(!sanitized.includes("MIIEowIBAAKCAQEA7crypted"), "key body gone");
  console.log("sanitizeCiLog: 10 assertions passed");
}

function checkAnswerGate() {
  const hit = {
    docId: "d1",
    docName: "runbook.md",
    content: "Restart the payment-gateway service when TimeoutError occurs.",
  };

  assert.deepEqual(
    strongQuerySignals("payment-gateway TimeoutError #123 怎么办"),
    ["payment-gateway", "timeouterror", "#123"],
  );
  assert.deepEqual(strongQuerySignals("how are you"), []);

  assert.equal(
    evaluateAnswerGate("payment-gateway TimeoutError 怎么办", [hit]).decision,
    "answer",
  );

  assert.equal(
    evaluateAnswerGate("checkout-service NullPointerException #999", [hit])
      .decision,
    "insufficient_evidence",
  );

  assert.equal(
    evaluateAnswerGate("payment-gateway and unknown-thing", [hit]).decision,
    "answer",
  );

  assert.equal(
    evaluateAnswerGate("这个怎么处理", [
      hit,
      { docId: "d2", docName: "other.md", content: "something else" },
    ]).decision,
    "ask_clarification",
  );

  assert.equal(
    evaluateAnswerGate("这个怎么处理 payment-gateway timeout", [hit]).decision,
    "answer",
  );

  assert.equal(
    evaluateAnswerGate("anything", []).decision,
    "insufficient_evidence",
  );
  console.log("answer gate: 6 assertions passed");
}

function checkRerankParser() {
  const payload = {
    output: {
      results: [
        { index: 0, relevance_score: 0.4 },
        { index: 2, relevance_score: 0.9 },
        { index: 1, relevance_score: 0.7 },
      ],
    },
  };
  assert.deepEqual(parseRerankResults(payload, 3, 2), [
    { index: 2, score: 0.9 },
    { index: 1, score: 0.7 },
  ]);

  assert.throws(() =>
    parseRerankResults(
      { output: { results: [{ index: 9, relevance_score: 0.5 }] } },
      3,
      2,
    ),
  );
  assert.throws(() =>
    parseRerankResults(
      {
        output: {
          results: [
            { index: 0, relevance_score: 0.5 },
            { index: 0, relevance_score: 0.6 },
          ],
        },
      },
      3,
      2,
    ),
  );
  assert.throws(() =>
    parseRerankResults(
      { output: { results: [{ index: 0, relevance_score: 1.5 }] } },
      3,
      2,
    ),
  );
  assert.throws(() => parseRerankResults({ results: [] }, 3, 2));
  console.log("rerank parser: 5 assertions passed");
}

function checkFeedbackSchemas() {
  const parsed = FeedbackUpsertSchema.safeParse({
    targetType: "chat_message",
    targetId: "session_1:3",
    rating: "negative",
    reason: "  wrong tool  ",
    comment: "",
    correction: "",
  });
  assert.ok(parsed.success, "valid feedback parses");
  if (parsed.success) {
    assert.equal(parsed.data.reason, "wrong tool", "reason trimmed");
    assert.equal(parsed.data.comment, undefined, "empty comment dropped");
    assert.equal(parsed.data.correction, undefined, "empty correction dropped");
    assert.equal(parsed.data.subjectId, undefined, "subjectId optional");
  }

  assert.ok(
    !FeedbackUpsertSchema.safeParse({
      targetType: "chat_message",
      targetId: "x",
      rating: "meh",
    }).success,
    "invalid rating rejected",
  );
  assert.ok(
    !FeedbackUpsertSchema.safeParse({
      targetType: "workspace",
      targetId: "x",
      rating: "positive",
    }).success,
    "invalid target rejected",
  );
  assert.ok(
    !FeedbackUpsertSchema.safeParse({
      targetType: "citation",
      targetId: "",
      rating: "positive",
    }).success,
    "empty targetId rejected",
  );
  assert.ok(
    !FeedbackListQuerySchema.safeParse({ targetType: "citation" }).success,
    "list query requires targetId",
  );
  assert.ok(
    FeedbackListQuerySchema.safeParse({
      targetType: "diagnostic_report",
      targetId: "run-1",
    }).success,
    "diagnostic_report target accepted",
  );
  console.log("feedback schemas: 8 assertions passed");
}

async function checkScoreThreshold() {
  assert.equal(KB_CONFIG_FALLBACK.scoreThresholdEnabled, false);
  assert.equal(KB_CONFIG_FALLBACK.scoreThreshold, 0.5);

  const docs = [
    { id: "a", score: 0.9 },
    { id: "b", score: 0.4 },
  ];
  const disabled = await applyScoreThreshold(docs, "q", 'source like "x"', {
    ...KB_CONFIG_FALLBACK,
  });
  assert.deepEqual(disabled, docs, "disabled threshold is a no-op");

  const empty = await applyScoreThreshold([], "q", 'source like "x"', {
    ...KB_CONFIG_FALLBACK,
    scoreThresholdEnabled: true,
  });
  assert.deepEqual(empty, [], "empty input stays empty");
  console.log("score threshold: 4 assertions passed");
}

function checkMemorySchemas() {
  const search = MemorySearchQuerySchema.safeParse({});
  assert.ok(search.success, "memory search defaults parse");
  if (search.success) {
    assert.equal(search.data.q, "");
    assert.equal(search.data.limit, 8);
  }
  const coerced = MemorySearchQuerySchema.safeParse({ q: "auth", limit: "5" });
  assert.ok(coerced.success && coerced.data.limit === 5, "limit coerced");

  const events = RecallEventListQuerySchema.safeParse({});
  assert.ok(events.success && events.data.limit === 30, "recall defaults");
  assert.ok(
    !RecallEventListQuerySchema.safeParse({ limit: 500 }).success,
    "recall limit capped",
  );
  console.log("memory schemas: 5 assertions passed");
}

try {
  checkSanitize();
  checkAnswerGate();
  checkRerankParser();
  checkFeedbackSchemas();
  await checkScoreThreshold();
  checkMemorySchemas();
  console.log("MIGRATION-RESTORATION SMOKE OK");
} catch (e) {
  console.error("SMOKE FAILED:", e);
  process.exit(1);
}
