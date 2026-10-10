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

  const visible = events
    .filter((e) => e.type === "text")
    .map((e) => e.content)
    .join("");
  assert.equal(visible, "All clear. ", "filter strips the block from text");
  const a2ui = events.find((e) => e.type === "a2ui");
  assert.ok(a2ui && a2ui.type === "a2ui" && a2ui.messages.length > 0);

  assert.equal(final.text, `All clear. ${block}`);
  assert.equal(final.reasoning, "checking alerts then answer");
  assert.equal(progress.text, final.text);
  assert.equal(toolEvents.length, 1);
  assert.equal(toolEvents[0].state, "result");
  assert.equal(toolEvents[0].name, "query_prometheus_alerts");
  assert.equal(toolEvents[0].resultText, "no active alerts");
  assert.ok(toolEvents[0].durationMs >= 0);

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
  assert.equal(shouldTriggerSummary(SUMMARY_TRIGGER_PAIRS - 1), false);
  assert.equal(shouldTriggerSummary(SUMMARY_TRIGGER_PAIRS), true);
  assert.equal(shouldTriggerSummary(SUMMARY_TRIGGER_PAIRS + 4), true);

  const long = `  ${"x".repeat(SUMMARY_MAX_CHARS + 500)}  `;
  const capped = capSummary(long);
  assert.ok(capped.length <= SUMMARY_MAX_CHARS, "summary must fit the cap");
  assert.ok(capped.endsWith("…"), "capped summary keeps an ellipsis");
  assert.equal(capSummary("  hi   there  "), "hi there");

  assert.equal(summarySection(""), "");
  const section = summarySection("user asked about disk alerts");
  assert.ok(section.startsWith("\n\n## Conversation summary\n"));
  assert.ok(section.includes("disk alerts"));

  const prompt = buildSummaryPrompt("old facts", [
    { role: "user", content: "why is node-3 paging?" },
    { role: "assistant", content: "disk pressure on /var" },
  ]);
  assert.ok(prompt.includes("old facts"));
  assert.ok(prompt.includes("user: why is node-3 paging?"));
  assert.ok(prompt.includes(`At most ${SUMMARY_MAX_CHARS} characters`));

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
  const mem = new SimpleMemory("smoke_fail_session");
  for (let i = 0; i < 20; i++) {
    mem.setMessages({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `msg ${i}`,
    });
  }
  assert.ok(shouldTriggerSummary(mem.pendingPairCount()));
  await mem.maybeSummarize();
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
  assert.equal(
    summarizeAuditText({ query: "a b\n c" }),
    '{"query":"a b\\n c"}',
  );

  const big = { sql: "SELECT " + "x".repeat(2000) };
  const clipped = summarizeAuditText(big);
  assert.ok(clipped.length <= AUDIT_TEXT_CHARS, "audit excerpt capped");
  assert.ok(clipped.endsWith("..."));

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
