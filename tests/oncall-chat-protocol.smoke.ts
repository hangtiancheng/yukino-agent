// Offline smoke test for the OnCall chat-protocol restoration (G1/G2/G6 +
// memory compaction + tool-call audits) — no Milvus, no LLM, no PG needed:
//   1. processChatStreamParts() over a FAKE AI SDK fullStream: reasoning
//      deltas, tool-call lifecycle events, a2ui stream-filter composition and
//      event ordering (legacy reasoning.delta / tool.call parity);
//   2. unterminated a2ui block at stream end degrades to a notice;
//   3. memory compaction pure functions (trigger threshold, 1200-char cap,
//      system-prompt section, eviction into the pending buffer) plus the
//      no-key failure path of maybeSummarize (keeps old summary, never throws);
//   4. knowledgeType classification (frontmatter / filename / body /
//      diagnostic-case) and ChatReference propagation;
//   5. tool-call audit text summarization (500-char cap, whitespace
//      normalization, circular-value fallback).
//   npx tsx tests/oncall-chat-protocol.smoke.ts
import assert from "node:assert/strict";
import type { TextStreamPart, ToolSet } from "ai";
import {
  AUDIT_TEXT_CHARS,
  processChatStreamParts,
  summarizeAuditText,
  toReferences,
  type ChatStreamEvent,
  type ChatStreamPartsResult,
  type ChatToolEvent,
} from "@/lib/ai/pipelines/chat";
import type { RetrievedDoc } from "@/lib/milvus/retriever";
import {
  A2UI_CLOSE_TAG,
  A2UI_OPEN_TAG,
  A2UI_PROMPT_SECTION,
} from "@/lib/ai/a2ui/prompt";
import { parseA2uiBlock } from "@/lib/ai/a2ui/extract";
import {
  SUMMARY_MAX_CHARS,
  SUMMARY_TRIGGER_PAIRS,
  SimpleMemory,
  buildSummaryPrompt,
  capSummary,
  shouldTriggerSummary,
  summarySection,
} from "@/lib/memory";
import {
  classifyKnowledgeType,
  parseFrontmatterKnowledgeType,
} from "@/lib/ai/pipelines/knowledge-index";

type Part = TextStreamPart<ToolSet>;

function firstPromptExampleBlock(): string {
  // A real, protocol-valid A2UI block straight from the chat prompt few-shots.
  // (The prose also mentions the tags inside backticks — only blocks whose
  // body starts with JSON count, same rule as tests/a2ui.smoke.ts.)
  let cursor = 0;
  for (;;) {
    const begin = A2UI_PROMPT_SECTION.indexOf(A2UI_OPEN_TAG, cursor);
    assert.notEqual(begin, -1, "prompt section must carry an a2ui example");
    const end = A2UI_PROMPT_SECTION.indexOf(
      A2UI_CLOSE_TAG,
      begin + A2UI_OPEN_TAG.length,
    );
    assert.notEqual(end, -1, "a2ui example must be closed");
    const block = A2UI_PROMPT_SECTION.slice(begin, end + A2UI_CLOSE_TAG.length);
    cursor = end + A2UI_CLOSE_TAG.length;
    const body = block.slice(
      A2UI_OPEN_TAG.length,
      block.length - A2UI_CLOSE_TAG.length,
    );
    // (The prose also mentions the tags inside backticks and shows an
    // `[...]` placeholder — only blocks that actually parse count.)
    const trimmed = body.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      if (parseA2uiBlock(body).messages) return block;
    }
  }
}

async function collect(
  parts: Part[],
  hooks?: Parameters<typeof processChatStreamParts>[1],
): Promise<{ events: ChatStreamEvent[]; final: ChatStreamPartsResult }> {
  const gen = processChatStreamParts(
    (async function* () {
      for (const p of parts) yield p;
    })(),
    hooks,
  );
  const events: ChatStreamEvent[] = [];
  let res = await gen.next();
  while (!res.done) {
    events.push(res.value);
    res = await gen.next();
  }
  return { events, final: res.value };
}

