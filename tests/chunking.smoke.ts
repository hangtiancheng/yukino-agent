import assert from "node:assert/strict";
import {
  chunkDocument,
  chunkCodeText,
  chunkPrFiles,
  siblingIdsByParent,
} from "@/lib/devflow/chunking";
import {
  dedupeNearDuplicates,
  limitPerParent,
  heuristicRerank,
  tokenize,
} from "@/lib/devflow/retrieval-post";
import { evaluateAnswerGate } from "@/lib/devflow/rag";
import type { RetrievedDoc } from "@/lib/milvus/retriever";

function doc(
  id: string,
  content: string,
  score: number,
  metadata: Record<string, unknown> = {},
): RetrievedDoc {
  return { id, content, source: "s", metadata, score };
}

function checkPlain() {
  const text =
    "第一段说明登录流程。".repeat(8) +
    "\n\n" +
    "第二段说明刷新令牌。".repeat(8) +
    "\n\n" +
    "第三段说明退出流程。".repeat(8);
  const chunks = chunkDocument(text, "notes.txt", 190, 20);
  assert.ok(chunks.length >= 2, "plain: multiple chunks");
  assert.ok(
    chunks.every((c) => c.content.length <= 190),
    "plain: size cap",
  );
  assert.ok(chunks[0]!.content.includes("\n\n"), "plain: paragraphs kept");

  assert.throws(
    () => chunkDocument("content", "a.txt", 100, 100),
    /overlap/,
    "plain: invalid overlap rejected",
  );
  console.log("plain chunking OK");
}

