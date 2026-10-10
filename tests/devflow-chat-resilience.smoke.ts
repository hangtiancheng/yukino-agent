import assert from "node:assert/strict";
import {
  MAX_REPEATED_TOOL_CALLS,
  TOOL_RETRY_ATTEMPTS,
  HISTORY_RETRY_LIMIT,
  ToolLoopGuard,
  buildEmptyAnswerFallback,
  classifyToolError,
  duplicateCallObservation,
  executeWithRetry,
  isContextOverflowError,
  isRetriableToolError,
  toolCallFingerprint,
  toolErrorObservation,
} from "@/lib/devflow/agents/chat";

{
  const a = toolCallFingerprint("list_issues", { state: "open", limit: 20 });
  const b = toolCallFingerprint("list_issues", { limit: 20, state: "open" });
  assert.equal(a, b, "key order must not change the fingerprint");
  assert.equal(a.startsWith("list_issues:"), true);

  assert.notEqual(
    toolCallFingerprint("list_issues", { limit: 20 }),
    toolCallFingerprint("list_pulls", { limit: 20 }),
    "different tool names must not collide",
  );
  assert.notEqual(
    toolCallFingerprint("list_issues", { limit: 20 }),
    toolCallFingerprint("list_issues", { limit: 21 }),
    "different values must not collide",
  );

  const nested1 = toolCallFingerprint("t", {
    outer: { y: 1, x: [3, { q: 1, p: 2 }] },
  });
  const nested2 = toolCallFingerprint("t", {
    outer: { x: [3, { p: 2, q: 1 }], y: 1 },
  });
  assert.equal(nested1, nested2, "nested key order must be canonicalized");

  assert.equal(toolCallFingerprint("t", undefined), "t:null");
  assert.equal(
    toolCallFingerprint("t", { n: BigInt(10) }),
    toolCallFingerprint("t", { n: 10 }),
    "bigint must canonicalize like JSON number",
  );
}

{
  assert.equal(MAX_REPEATED_TOOL_CALLS, 2, "legacy threshold");
  const guard = new ToolLoopGuard();
  const input = { query: "flaky ci", topK: 5 };

  const v1 = guard.check("search_knowledge", input);
  assert.deepEqual(
    { blocked: v1.blocked, repeatCount: v1.repeatCount },
    { blocked: false, repeatCount: 1 },
  );
  const v2 = guard.check("search_knowledge", { topK: 5, query: "flaky ci" });
  assert.deepEqual(
    { blocked: v2.blocked, repeatCount: v2.repeatCount },
    { blocked: false, repeatCount: 2 },
  );
  const v3 = guard.check("search_knowledge", input);
  assert.deepEqual(
    { blocked: v3.blocked, repeatCount: v3.repeatCount },
    { blocked: true, repeatCount: 3 },
    "the 3rd identical call must be short-circuited",
  );
  assert.equal(v3.fingerprint, toolCallFingerprint("search_knowledge", input));

  const other = guard.check("search_knowledge", { query: "other", topK: 5 });
  assert.equal(other.blocked, false);
  const otherSame = guard.check("list_issues", input);
  assert.equal(otherSame.blocked, false, "name is part of the fingerprint");
}

{
  const abortError = new Error("This operation was aborted");
  abortError.name = "AbortError";
  assert.equal(classifyToolError(abortError), "timeout");

  const timeoutError = new Error("operation did not finish");
  timeoutError.name = "TimeoutError";
  assert.equal(classifyToolError(timeoutError), "timeout");

  assert.equal(
    classifyToolError({ name: "AbortError", message: "aborted" }),
    "timeout",
  );

  assert.equal(classifyToolError(new Error("request timed out")), "timeout");
  assert.equal(classifyToolError(new Error("deadline exceeded")), "timeout");

  assert.equal(
    classifyToolError(new Error("429 Too Many Requests")),
    "rate_limited",
  );
  assert.equal(
    classifyToolError(new Error("rate limit exceeded")),
    "rate_limited",
  );

  const fetchFailed = new TypeError("fetch failed", {
    cause: new Error("read ECONNRESET"),
  });
  assert.equal(classifyToolError(fetchFailed), "transient_network");
  assert.equal(
    classifyToolError(new Error("socket hang up")),
    "transient_network",
  );
  assert.equal(
    classifyToolError(new Error("503 Service Unavailable")),
    "transient_network",
  );

  assert.equal(
    classifyToolError(new Error("403 Forbidden")),
    "permission_denied",
  );
  assert.equal(classifyToolError("Error 404: item missing"), "data_not_found");
  assert.equal(
    classifyToolError(new Error("output failed schema validation")),
    "model_output_invalid",
  );
  assert.equal(classifyToolError(new Error("boom")), "tool_runtime_error");

  assert.equal(isRetriableToolError("timeout"), true);
  assert.equal(isRetriableToolError("rate_limited"), true);
  assert.equal(isRetriableToolError("transient_network"), true);
  for (const kind of [
    "unknown_tool",
    "permission_denied",
    "data_not_found",
    "model_output_invalid",
    "tool_runtime_error",
  ] as const) {
    assert.equal(isRetriableToolError(kind), false, `${kind} must not retry`);
  }
}

