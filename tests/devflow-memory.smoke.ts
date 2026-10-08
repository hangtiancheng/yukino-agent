/**
 * Offline smoke for the DevFlow memory system (#25) —
 * lib/devflow/memory.ts (ports of DevFlow-AI chat_memory.py
 * SessionSealer, context_compression.py fallback/merge/render helpers and
 * memory_hub.py candidate pipeline) plus the chat citation collectors in
 * lib/devflow/agents/chat.ts.
 *
 *  1. token budget clipping (legacy clip_to_token_budget);
 *  2. order-preserving list dedupe/caps (legacy _unique_preserve_order);
 *  3. deterministic fallback snapshot (legacy fallback_memory_update shape:
 *     recent-message role:content concatenation + keyword buckets);
 *  4. incremental snapshot merge (legacy merge_memory);
 *  5. thread merge counter semantics (只合并 thread 未计数的 sessions);
 *  6. seal threshold predicate;
 *  7. memory-context rendering truncation (legacy render_structured_memory);
 *  8. candidate title generation;
 *  9. citations pure collectors + dedupe;
 * 10. zod safeParse degradation of snapshot payloads.
 *
 * Optional live section (DEVFLOW_MEMORY_SMOKE_PG=1, needs the local
 * PostgreSQL at DATABASE_URL): row-level verification of the no-LLM seal
 * fallback, thread merge counting, the candidate state machine and the read
 * views. Temporary rows are cascade-deleted afterwards.
 *
 * Run: npx tsx tests/devflow-memory.smoke.ts
 */
import assert from "node:assert/strict";
import {
  MEMORY_CONTEXT_LIMITS,
  MEMORY_LIST_LIMITS,
  SEAL_MESSAGE_THRESHOLD,
  MemorySnapshotSchema,
  candidateTitle,
  clipToTokenBudget,
  estimateTokens,
  fallbackSnapshot,
  mergeSnapshots,
  emptySnapshot,
  normalizeSnapshot,
  planThreadMerge,
  renderMemoryContext,
  shouldSeal,
  uniquePreserveOrder,
  type MemorySnapshot,
} from "@/lib/devflow/memory";
import {
  MAX_CITATIONS,
  dedupeCitations,
  knowledgeCitations,
  projectDocCitations,
} from "@/lib/devflow/agents/chat";

// --- 1. token budget --------------------------------------------------------
{
  assert.equal(clipToTokenBudget("", 100), "");
  assert.equal(clipToTokenBudget("short text", 100), "short text");
  const long = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
  const clipped = clipToTokenBudget(long, 50);
  assert.ok(clipped.endsWith("..."), "over-budget text must carry the suffix");
  assert.ok(
    estimateTokens(clipped) <= 50 + 2,
    "clipped text must respect the token budget",
  );
  // CJK counts one token per character (legacy estimate_tokens).
  assert.equal(estimateTokens("中文测试"), 4);
  assert.equal(estimateTokens(""), 0);
  console.log("memory: clipToTokenBudget OK");
}

// --- 2. uniquePreserveOrder --------------------------------------------------
{
  const items = ["  Alpha ", "beta", "alpha", "", "BETA", "gamma"];
  assert.deepEqual(uniquePreserveOrder(items, 16), ["Alpha", "beta", "gamma"]);
  assert.deepEqual(
    uniquePreserveOrder(["a", "b", "c", "d"], 2),
    ["a", "b"],
    "first-N cut (legacy _unique_preserve_order)",
  );
  console.log("memory: uniquePreserveOrder OK");
}

// --- 3. deterministic fallback snapshot -------------------------------------
{
  const snapshot = fallbackSnapshot([
    {
      role: "user",
      content: "Why is the build failing?\nwe decided to use Redis for caching",
    },
    {
      role: "assistant",
      content:
        "The CI log shows an OOM. Next step: bump the runner memory.\nPrefer rolling deploys.",
      toolNames: ["get_ci_run"],
    },
  ]);
  assert.ok(
    snapshot.summary.startsWith("user: "),
    "fallback summary must be the role:content concatenation",
  );
  assert.ok(snapshot.summary.includes("[tools: get_ci_run]"));
  assert.ok(
    snapshot.openQuestions.some((q) => q.includes("build failing")),
    "question lines land in openQuestions",
  );
  assert.ok(
    snapshot.decisions.some((d) => d.toLowerCase().includes("decided")),
    "decision keywords land in decisions",
  );
  assert.ok(
    snapshot.tasks.some((t) => t.toLowerCase().includes("next step")),
    "task keywords land in tasks",
  );
  assert.ok(
    snapshot.userPreferences.some((p) => p.toLowerCase().includes("prefer")),
    "preference keywords land in userPreferences",
  );

  // Only the last FALLBACK_RECENT_MESSAGES ride in the summary.
  const many = Array.from({ length: 30 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `message number ${i}`,
  }));
  const big = fallbackSnapshot(many);
  assert.ok(!big.summary.includes("message number 0"));
  assert.ok(big.summary.includes("message number 29"));
  console.log("memory: fallbackSnapshot OK");
}