function checkMarkdown() {
  const text = `# Authentication

The service verifies access tokens before every request.

## Refresh tokens

Refresh tokens are rotated after a successful exchange.

\`\`\`python
def rotate_token(token: str) -> str:
    return token + "-rotated"
\`\`\`
`;
  const chunks = chunkDocument(text, "auth.md", 180, 20);
  assert.ok(chunks.length > 0, "markdown: chunks");
  assert.ok(
    chunks.every((c) => c.content.length <= 180),
    "markdown: size cap",
  );
  assert.ok(
    chunks.some(
      (c) => c.section_path.join("|") === "Authentication|Refresh tokens",
    ),
    "markdown: section_path preserved",
  );
  const code = chunks.find((c) => c.chunk_type === "markdown_code");
  assert.ok(code, "markdown: code chunk typed");
  assert.equal(
    (code!.content.match(/```/g) ?? []).length,
    2,
    "markdown: fences balanced",
  );
  assert.equal(
    code!.section_title,
    "Refresh tokens",
    "markdown: section title",
  );
  assert.ok(
    (code!.start_line ?? 0) <= (code!.end_line ?? 0),
    "markdown: line range",
  );

  const overlapText =
    "# A\n\nalpha bravo charlie delta echo foxtrot\n\nsecond evidence";
  const overlapChunks = chunkDocument(overlapText, "overlap.md", 55, 20);
  assert.equal(overlapChunks.length, 2, "markdown: overlap chunk count");
  const overlapBody = overlapChunks[1]!.content.split("\n\n")[1] ?? "";
  const firstWord = overlapBody.trim().split(/\s+/)[0] ?? "";
  assert.ok(
    firstWord === "charlie" || firstWord === "delta",
    `markdown: overlap starts at boundary (got ${firstWord})`,
  );

  const runbook = "# Deploy\n\nRun the migration before restarting the API.";
  const first = chunkDocument(runbook, "runbook.md", 200, 20);
  const second = chunkDocument(runbook, "runbook.md", 200, 20);
  assert.deepEqual(
    first.map((c) => c.chunk_id),
    second.map((c) => c.chunk_id),
    "markdown: stable chunk ids",
  );
  assert.deepEqual(
    first.map((c) => c.parent_id),
    second.map((c) => c.parent_id),
    "markdown: stable parent ids",
  );
  console.log("markdown chunking OK");
}

function checkCode() {
  const ts = `import { api } from './api';

export async function loadUser(id: string) {
  return api.get(\`/users/\${id}\`);
}

export const saveUser = async (id: string) => {
  return api.post(\`/users/\${id}\`);
};
`;
  const chunks = chunkCodeText(ts, "src/users.ts", 220);
  const symbols = new Set(chunks.map((c) => c.symbol));
  assert.ok(
    symbols.has("module") && symbols.has("loadUser") && symbols.has("saveUser"),
    `ts code: symbols (got ${[...symbols]})`,
  );
  assert.ok(
    chunks.every((c) => c.language === "ts"),
    "ts code: language",
  );
  assert.ok(
    chunks.every((c) => c.content.length <= 220),
    "ts code: size cap",
  );

  const py = `import os

def load_settings() -> dict:
    return {"environment": os.getenv("ENV", "dev")}

class TokenService:
    def issue(self, user_id: str) -> str:
        return f"token:{user_id}"
`;
  const pyChunks = chunkCodeText(py, "app/token_service.py", 220);
  const pySymbols = new Set(pyChunks.map((c) => c.symbol));
  assert.ok(
    ["module", "load_settings", "TokenService"].every((s) => pySymbols.has(s)),
    `py code (regex regions): symbols (got ${[...pySymbols]})`,
  );
  const fn = pyChunks.find((c) => c.symbol === "load_settings");
  assert.ok(fn, "py code: function found");
  assert.equal(fn!.start_line, 3, "py code: start line");
  assert.ok(
    String(fn!.header).startsWith("File: app/token_service.py"),
    "py code: header",
  );

  const broken = "def broken(:\n    return 1\n";
  const brokenChunks = chunkCodeText(broken, "broken.py", 80);
  assert.ok(brokenChunks.length > 0, "py code: invalid source still chunks");
  assert.ok(
    brokenChunks
      .map((c) => c.content)
      .join("\n")
      .includes("def broken"),
    "py code: content kept",
  );
  console.log("code chunking OK");
}

function checkCsv() {
  const csv = [
    "id,name,status",
    "1,login-flow,active",
    "2,refresh-token,active",
    "3," + "x".repeat(40) + ",deprecated",
  ].join("\n");
  const chunks = chunkDocument(csv, "flags.csv", 80, 0);
  assert.ok(chunks.length >= 1, "csv: chunks");
  assert.ok(
    chunks.every((c) => c.content.startsWith("id,name,status")),
    "csv: header repeated in every chunk",
  );
  assert.ok(
    chunks.some((c) => c.chunk_type === "csv_rows"),
    "csv: rows chunk type",
  );
  assert.ok(
    chunks.every(
      (c) => typeof c.row_start === "number" && typeof c.row_end === "number",
    ),
    "csv: row ranges",
  );
  const quoted = 'a,b\n1,"two\nlines"\n';
  const quotedChunks = chunkDocument(quoted, "q.csv", 200, 0);
  assert.ok(
    quotedChunks[0]!.content.includes("two\nlines"),
    "csv: quoted newline kept",
  );
  console.log("csv chunking OK");
}

function checkJson() {
  const small = JSON.stringify({ alpha: 1 });
  const smallChunks = chunkDocument(small, "small.json", 200, 0);
  assert.equal(smallChunks.length, 1, "json: small doc single chunk");
  assert.equal(smallChunks[0]!.chunk_type, "json_value", "json: type");

  const big = JSON.stringify({
    alpha: "A".repeat(500),
    beta: "B".repeat(500),
  });
  const bigChunks = chunkDocument(big, "big.json", 300, 0);
  assert.ok(bigChunks.length >= 2, "json: split by top-level keys");
  assert.ok(
    bigChunks.every(
      (c) => typeof c.json_path === "string" && c.json_path.startsWith("$."),
    ),
    "json: key paths",
  );
  console.log("json chunking OK");
}

function checkPrPatch() {
  const patch = "diff --git a/x b/x\n" + "+line\n".repeat(80);
  const chunks = chunkPrFiles([{ filename: "x.ts", patch }], 200);
  assert.ok(chunks.length >= 3, "patch: multiple chunks");
  assert.ok(
    new Set(chunks.map((c) => c.chunk_id)).size === chunks.length,
    "patch: unique ids",
  );
  console.log("pr patch chunking OK");
}

function checkSiblings() {
  const text = `# Big

${"para one. ".repeat(30)}

${"para two. ".repeat(30)}

${"para three. ".repeat(30)}
`;
  const chunks = chunkDocument(text, "big.md", 120, 0);
  assert.ok(chunks.length >= 3, `siblings: doc split (got ${chunks.length})`);
  const ids = siblingIdsByParent(chunks, (i) => `doc#${i}`);
  assert.equal(ids.length, chunks.length, "siblings: aligned");
  chunks.forEach((_, i) => {
    assert.equal(ids[i]![1], `doc#${i}`, `siblings: own id at slot 1 for ${i}`);
  });
  console.log("sibling ids OK");
}

function checkDedupAndCap() {
  const a = doc(
    "a",
    "Milvus supports hybrid dense plus BM25 search fused by RRF.",
    0.9,
    {
      doc_id: "d1",
      parent_id: "p1",
      child_index: 0,
    },
  );
  const b = doc(
    "b",
    "Milvus supports hybrid dense plus BM25 search fused by RRF!",
    0.8,
    {
      doc_id: "d1",
      parent_id: "p1",
      child_index: 1,
    },
  );
  const c = doc(
    "c",
    "Milvus supports hybrid dense plus BM25 search fused by RRF.",
    0.7,
    {
      doc_id: "d2",
    },
  );
  const deduped = dedupeNearDuplicates([a, b, c]);
  assert.deepEqual(
    deduped.map((d) => d.id),
    ["a", "c"],
    "dedup: same-doc near-duplicate removed, other doc kept",
  );

  const many = Array.from({ length: 4 }, (_, i) =>
    doc(
      `x${i}`,
      `distinct body number ${i} about ${"topic ".repeat(5)}`,
      0.9 - i * 0.1,
      {
        parent_id: "p",
        child_index: i,
      },
    ),
  );
  const capped = limitPerParent(many);
  assert.equal(capped.length, 2, "cap: at most 2 per parent");

  const noParent = doc("y", "unrelated content here", 0.5);
  assert.equal(
    limitPerParent([noParent]).length,
    1,
    "cap: parentless untouched",
  );
  console.log("dedup + parent cap OK");
}

function checkHeuristicRerank() {
  const pool = [
    doc(
      "low",
      "completely unrelated prose about cooking pasta with sauce",
      0.9,
    ),
    doc(
      "high",
      "the postgres_query tool rejects administrative database roles",
      0.1,
    ),
  ];
  const { ranked, reasons } = heuristicRerank("postgres_query roles", pool, 2);
  assert.equal(
    ranked[0]!.id,
    "high",
    "heuristic: query-relevant doc ranks first",
  );
  assert.ok(
    reasons.get("high")!.includes("query terms"),
    "heuristic: rank_reason",
  );
  assert.ok(
    ranked.every((d) => d.score >= 0 && d.score <= 1),
    "heuristic: scores within [0,1]",
  );
  console.log("heuristic rerank OK");
}

function checkAnswerGateConflict() {
  const hits = [
    {
      docId: "d1",
      docName: "a.md",
      content: "Feature_flag is enabled and requests succeed.",
    },
    {
      docId: "d2",
      docName: "b.md",
      content: "Feature_flag is disabled and requests failed.",
    },
  ];
  const gate = evaluateAnswerGate("is feature_flag working", hits);
  assert.equal(gate.decision, "conflict", "gate: polarity conflict detected");

  const neutral = [
    {
      docId: "d1",
      docName: "a.md",
      content: "The gateway routes traffic upstream.",
    },
    {
      docId: "d2",
      docName: "b.md",
      content: "The sidecar proxies metadata requests.",
    },
  ];
  const ambiguous = evaluateAnswerGate("how to handle this one", neutral);
  assert.equal(
    ambiguous.decision,
    "ask_clarification",
    "gate: english ambiguity",
  );

  const answer = evaluateAnswerGate("postgres_query roles", [
    {
      docId: "d1",
      docName: "ops.md",
      content: "postgres_query only allows read roles.",
    },
  ]);
  assert.equal(answer.decision, "answer", "gate: normal answer still allowed");
  console.log("answer gate conflict OK");
}

function checkTokenize() {
  const tokens = tokenize("Milvus 混合检索");
  assert.ok(tokens.includes("milvus"), "tokenize: ascii");
  assert.ok(
    tokens.includes("混") && tokens.includes("混合"),
    "tokenize: cjk uni+bigram",
  );
  console.log("tokenize OK");
}

async function checkIndexPolicy() {
  const { parseIndexPolicyYaml, policyAllows, policyDigest, globToRegExp } =
    await import("@/lib/devflow/project-index");

  const policy = parseIndexPolicyYaml(
    [
      "version: 1",
      "project_docs:",
      "  mode: allowlist",
      "  include: [docs/**, README.md]",
      "  exclude: ['docs/legacy/*']",
      "include_manifests: false",
    ].join("\n"),
  );
  assert.equal(policy.mode, "allowlist");
  assert.deepEqual(policy.include, ["docs/**", "README.md"]);
  assert.equal(policy.includeManifests, false);

  assert.ok(
    policyAllows({ rel: "README.md", sourceType: "readme" }, policy),
    "policy: allowlisted",
  );
  assert.ok(
    policyAllows({ rel: "docs/guide.md", sourceType: "docs" }, policy),
    "policy: glob docs/**",
  );
  assert.ok(
    !policyAllows({ rel: "docs/legacy/old.md", sourceType: "docs" }, policy),
    "policy: exclude wins",
  );
  assert.ok(
    !policyAllows({ rel: "package.json", sourceType: "manifest" }, policy),
    "policy: manifests off",
  );
  assert.ok(
    !policyAllows({ rel: "src/index.ts", sourceType: "docs" }, policy),
    "policy: allowlist rejects others",
  );

  assert.ok(globToRegExp("a*b").test("a/x/yb"), "glob: star crosses slash");
  assert.ok(globToRegExp("file?.md").test("file1.md"), "glob: question mark");
  assert.ok(globToRegExp("[ab]c").test("bc"), "glob: char class");
  assert.ok(!globToRegExp("[!ab]c").test("ac"), "glob: negated class");

  assert.equal(
    policyDigest(policy),
    policyDigest(
      parseIndexPolicyYaml(
        "project_docs:\n  mode: allowlist\n  include: [docs/**, README.md]\n  exclude: ['docs/legacy/*']\ninclude_manifests: false",
      ),
    ),
  );
  const other = parseIndexPolicyYaml("project_docs:\n  mode: auto");
  assert.notEqual(
    policyDigest(policy),
    policyDigest(other),
    "policy digest differs",
  );

  assert.throws(
    () => parseIndexPolicyYaml("version: 2"),
    /Unsupported project index config version/,
  );
  assert.throws(
    () => parseIndexPolicyYaml("project_docs:\n  mode: allowlist"),
    /cannot be empty/,
  );
  console.log("index policy OK");
}

function main() {
  checkPlain();
  checkMarkdown();
  checkCode();
  checkCsv();
  checkJson();
  checkPrPatch();
  checkSiblings();
  checkDedupAndCap();
  checkHeuristicRerank();
  checkAnswerGateConflict();
  checkTokenize();
  void checkIndexPolicy().then(() => console.log("CHUNKING SMOKE OK"));
}

main();
