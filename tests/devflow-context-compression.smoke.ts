/**
 * Offline checks for the DevFlow progressive context compression port
 * (legacy context_compression.py + ProgressiveContextManager) and the AI Ops
 * run-event projection.
 *
 * Run: npx tsx tests/devflow-context-compression.smoke.ts
 */
import assert from "node:assert/strict";
import {
  COMPACT_BOUNDARY_SUBTYPE,
  buildCompactionSummaryPayload,
  calculateContextPressure,
  compactionPlanForStage,
  compactionPreservationReport,
  compressMessages,
  defaultContextBudget,
  effectiveContextWindowTokens,
  ensureCompactionSummaryPreservesKeyFacts,
  fallbackCompactionSummary,
  formatCompactionSummary,
  isCompactBoundaryMessage,
  modelContextWindowTokens,
  mustPreserveCandidates,
  normalizeModelName,
  thresholdsForWindow,
} from "@/lib/devflow/context-compression";
import {
  MAX_RUN_EVENTS,
  RUN_EVENT_OUTPUT_CHARS,
  pushRunEvent,
  toRunEvent,
} from "@/lib/ai/aiops-run";

function checkModelWindows() {
  assert.equal(normalizeModelName("openai/gpt-4o-2024-05-13"), "gpt-4o");
  // undashed date suffixes are kept (legacy regex needs -/_ separators);
  // the prefix lookup in modelContextWindowTokens still resolves them
  assert.equal(
    normalizeModelName("claude-sonnet-4-20250514"),
    "claude-sonnet-4-20250514",
  );
  assert.equal(normalizeModelName(null), "unknown");

  assert.equal(modelContextWindowTokens("gpt-4o"), 128_000);
  assert.equal(modelContextWindowTokens("claude-sonnet-4-20250514"), 200_000);
  // unknown model → CONTEXT_MAX_INPUT_TOKENS + CONTEXT_RESERVED_RESPONSE_TOKENS
  assert.equal(modelContextWindowTokens("totally-unknown-model"), 27_000);

  // unknown model, compaction reserve: min(3000, 12000) → 27000-3000=24000
  assert.equal(effectiveContextWindowTokens("totally-unknown", true), 24_000);
  // gpt-4o compaction: 128000 - min(16384, 12000) = 116000
  assert.equal(effectiveContextWindowTokens("gpt-4o", true), 116_000);
  console.log("model windows: 6 assertions passed");
}

function checkPressure() {
  const t = thresholdsForWindow(24_000);
  assert.deepEqual(t, {
    warning: 13_200,
    auto: 19_200,
    aggressive: 21_000,
    manual: 22_500,
  });

  const model = "totally-unknown-model";
  assert.equal(calculateContextPressure(1_000, model).stage, "normal");
  assert.equal(calculateContextPressure(14_000, model).stage, "warning");
  assert.equal(calculateContextPressure(19_500, model).stage, "auto_compact");
  assert.equal(calculateContextPressure(21_500, model).stage, "aggressive");
  assert.equal(calculateContextPressure(23_000, model).stage, "manual_path");

  const pressure = calculateContextPressure(19_500, model);
  assert.equal(pressure.effectiveWindowTokens, 24_000);
  assert.equal(pressure.remainingTokens, 4_500);
  assert.ok(pressure.utilization > 0.8 && pressure.utilization < 0.82);
  console.log("context pressure: 9 assertions passed");
}

function checkBudget() {
  const budget = defaultContextBudget("totally-unknown-model");
  assert.equal(budget.maxInputTokens, 27_000);
  assert.equal(budget.reservedResponseTokens, 3_000);
  assert.equal(budget.recentTokens, Math.floor(24_000 * 0.22));
  assert.equal(budget.memoryTokens, Math.floor(24_000 * 0.22));
  assert.equal(budget.systemTokens, Math.floor(24_000 * 0.12));
  assert.equal(budget.evidenceTokens, Math.floor(24_000 * 0.34));
  console.log("context budget: 6 assertions passed");
}

function checkCompressMessages() {
  const messages = [
    { role: "system", content: "compact boundary summary" },
    { role: "user", content: "first question" },
    { role: "assistant", content: "first answer" },
    { role: "user", content: "second question" },
    { role: "assistant", content: "second answer" },
    { role: "user", content: "" },
  ];
  const wide = compressMessages(messages, 5_000);
  // system rows and empty content are not eligible
  assert.equal(wide.stats.eligibleMessages, 4);
  assert.equal(wide.stats.keptMessages, 4);
  assert.equal(wide.stats.omittedMessages, 0);
  assert.equal(wide.kept[0].content, "first question");
  assert.equal(wide.kept[wide.kept.length - 1].content, "second answer");

  // a tiny budget keeps only the newest suffix (first message always kept)
  const tiny = compressMessages(messages, 12);
  assert.ok(tiny.stats.keptMessages < 4, "tiny budget drops oldest messages");
  assert.equal(
    tiny.kept[tiny.kept.length - 1].content,
    "second answer",
    "newest message survives",
  );
  assert.ok(tiny.stats.omittedMessages > 0);

  // per-message clipping: a huge message gets truncated to the per-message budget
  const huge = "lorem ipsum dolor sit amet ".repeat(400);
  const clipped = compressMessages([{ role: "user", content: huge }], 5_280);
  assert.equal(clipped.stats.truncatedMessages, 1);
  assert.ok(clipped.kept[0].content.length < huge.length);
  assert.ok(clipped.kept[0].content.endsWith("..."));
  console.log("compressMessages: 10 assertions passed");
}