// --- 4. mergeSnapshots (legacy merge_memory) --------------------------------
{
  const existing: MemorySnapshot = {
    ...emptySnapshot(),
    summary: "existing state",
    facts: ["fact-a", "fact-b"],
  };
  const update: MemorySnapshot = {
    ...emptySnapshot(),
    summary: "new turn state",
    facts: ["fact-b", "fact-c"],
    decisions: ["use Redis"],
  };
  const merged = mergeSnapshots(existing, update);
  assert.ok(merged.summary.includes("existing state"));
  assert.ok(merged.summary.includes("new turn state"));
  assert.deepEqual(merged.facts, ["fact-a", "fact-b", "fact-c"]);
  assert.deepEqual(merged.decisions, ["use Redis"]);
  // Caps hold on repeated merges.
  let acc = emptySnapshot();
  for (let i = 0; i < 5; i += 1) {
    acc = mergeSnapshots(acc, {
      ...emptySnapshot(),
      facts: Array.from(
        { length: MEMORY_LIST_LIMITS.facts },
        (_, j) => `fact-${i}-${j}`,
      ),
    });
  }
  assert.ok(acc.facts.length <= MEMORY_LIST_LIMITS.facts);
  console.log("memory: mergeSnapshots OK");
}

// --- 5. thread merge counter semantics --------------------------------------
{
  assert.deepEqual(planThreadMerge(0, [2, 3]), {
    shouldMerge: true,
    newSessions: 5,
    totalSessions: 5,
  });
  assert.deepEqual(planThreadMerge(5, [2, 3]), {
    shouldMerge: false,
    newSessions: 0,
    totalSessions: 5,
  });
  assert.deepEqual(planThreadMerge(3, [2, 3]), {
    shouldMerge: true,
    newSessions: 2,
    totalSessions: 5,
  });
  assert.deepEqual(planThreadMerge(0, []), {
    shouldMerge: false,
    newSessions: 0,
    totalSessions: 0,
  });
  console.log("memory: planThreadMerge OK");
}

// --- 6. seal threshold -------------------------------------------------------
{
  assert.equal(shouldSeal(SEAL_MESSAGE_THRESHOLD - 1), false);
  assert.equal(shouldSeal(SEAL_MESSAGE_THRESHOLD), true);
  assert.equal(SEAL_MESSAGE_THRESHOLD, 8);
  console.log("memory: shouldSeal OK");
}

// --- 7. renderMemoryContext truncation ---------------------------------------
{
  assert.equal(renderMemoryContext({ thread: null, conversation: null }), "");
  const conversation: MemorySnapshot = {
    ...emptySnapshot(),
    decisions: Array.from({ length: 20 }, (_, i) => `decision ${i}`),
    openQuestions: Array.from({ length: 20 }, (_, i) => `question ${i}`),
    tasks: Array.from({ length: 20 }, (_, i) => `task ${i}`),
  };
  const rendered = renderMemoryContext({ thread: null, conversation });
  const renderedLines = rendered.split("\n");
  const count = (label: string, limit: number) => {
    const start = renderedLines.indexOf(`${label}:`);
    assert.ok(start >= 0, `${label} section must render`);
    let lines = 0;
    for (let i = start + 1; i < renderedLines.length; i += 1) {
      if (!renderedLines[i].startsWith("- ")) break;
      lines += 1;
    }
    assert.equal(lines, limit, `${label} must be capped at ${limit}`);
  };
  count("Decisions", MEMORY_CONTEXT_LIMITS.conversationDecisions);
  count("Open questions", MEMORY_CONTEXT_LIMITS.conversationOpenQuestions);
  count("Tasks", MEMORY_CONTEXT_LIMITS.conversationTasks);

  const longThread: MemorySnapshot = {
    ...emptySnapshot(),
    summary: Array.from({ length: 300 }, (_, i) => `threadword${i}`).join(" "),
    decisions: ["thread decision"],
    facts: ["thread fact"],
  };
  const withThread = renderMemoryContext({ thread: longThread, conversation });
  assert.ok(withThread.includes("## Repository memory (long-term)"));
  assert.ok(
    withThread.includes("thread decision"),
    "thread decisions render under the cap",
  );
  assert.ok(
    withThread.includes("..."),
    "oversized thread summary must be clipped",
  );
  console.log("memory: renderMemoryContext OK");
}