async function checkStreamProtocol() {
  const block = firstPromptExampleBlock();
  // Split the block across chunks at an awkward boundary (mid-open-tag).
  const cut = A2UI_OPEN_TAG.length - 4;
  const parts: Part[] = [
    { type: "reasoning-delta", id: "r1", text: "checking alerts " },
    {
      type: "tool-call",
      toolCallId: "tc1",
      toolName: "query_prometheus_alerts",
      input: {},
    },
    {
      type: "tool-result",
      toolCallId: "tc1",
      toolName: "query_prometheus_alerts",
      input: {},
      output: "no active alerts",
    },
    { type: "reasoning-delta", id: "r1", text: "then answer" },
    { type: "text-delta", id: "a1", text: "All clear. " },
    { type: "text-delta", id: "a1", text: block.slice(0, cut) },
    { type: "text-delta", id: "a1", text: block.slice(cut) },
  ];

  const toolEvents: ChatToolEvent[] = [];
  const progress = { text: "" };
  const { events, final } = await collect(parts, {
    onToolEvent: (e) => toolEvents.push(e),
    progress,
  });

  // 1. Reasoning deltas arrive as {type:"reasoning"} events, interleaved with
  //    the tool lifecycle exactly as the model emitted them.
  assert.deepEqual(
    events.map((e) => e.type),
    ["reasoning", "tool", "tool", "reasoning", "text", "a2ui"],
    "event order must mirror the part stream",
  );
  assert.deepEqual(
    events.filter((e) => e.type === "tool").map((e) => `${e.name}:${e.state}`),
    ["query_prometheus_alerts:call", "query_prometheus_alerts:result"],
    "tool.call → tool.result lifecycle",
  );

  // 2. Visible text never contains the raw a2ui block; the block arrives as
  //    one validated a2ui event with messages.
  const visible = events
    .filter((e) => e.type === "text")
    .map((e) => e.content)
    .join("");
  assert.equal(visible, "All clear. ", "filter strips the block from text");
  const a2ui = events.find((e) => e.type === "a2ui");
  assert.ok(a2ui && a2ui.type === "a2ui" && a2ui.messages.length > 0);

  // 3. Return channel: raw memory text keeps the tags; reasoning is the
  //    concatenation; the audit hook saw one completed call with payload.
  assert.equal(final.text, `All clear. ${block}`);
  assert.equal(final.reasoning, "checking alerts then answer");
  assert.equal(progress.text, final.text);
  assert.equal(toolEvents.length, 1);
  assert.equal(toolEvents[0].state, "result");
  assert.equal(toolEvents[0].name, "query_prometheus_alerts");
  assert.equal(toolEvents[0].resultText, "no active alerts");
  assert.ok(toolEvents[0].durationMs >= 0);

  // 4. tool-error degrades to the error state and still reports an excerpt.
  const errEvents: ChatToolEvent[] = [];
  const err = new Error("boom");
  const { events: ev2, final: f2 } = await collect(
    [
      {
        type: "tool-call",
        toolCallId: "tc2",
        toolName: "postgres_query",
        input: { sql: "SELECT 1" },
      },
      {
        type: "tool-error",
        toolCallId: "tc2",
        toolName: "postgres_query",
        input: { sql: "SELECT 1" },
        error: err,
      },
    ],
    { onToolEvent: (e) => errEvents.push(e) },
  );
  assert.deepEqual(
    ev2.map((e) => `${e.type}:${e.type === "tool" ? e.state : ""}`),
    ["tool:call", "tool:error"],
  );
  assert.equal(errEvents.length, 1);
  assert.equal(errEvents[0].state, "error");
  assert.equal(errEvents[0].resultText, "boom");
  assert.equal(f2.text, "");

  // 5. Unterminated block at stream end: notice fallback (no corrective hook),
  //    never raw JSON leakage into the text.
  const { events: ev3 } = await collect([
    { type: "text-delta", id: "a1", text: "Tail: " },
    { type: "text-delta", id: "a1", text: `${A2UI_OPEN_TAG}[{"bad"` },
  ]);
  const tailText = ev3
    .filter((e) => e.type === "text")
    .map((e) => e.content)
    .join("");
  assert.equal(tailText, "Tail: ");
  assert.ok(
    ev3.some((e) => e.type === "notice"),
    "invalid block → notice",
  );
  console.log(
    "✓ stream protocol: reasoning/tool ordering, filter, error paths",
  );
}

function checkMemoryCompaction() {
  // Pure threshold: pairs slide out of the 6-window; compaction fires at 6.
  assert.equal(shouldTriggerSummary(SUMMARY_TRIGGER_PAIRS - 1), false);
  assert.equal(shouldTriggerSummary(SUMMARY_TRIGGER_PAIRS), true);
  assert.equal(shouldTriggerSummary(SUMMARY_TRIGGER_PAIRS + 4), true);

  // Legacy summary cap (≤1200 chars) with whitespace normalization.
  const long = `  ${"x".repeat(SUMMARY_MAX_CHARS + 500)}  `;
  const capped = capSummary(long);
  assert.ok(capped.length <= SUMMARY_MAX_CHARS, "summary must fit the cap");
  assert.ok(capped.endsWith("…"), "capped summary keeps an ellipsis");
  assert.equal(capSummary("  hi   there  "), "hi there");

  // System-prompt injection format.
  assert.equal(summarySection(""), "");
  const section = summarySection("user asked about disk alerts");
  assert.ok(section.startsWith("\n\n## Conversation summary\n"));
  assert.ok(section.includes("disk alerts"));

  // Fold prompt carries the previous summary and the transcript.
  const prompt = buildSummaryPrompt("old facts", [
    { role: "user", content: "why is node-3 paging?" },
    { role: "assistant", content: "disk pressure on /var" },
  ]);
  assert.ok(prompt.includes("old facts"));
  assert.ok(prompt.includes("user: why is node-3 paging?"));
  assert.ok(prompt.includes(`At most ${SUMMARY_MAX_CHARS} characters`));

  // Window eviction feeds the pending buffer, pairs stay aligned.
  const mem = new SimpleMemory("smoke_session");
  for (let i = 0; i < 16; i++) {
    mem.setMessages({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `msg ${i}`,
    });
  }
  assert.ok(mem.getMessages().length <= mem.maxWindowSize);
  assert.equal(mem.pendingPairCount(), 5, "10 evicted messages = 5 pairs");
  assert.equal(shouldTriggerSummary(mem.pendingPairCount()), false);
  console.log("✓ memory compaction: thresholds, cap, injection, eviction");
}

