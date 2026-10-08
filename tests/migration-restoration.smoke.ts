// Offline smoke test for the migration-restoration pieces: CI log
// sanitization, the DevFlow QA answer gate, and the rerank response parser.
// No network/Milvus/embedding keys required:
//   npx tsx tests/migration-restoration.smoke.ts
import assert from "node:assert/strict";
import { sanitizeCiLog } from "@/lib/devflow/sanitize";
import { evaluateAnswerGate, strongQuerySignals } from "@/lib/devflow/rag";
import { parseRerankResults } from "@/lib/ai/rerank";

function checkSanitize() {
  const raw = [
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIEowIBAAKCAQEA7crypted",
    "-----END RSA PRIVATE KEY-----",
    // Bare token (not behind a key=) so the GitHub-token rule is what fires;
    // a `token=ghp_...` form ends up as token=[REDACTED] because the
    // key/value rule re-redacts the placeholder afterwards — same as the
    // Python original, where the patterns run in this order.
    "found ghp_ABCDEF012345678901234567890123456789 in output",
    "aws AKIAIOSFODNN7EXAMPLE used",
    // Bare JWT (the bearer rule would otherwise re-redact the JWT
    // placeholder, same order as the Python original).
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

  // Strong signals: identifier + digits extracted from the query.
  assert.deepEqual(
    strongQuerySignals("payment-gateway TimeoutError #123 怎么办"),
    ["payment-gateway", "timeouterror", "#123"],
  );
  assert.deepEqual(strongQuerySignals("how are you"), []);

  // Identifier present in evidence → allowed to answer.
  assert.equal(
    evaluateAnswerGate("payment-gateway TimeoutError 怎么办", [hit]).decision,
    "answer",
  );

  // ALL strong signals absent from evidence → refuse (anti-fabrication).
  assert.equal(
    evaluateAnswerGate("checkout-service NullPointerException #999", [hit])
      .decision,
    "insufficient_evidence",
  );

  // Partial match (one signal present) → not refused by the signal rule.
  assert.equal(
    evaluateAnswerGate("payment-gateway and unknown-thing", [hit]).decision,
    "answer",
  );

  // Ambiguous marker + multiple sources → ask clarification.
  assert.equal(
    evaluateAnswerGate("这个怎么处理", [
      hit,
      { docId: "d2", docName: "other.md", content: "something else" },
    ]).decision,
    "ask_clarification",
  );

  // Ambiguous marker + single source + long query → still answerable.
  assert.equal(
    evaluateAnswerGate("这个怎么处理 payment-gateway timeout", [hit]).decision,
    "answer",
  );

  // Empty hits → insufficient.
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
  // Sorted by score desc, cut to topN.
  assert.deepEqual(parseRerankResults(payload, 3, 2), [
    { index: 2, score: 0.9 },
    { index: 1, score: 0.7 },
  ]);

  // Invalid index (out of range) → throws.
  assert.throws(() =>
    parseRerankResults(
      { output: { results: [{ index: 9, relevance_score: 0.5 }] } },
      3,
      2,
    ),
  );
  // Duplicate index → throws.
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
  // Score outside [0, 1] → throws.
  assert.throws(() =>
    parseRerankResults(
      { output: { results: [{ index: 0, relevance_score: 1.5 }] } },
      3,
      2,
    ),
  );
  // Malformed envelope → throws.
  assert.throws(() => parseRerankResults({ results: [] }, 3, 2));
  console.log("rerank parser: 5 assertions passed");
}

try {
  checkSanitize();
  checkAnswerGate();
  checkRerankParser();
  console.log("MIGRATION-RESTORATION SMOKE OK");
} catch (e) {
  console.error("SMOKE FAILED:", e);
  process.exit(1);
}