// --- 8. candidate title -------------------------------------------------------
{
  const title = candidateTitle(
    "decision",
    Array.from({ length: 40 }, (_, i) => `word${i}`).join(" "),
  );
  assert.ok(title.startsWith("decision: "));
  assert.ok(title.endsWith("..."));
  // Legacy _candidate_title: label prefix + content clipped to ~80 chars
  // (legacy _clip keeps limit-1 chars then appends "...", so ≤ limit+2).
  assert.ok(title.slice("decision: ".length).length <= 82);
  console.log("memory: candidateTitle OK");
}

// --- 9. citations collectors ---------------------------------------------------
{
  const knowledge = knowledgeCitations([
    { docName: "runbook.md", score: 0.9 },
    { docName: "", score: 0.8 },
    { docName: "postmortem.md", score: 0.7 },
  ]);
  assert.deepEqual(
    knowledge.map((c) => [c.docName, c.source]),
    [
      ["runbook.md", "knowledge"],
      ["postmortem.md", "knowledge"],
    ],
  );
  const project = projectDocCitations([
    { path: "README.md", score: 0.6 },
    { path: "", score: 0.5 },
  ]);
  assert.equal(project.length, 1);
  assert.equal(project[0].source, "project_docs");

  const deduped = dedupeCitations([
    { docName: "a.md", score: 0.5, source: "knowledge" },
    { docName: "a.md", score: 0.9, source: "knowledge" },
    { docName: "a.md", score: 0.2, source: "project_docs" },
  ]);
  assert.equal(deduped.length, 2);
  assert.deepEqual(deduped[0], {
    docName: "a.md",
    score: 0.9,
    source: "knowledge",
  });

  const flood = Array.from({ length: MAX_CITATIONS + 8 }, (_, i) => ({
    docName: `doc-${i}.md`,
    score: i / 100,
    source: "knowledge",
  }));
  const capped = dedupeCitations(flood);
  assert.equal(capped.length, MAX_CITATIONS);
  assert.equal(capped[0].score, flood[flood.length - 1].score);
  console.log("memory: citations collectors OK");
}

// --- 10. snapshot zod degradation ----------------------------------------------
{
  assert.ok(
    MemorySnapshotSchema.safeParse({
      summary: "s",
      facts: ["f"],
      decisions: ["d"],
      openQuestions: ["q"],
      tasks: ["t"],
      userPreferences: ["p"],
      repoContext: ["r"],
    }).success,
  );
  assert.ok(
    MemorySnapshotSchema.safeParse({ summary: "s" }).success,
    "optional lists tolerate sparse model output",
  );
  assert.equal(
    MemorySnapshotSchema.safeParse({ summary: "s", facts: [1, 2] }).success,
    false,
    "garbage arrays fail safeParse and degrade to the fallback",
  );
  const normalized = normalizeSnapshot({ summary: " ok ", facts: ["x"] });
  assert.equal(normalized.summary, "ok");
  assert.deepEqual(normalized.decisions, []);
  console.log("memory: MemorySnapshotSchema OK");
}

console.log("devflow-memory smoke: all offline checks passed");