async function checkCompactionFailurePath() {
  // Without an LLM key the fire-and-forget fold must swallow the failure,
  // keep the (empty) summary and retain the pending pairs for a later retry.
  const mem = new SimpleMemory("smoke_fail_session");
  for (let i = 0; i < 20; i++) {
    mem.setMessages({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `msg ${i}`,
    });
  }
  assert.ok(shouldTriggerSummary(mem.pendingPairCount()));
  await mem.maybeSummarize(); // resolves, warns — never throws
  assert.equal(mem.getSummary(), "", "failed fold keeps old summary");
  assert.equal(mem.pendingPairCount(), 7, "failed fold keeps pending");
  console.log("✓ compaction failure path: silent degrade, pending retained");
}

function checkKnowledgeType() {
  assert.equal(
    classifyKnowledgeType("sop-restart-nginx.md", "# Restart\n"),
    "sop",
  );
  assert.equal(
    classifyKnowledgeType("aiops-case-0f3a.md", "# Case"),
    "diagnostic-case",
  );
  assert.equal(classifyKnowledgeType("runbook.md", "# Runbook"), "document");
  assert.equal(
    classifyKnowledgeType(
      "notes.md",
      "This Standard Operating Procedure covers X",
    ),
    "sop",
  );
  assert.equal(
    classifyKnowledgeType(
      "notes.md",
      "---\nknowledgeType: diagnostic-case\n---\n# Notes",
    ),
    "diagnostic-case",
  );
  assert.equal(
    classifyKnowledgeType(
      "notes.md",
      '---\nname: x\nknowledgeType: "sop"\n---\nbody',
    ),
    "sop",
  );
  // Invalid explicit values fall through to the heuristics.
  assert.equal(
    classifyKnowledgeType(
      "notes.md",
      "---\nknowledgeType: wizard\n---\n# Notes",
    ),
    "document",
  );
  assert.equal(
    parseFrontmatterKnowledgeType("---\nknowledgeType: sop\n---\n"),
    "sop",
  );
  assert.equal(parseFrontmatterKnowledgeType("no frontmatter"), undefined);

  // Reference propagation: only allowlisted values survive onto the wire.
  const mkDoc = (knowledgeType: unknown): RetrievedDoc => ({
    id: "1",
    content: "body text",
    source: "runbook.md",
    metadata: { title: "Runbook", knowledgeType },
    score: 0.5,
  });
  const refs = toReferences([mkDoc("sop"), mkDoc("wizard"), mkDoc(undefined)]);
  assert.equal(refs[0].knowledgeType, "sop");
  assert.equal(refs[0].title, "Runbook");
  assert.equal("knowledgeType" in refs[1], false);
  assert.equal("knowledgeType" in refs[2], false);
  console.log("✓ knowledgeType: classification + reference propagation");
}

function checkAuditTruncation() {
  assert.equal(summarizeAuditText({ query: "x" }), '{"query":"x"}');
  assert.equal(summarizeAuditText("a  b\n c"), "a b c");
  // Serialized objects never leak raw newlines into the audit column.
  assert.equal(
    summarizeAuditText({ query: "a b\n c" }),
    '{"query":"a b\\n c"}',
  );

  const big = { sql: "SELECT " + "x".repeat(2000) };
  const clipped = summarizeAuditText(big);
  assert.ok(clipped.length <= AUDIT_TEXT_CHARS, "audit excerpt capped");
  assert.ok(clipped.endsWith("..."));

  // Circular structures fall back to String() without throwing.
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(summarizeAuditText(circular), "[object Object]");
  assert.equal(summarizeAuditText(undefined), "undefined");
  console.log("✓ audit text summarization: cap, normalization, fallbacks");
}

async function main() {
  await checkStreamProtocol();
  checkMemoryCompaction();
  await checkCompactionFailurePath();
  checkKnowledgeType();
  checkAuditTruncation();
  console.log("oncall-chat-protocol smoke: ALL OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