{
  assert.equal(TOOL_RETRY_ATTEMPTS, 1, "legacy retry budget");

  const ok = await executeWithRetry(async () => "value");
  assert.deepEqual(ok, { ok: true, value: "value", attempts: 1 });

  let calls = 0;
  const recovered = await executeWithRetry(async () => {
    calls += 1;
    if (calls === 1) throw new Error("429 Too Many Requests");
    return "second wins";
  });
  assert.deepEqual(recovered, {
    ok: true,
    value: "second wins",
    attempts: 2,
  });
  assert.equal(calls, 2);

  calls = 0;
  const exhausted = await executeWithRetry(async () => {
    calls += 1;
    throw new Error("upstream timed out");
  });
  assert.equal(exhausted.ok, false);
  if (!exhausted.ok) {
    assert.equal(exhausted.errorKind, "timeout");
    assert.equal(exhausted.retryable, true);
    assert.equal(exhausted.attempts, 2, "exactly one automatic retry");
  }
  assert.equal(
    calls,
    2,
    "retriable failure runs at most 1 + TOOL_RETRY_ATTEMPTS",
  );

  calls = 0;
  const hard = await executeWithRetry(async () => {
    calls += 1;
    throw new Error("Issue #7 not found");
  });
  assert.equal(hard.ok, false);
  if (!hard.ok) {
    assert.equal(hard.errorKind, "data_not_found");
    assert.equal(hard.retryable, false);
    assert.equal(hard.attempts, 1, "non-retriable failures never re-run");
  }
  assert.equal(calls, 1);
}

{
  const guard = new ToolLoopGuard();
  guard.check("get_issue", { number: 3 });
  guard.check("get_issue", { number: 3 });
  const verdict = guard.check("get_issue", { number: 3 });
  assert.equal(verdict.blocked, true);
  const blocked = duplicateCallObservation("get_issue", verdict);
  assert.equal(blocked.route, "tool_loop_guard");
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.duplicate, true);
  assert.equal(typeof blocked.answer, "string");
  assert.match(String(blocked.answer), /duplicate call blocked/i);
  assert.equal(blocked.repeat_count, 3);

  const failure = await executeWithRetry<string>(async () => {
    throw new Error("fetch failed");
  });
  assert.equal(failure.ok, false);
  if (failure.ok) throw new Error("unreachable");
  const observed = toolErrorObservation("list_ci_runs", failure);
  assert.equal(observed.route, "tool_error");
  assert.equal(observed.error_kind, "transient_network");
  assert.equal(observed.retryable, true);
  assert.equal(observed.attempts, 2);
  assert.match(
    String(observed.answer),
    /Tool list_ci_runs failed: fetch failed/,
  );
}

{
  const withTools = buildEmptyAnswerFallback({
    toolNames: ["list_issues", "get_ci_run", "list_issues", "search_knowledge"],
    withToolsTemplate: "Queried {tools}, but reached no conclusion.",
    noToolsTemplate: "no-tools fallback",
  });
  assert.equal(
    withTools,
    "Queried list_issues, get_ci_run, search_knowledge, but reached no conclusion.",
    "names must dedupe, keep first-seen order, and fill the {tools} slot",
  );
  assert.equal(withTools.includes("{tools}"), false);

  const noTools = buildEmptyAnswerFallback({
    toolNames: [],
    withToolsTemplate: "Queried {tools}.",
    noToolsTemplate: "The model returned no answer this turn.",
  });
  assert.equal(noTools, "The model returned no answer this turn.");
}

{
  assert.equal(HISTORY_RETRY_LIMIT, 8, "degraded history budget");
  assert.equal(
    isContextOverflowError(
      new Error("400 This model's maximum context length is 8192 tokens."),
    ),
    true,
  );
  assert.equal(
    isContextOverflowError(new Error("context_length_exceeded")),
    true,
  );
  assert.equal(isContextOverflowError(new Error("Prompt is too long")), true);
  assert.equal(isContextOverflowError(new Error("request too large")), true);
  assert.equal(isContextOverflowError(new Error("invalid api key")), false);
  assert.equal(isContextOverflowError(new Error("429 rate limit")), false);
}

if (process.env.DEVFLOW_CHAT_SMOKE_PG === "1") {
  const { prisma } = await import("@/lib/db");
  const { appendMessage, ensureConversation, listMessages } =
    await import("@/lib/devflow/conversations");

  const stamp = Date.now();
  const repo = await prisma.repository.create({
    data: {
      owner: "smoke",
      name: `chat-resilience-${stamp}`,
      fullName: `smoke/chat-resilience-${stamp}`,
    },
  });
  try {
    const conversation = await ensureConversation(repo.id);
    await appendMessage({
      conversationId: conversation.id,
      repoId: repo.id,
      role: "user",
      content: "trigger a failure",
    });
    await appendMessage({
      conversationId: conversation.id,
      repoId: repo.id,
      role: "assistant",
      content: "Request failed: upstream timed out",
      toolCalls: [{ name: "list_issues", input: { state: "open", limit: 20 } }],
      meta: { error: true, reason: "upstream timed out" },
    });

    const messages = await listMessages(conversation.id, 20);
    assert.equal(messages.length, 2);
    const failure = messages[1];
    assert.equal(failure.role, "assistant");
    assert.equal(
      (failure.meta as { error?: unknown } | null)?.error,
      true,
      "meta.error must round-trip so the UI can style the failure turn",
    );
    assert.equal(
      (failure.meta as { reason?: unknown } | null)?.reason,
      "upstream timed out",
    );

    const fresh = await prisma.conversation.findUnique({
      where: { id: conversation.id },
    });
    assert.equal(fresh?.messageCount, 2, "touch_conversation count parity");
  } finally {
    await prisma.chatMessage.deleteMany({ where: { repoId: repo.id } });
    await prisma.conversation.deleteMany({ where: { repoId: repo.id } });
    await prisma.repository.delete({ where: { id: repo.id } });
  }
  console.log("DEVFLOW_CHAT_SMOKE_PG: failure-turn persistence OK");
}

console.log("DEVFLOW-CHAT-RESILIENCE SMOKE OK");