function checkStagePlans() {
  const auto = compactionPlanForStage("auto_compact");
  assert.deepEqual(auto, {
    keepRecent: 8,
    summaryTokens: 1800,
    modePrefix: "",
  });
  const aggressive = compactionPlanForStage("aggressive");
  assert.equal(aggressive.keepRecent, 4);
  assert.equal(aggressive.summaryTokens, Math.floor(1800 * 0.67));
  assert.equal(aggressive.modePrefix, "aggressive");
  const manual = compactionPlanForStage("manual_path");
  assert.equal(manual.keepRecent, 2);
  assert.equal(manual.summaryTokens, 900);
  assert.equal(manual.modePrefix, "manual_path");
  console.log("stage plans: 7 assertions passed");
}

function checkPreservation() {
  const messages = [
    {
      role: "user",
      content:
        "The build fails in src/lib/retriever.ts:42 with TypeError.\nRun pnpm test to reproduce.\n决定：先修复 rerank 降级路径",
    },
    { role: "assistant", content: "ok" },
  ];
  const candidates = mustPreserveCandidates(messages);
  assert.ok(
    candidates.some((c) => c.includes("src/lib/retriever.ts")),
    "path-like candidate captured",
  );
  assert.ok(
    candidates.some((c) => c.includes("pnpm test")),
    "command line captured",
  );
  assert.ok(
    candidates.some((c) => c.includes("决定")),
    "decision hint line captured",
  );

  const lossy = "The build was fixed.";
  const report = compactionPreservationReport(messages, lossy);
  assert.ok(report.missingCount > 0, "missing facts detected");

  const ensured = ensureCompactionSummaryPreservesKeyFacts(
    messages,
    lossy,
    1800,
  );
  assert.ok(ensured.summary.includes("保真补充"), "appendix added");
  assert.ok(
    ensured.summary.includes("src/lib/retriever.ts"),
    "missing path re-attached",
  );
  assert.equal(ensured.report.appendedMissingCount, report.missingCount);

  const complete = ensureCompactionSummaryPreservesKeyFacts(
    messages,
    ensured.summary,
    1800,
  );
  assert.equal(complete.report.missingCount, 0, "idempotent after appendix");
  console.log("preservation: 7 assertions passed");
}

function checkSummaryBuilding() {
  const messages = [
    { role: "user", content: "why does ci fail?", toolNames: ["list_ci_runs"] },
    { role: "assistant", content: "The workflow failed on pnpm test." },
  ];
  const payload = buildCompactionSummaryPayload(messages);
  assert.ok(payload.includes("user tools=list_ci_runs: why does ci fail?"));
  assert.ok(payload.includes("assistant: The workflow failed"));

  const formatted = formatCompactionSummary(
    "<analysis>thinking</analysis>\n<summary>line1\n\n\n\nline2</summary>",
  );
  assert.ok(formatted.startsWith("摘要："));
  assert.ok(formatted.includes("line1\n\nline2"), "3+ newlines collapsed");
  assert.ok(!formatted.includes("<analysis>"));

  const fallback = fallbackCompactionSummary([
    {
      role: "user",
      content: "请修复 src/a.ts 的报错\n决定：采用方案 B\nTODO: 补充测试",
    },
    {
      role: "assistant",
      content: "已完成修复，这是一条足够长的助手回复内容用于进入事实列表。",
    },
  ]);
  assert.ok(fallback.includes("User intent:"));
  assert.ok(fallback.includes("Durable decisions:"));
  assert.ok(fallback.includes("方案 B"));
  assert.ok(fallback.includes("Pending tasks:"));
  console.log("summary building: 8 assertions passed");
}

function checkBoundaryDetection() {
  assert.equal(
    isCompactBoundaryMessage({
      role: "system",
      meta: { subtype: COMPACT_BOUNDARY_SUBTYPE },
    }),
    true,
  );
  assert.equal(
    isCompactBoundaryMessage({ role: "system", meta: { subtype: "other" } }),
    false,
  );
  assert.equal(
    isCompactBoundaryMessage({
      role: "user",
      meta: { subtype: COMPACT_BOUNDARY_SUBTYPE },
    }),
    false,
  );
  assert.equal(isCompactBoundaryMessage({ role: "system", meta: null }), false);
  console.log("boundary detection: 4 assertions passed");
}

function checkRunEventProjection() {
  const longOutput = "x".repeat(RUN_EVENT_OUTPUT_CHARS + 500);
  const stepDone = toRunEvent({
    type: "step_done",
    index: 2,
    output: longOutput,
  });
  assert.equal(stepDone.type, "step_done");
  assert.equal(stepDone.index, 2);
  assert.ok(
    String(stepDone.output).length <= RUN_EVENT_OUTPUT_CHARS,
    "step output truncated",
  );

  const done = toRunEvent({
    type: "done",
    result: "full report".repeat(100),
    detail: ["a", "b"],
  });
  assert.deepEqual(done, { type: "done" }, "done marker stores no payload");

  const plan = toRunEvent({
    type: "plan_created",
    steps: ["s".repeat(900), "short"],
  });
  assert.ok(String((plan.steps as string[])[0]).length <= 400);
  assert.equal((plan.steps as string[])[1], "short");

  const events: Record<string, unknown>[] = [];
  for (let i = 0; i < MAX_RUN_EVENTS + 50; i += 1) {
    pushRunEvent(events, { type: "step_start", index: i, step: `step ${i}` });
  }
  assert.equal(events.length, MAX_RUN_EVENTS, "event list capped");
  console.log("run event projection: 7 assertions passed");
}

checkModelWindows();
checkPressure();
checkBudget();
checkCompressMessages();
checkStagePlans();
checkPreservation();
checkSummaryBuilding();
checkBoundaryDetection();
checkRunEventProjection();
console.log("\nAll devflow-context-compression smoke checks passed.");