// --- Optional live section (row-level verification against local PG) ----------
if (process.env.DEVFLOW_MEMORY_SMOKE_PG === "1") {
  const { prisma } = await import("@/lib/db");
  const { ensureConversation, appendMessage } =
    await import("@/lib/devflow/conversations");
  const {
    approveMemoryCandidate,
    getRepoMemoryOverview,
    listMemoryCandidates,
    maybeSealAndMerge,
    mergeThreadMemory,
    proposeMemoryCandidate,
    rejectMemoryCandidate,
    sealConversation,
  } = await import("@/lib/devflow/memory");

  const suffix = Date.now().toString(36);
  const repo = await prisma.repository.create({
    data: {
      owner: "memory-smoke",
      name: `temp-${suffix}`,
      fullName: `memory-smoke/temp-${suffix}`,
    },
  });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    const conversation = await ensureConversation(repo.id);

    // Eight messages cross the seal threshold.
    for (let i = 0; i < 8; i += 1) {
      await appendMessage({
        conversationId: conversation.id,
        repoId: repo.id,
        role: i % 2 === 0 ? "user" : "assistant",
        content:
          i === 0
            ? "Why does the deploy fail?\nwe decided to gate deploys on CI"
            : `Working on the deploy issue, step ${i}. Next step: check logs.`,
      });
    }

    // No LLM key in this environment → deterministic fallback seal.
    const sealed = await maybeSealAndMerge(repo.id, conversation.id);
    assert.equal(sealed, true, "8 messages must trigger the first seal");
    const convMemory = await prisma.conversationMemory.findUniqueOrThrow({
      where: { conversationId: conversation.id },
    });
    assert.equal(convMemory.sessionsIncorporated, 1);
    assert.ok(
      convMemory.summary.trim().length > 0,
      "deterministic fallback must produce a summary",
    );
    assert.ok(
      convMemory.summary.includes("user: ") ||
        convMemory.summary.includes("assistant: "),
      "fallback summary keeps the role:content shape",
    );
    const threadMemory = await prisma.threadMemory.findUniqueOrThrow({
      where: { repoId: repo.id },
    });
    assert.equal(threadMemory.sessionsIncorporated, 1);

    // Immediately again: no new messages → no seal.
    assert.equal(
      await maybeSealAndMerge(repo.id, conversation.id),
      false,
      "already-sealed conversation must not reseal",
    );
    const idempotent = await mergeThreadMemory(repo.id);
    assert.equal(
      idempotent.skipped,
      true,
      "thread merge must skip the delta 0",
    );

    // Eight more messages → second seal, counter advances to 2.
    await sleep(5);
    for (let i = 0; i < 8; i += 1) {
      await appendMessage({
        conversationId: conversation.id,
        repoId: repo.id,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Follow-up turn ${i}: deploy fixed by restarting the runner.`,
      });
    }
    assert.equal(await maybeSealAndMerge(repo.id, conversation.id), true);
    const convMemory2 = await prisma.conversationMemory.findUniqueOrThrow({
      where: { conversationId: conversation.id },
    });
    assert.equal(convMemory2.sessionsIncorporated, 2);
    const threadMemory2 = await prisma.threadMemory.findUniqueOrThrow({
      where: { repoId: repo.id },
    });
    assert.equal(threadMemory2.sessionsIncorporated, 2);

    // Candidate state machine.
    const proposed = await proposeMemoryCandidate({
      repoId: repo.id,
      conversationId: conversation.id,
      kind: "decision",
      title: "Deploy gate decision",
      content: "Deploys are gated on CI results.",
    });
    assert.equal(proposed.deduped, false);
    assert.equal(proposed.candidate.status, "pending");
    const duplicate = await proposeMemoryCandidate({
      repoId: repo.id,
      kind: "decision",
      content: "Deploys are gated on CI results.",
    });
    assert.equal(
      duplicate.deduped,
      true,
      "identical pending candidate dedupes",
    );

    const second = await proposeMemoryCandidate({
      repoId: repo.id,
      kind: "fact",
      content: "Runner OOMs above 2GB.",
    });

    const approved = await approveMemoryCandidate(
      repo.id,
      proposed.candidate.id,
    );
    assert.ok(approved, "approve must find the candidate");
    assert.equal(approved.candidate.status, "approved");
    assert.ok(approved.candidate.reviewedAt);
    assert.ok(
      ["ready", "skipped", "failed"].includes(approved.kbStatus),
      "kbStatus reports the KB indexing outcome",
    );
    if (approved.kbStatus === "failed") {
      assert.ok(
        approved.kbError,
        "failed KB indexing records the error in the response",
      );
    }
    // Idempotent re-approval.
    const again = await approveMemoryCandidate(repo.id, proposed.candidate.id);
    assert.equal(again?.candidate.status, "approved");

    const rejected = await rejectMemoryCandidate(repo.id, second.candidate.id);
    assert.equal(rejected?.status, "rejected");
    assert.ok(rejected?.reviewedAt);

    assert.equal(await approveMemoryCandidate(repo.id, "missing-id"), null);
    assert.equal(await rejectMemoryCandidate(repo.id, "missing-id"), null);

    const pending = await listMemoryCandidates(repo.id, { status: "pending" });
    const all = await listMemoryCandidates(repo.id, { status: "all" });
    assert.ok(all.length >= 2);
    assert.ok(pending.every((c) => c.status === "pending"));

    // Read views.
    const overview = await getRepoMemoryOverview(repo.id);
    assert.ok(overview.thread);
    assert.equal(overview.thread.sessionsIncorporated, 2);
    assert.equal(overview.conversations.length, 1);
    assert.equal(overview.conversations[0].conversationId, conversation.id);

    // sealConversation on an empty/missing conversation degrades to null.
    assert.equal(await sealConversation("missing-conversation"), null);

    console.log("DEVFLOW_MEMORY_SMOKE_PG: seal/merge/candidates/views OK");
  } finally {
    // Everything above is repo-scoped and cascade-deletes.
    await prisma.repository.delete({ where: { id: repo.id } });
    await prisma.$disconnect();
  }
  console.log("devflow-memory smoke: live PG section passed");
} else {
  console.log(
    "devflow-memory smoke: skipping live PG section (set DEVFLOW_MEMORY_SMOKE_PG=1 to run)",
  );
}
