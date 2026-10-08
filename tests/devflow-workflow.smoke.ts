// Offline smoke test for the DevFlow multi-agent workflow orchestration
// (no DB, no LLM, no Milvus). Asserts the deterministic ports of the legacy
// Python subsystem: claim-boundary validation (planner_agent.py claim scope),
// task-graph scheduling (workflow_orchestrator.py _run_task_graph topology +
// parallel cap), deterministic planner fallback spec, observer findings and
// confidence synthesis (observer_agent.py), replan gating (≤2 rounds), and the
// deterministic decision memo (synthesis_agent.py).
// Run: npx tsx tests/devflow-workflow.smoke.ts
import assert from "node:assert/strict";
import {
  MAX_REPLANS,
  WorkflowObservationSchema,
  WorkflowSpecSchema,
  agentNameForTaskType,
  deterministicMemo,
  deterministicPlanSpec,
  observeWorkflow,
  replanClaims,
  resolveClaimEntity,
  scheduleClaims,
  shouldReplan,
  synthesize,
  validateClaims,
  type EntitySnapshot,
  type WorkflowClaim,
  type WorkflowObservation,
  type WorkflowSpec,
  type WorkflowTaskResult,
} from "@/lib/devflow/agents/workflow";
import { llmConfigured } from "@/lib/devflow/agents/analysis";

let checks = 0;
function check(label: string, fn: () => void | Promise<void>) {
  const result = fn();
  checks += 1;
  if (result instanceof Promise) {
    throw new Error("use checkAsync for async checks");
  }
  console.log(`ok - ${label}`);
}

async function checkAsync(label: string, fn: () => Promise<void>) {
  await fn();
  checks += 1;
  console.log(`ok - ${label}`);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const snapshot: EntitySnapshot = {
  repoId: "repo-1",
  fullName: "acme/widgets",
  issues: [
    { id: "issue-1", number: 12, title: "Login returns 500", state: "open" },
    { id: "issue-2", number: 7, title: "Old report", state: "closed" },
  ],
  pullRequests: [
    {
      id: "pr-1",
      number: 34,
      title: "Fix login",
      state: "open",
      merged: false,
    },
    { id: "pr-2", number: 30, title: "Done", state: "closed", merged: true },
  ],
  workflowRuns: [
    { id: "run-1", githubRunId: "999", name: "ci", conclusion: "failure" },
    { id: "run-2", githubRunId: "998", name: "release", conclusion: "success" },
  ],
};

function makeClaim(overrides: Partial<WorkflowClaim> = {}): WorkflowClaim {
  return {
    id: "issue_analysis",
    entity_type: "issue",
    entity_ref: "12",
    task_type: "issue_analysis",
    acceptance_criteria: ["Priority assigned with evidence"],
    ...overrides,
  };
}

function makeResult(
  overrides: Partial<WorkflowTaskResult> = {},
): WorkflowTaskResult {
  return {
    taskId: "issue_analysis",
    agentName: "issue_analyst_agent",
    taskType: "issue_analysis",
    entityType: "issue",
    entityRef: "12",
    status: "success",
    summary: "Triage complete.",
    confidence: 0.8,
    evidenceCount: 2,
    output: { priority: "P2" },
    error: null,
    startedAt: "2026-10-06T00:00:00.000Z",
    completedAt: "2026-10-06T00:00:05.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// WorkflowSpec schema
// ---------------------------------------------------------------------------

check("spec schema: accepts a bounded spec", () => {
  const spec: WorkflowSpec = {
    goal: "Assess release readiness",
    claims: [makeClaim()],
  };
  assert.deepEqual(WorkflowSpecSchema.parse(spec), spec);
});

check(
  "spec schema: rejects unknown entity_type and empty acceptance_criteria",
  () => {
    assert.equal(
      WorkflowSpecSchema.safeParse({
        goal: "g",
        claims: [makeClaim({ entity_type: "branch" as never })],
      }).success,
      false,
    );
    assert.equal(
      WorkflowSpecSchema.safeParse({
        goal: "g",
        claims: [makeClaim({ acceptance_criteria: [] })],
      }).success,
      false,
    );
  },
);

// ---------------------------------------------------------------------------
// Claim validation (assignment: reject vague / out-of-bounds claims)
// ---------------------------------------------------------------------------

check(
  "resolveClaimEntity: number, #number, run id, run name, repo id and fullName",
  () => {
    assert.equal(
      resolveClaimEntity(makeClaim({ entity_ref: "12" }), snapshot)?.id,
      "issue-1",
    );
    assert.equal(
      resolveClaimEntity(makeClaim({ entity_ref: "#12" }), snapshot)?.id,
      "issue-1",
    );
    assert.equal(
      resolveClaimEntity(
        makeClaim({
          entity_type: "pull_request",
          entity_ref: "34",
          task_type: "pr_review",
        }),
        snapshot,
      )?.id,
      "pr-1",
    );
    assert.equal(
      resolveClaimEntity(
        makeClaim({
          id: "ci",
          entity_type: "workflow_run",
          entity_ref: "run-1",
          task_type: "ci_debug",
        }),
        snapshot,
      )?.id,
      "run-1",
    );
    assert.equal(
      resolveClaimEntity(
        makeClaim({
          id: "ci",
          entity_type: "workflow_run",
          entity_ref: "999",
          task_type: "ci_debug",
        }),
        snapshot,
      )?.id,
      "run-1",
    );
    assert.equal(
      resolveClaimEntity(
        makeClaim({
          id: "ci",
          entity_type: "workflow_run",
          entity_ref: "release",
          task_type: "ci_debug",
        }),
        snapshot,
      )?.id,
      "run-2",
    );
    assert.equal(
      resolveClaimEntity(
        makeClaim({
          id: "health",
          entity_type: "repository",
          entity_ref: "acme/widgets",
          task_type: "repo_health",
        }),
        snapshot,
      )?.id,
      "repo-1",
    );
  },
);

check("validateClaims: out-of-bounds entity_ref is rejected", () => {
  const { claims, violations } = validateClaims(
    { goal: "g", claims: [makeClaim({ entity_ref: "999" })] },
    snapshot,
  );
  assert.equal(claims.length, 0);
  assert.equal(violations.length, 1);
  assert.match(violations[0].reason, /out-of-bounds/);
});

check(
  "validateClaims: vague claims (empty ref) and mismatched task_type are rejected",
  () => {
    const { claims, violations } = validateClaims(
      {
        goal: "g",
        claims: [
          makeClaim({ id: "vague", entity_ref: "   " }),
          makeClaim({
            id: "mismatch",
            entity_type: "issue",
            task_type: "pr_review",
          }),
        ],
      },
      snapshot,
    );
    assert.equal(claims.length, 0);
    assert.equal(violations.length, 2);
    assert.match(violations[0].reason, /vague/);
    assert.match(violations[1].reason, /does not match/);
  },
);

check(
  "validateClaims: duplicate ids rejected, valid claims kept in order",
  () => {
    const { claims, violations } = validateClaims(
      {
        goal: "g",
        claims: [
          makeClaim({ id: "a" }),
          makeClaim({ id: "a", entity_ref: "#12" }),
          makeClaim({
            id: "b",
            entity_type: "pull_request",
            entity_ref: "34",
            task_type: "pr_review",
          }),
        ],
      },
      snapshot,
    );
    assert.deepEqual(
      claims.map((c) => c.id),
      ["a", "b"],
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0].reason, /duplicate/);
  },
);

// ---------------------------------------------------------------------------
// Deterministic planner fallback (assignment: one claim each for open issues /
// failed CI / open PRs)
// ---------------------------------------------------------------------------

check(
  "deterministicPlanSpec: one claim each for open issue, failed CI, open PR",
  () => {
    const spec = deterministicPlanSpec("Assess readiness", snapshot);
    assert.equal(spec.goal, "Assess readiness");
    assert.deepEqual(
      spec.claims.map((c) => [c.id, c.entity_type, c.entity_ref, c.task_type]),
      [
        ["issue_analysis", "issue", "12", "issue_analysis"],
        ["ci_debug", "workflow_run", "run-1", "ci_debug"],
        ["pr_review", "pull_request", "34", "pr_review"],
      ],
    );
    for (const claim of spec.claims) {
      assert.ok(claim.acceptance_criteria.length > 0);
    }
    // The deterministic spec must pass its own validator.
    assert.equal(validateClaims(spec, snapshot).violations.length, 0);
  },
);

check("deterministicPlanSpec: skips categories with no signal", () => {
  const quiet: EntitySnapshot = {
    ...snapshot,
    issues: [{ id: "issue-2", number: 7, title: "Old", state: "closed" }],
    pullRequests: [
      { id: "pr-2", number: 30, title: "Done", state: "closed", merged: true },
    ],
    workflowRuns: [
      {
        id: "run-2",
        githubRunId: "998",
        name: "release",
        conclusion: "success",
      },
    ],
  };
  const spec = deterministicPlanSpec("Anything to do?", quiet);
  assert.equal(spec.claims.length, 0);
});

check("agentNameForTaskType maps to the legacy agent names", () => {
  assert.equal(agentNameForTaskType("issue_analysis"), "issue_analyst_agent");
  assert.equal(agentNameForTaskType("pr_review"), "pr_review_agent");
  assert.equal(agentNameForTaskType("ci_debug"), "ci_debug_agent");
  assert.equal(agentNameForTaskType("repo_health"), "repo_health_agent");
});

// ---------------------------------------------------------------------------
// Task graph scheduling (legacy _run_task_graph; assignment topology:
// same entity sequential, different entities parallel, cap 3)
// ---------------------------------------------------------------------------

check("scheduleClaims: same entity stays sequential, waves capped at 3", () => {
  const claims: WorkflowClaim[] = [
    makeClaim({ id: "a1", entity_ref: "12" }),
    makeClaim({ id: "a2", entity_ref: "#12" }),
    makeClaim({
      id: "b1",
      entity_type: "pull_request",
      entity_ref: "34",
      task_type: "pr_review",
    }),
    makeClaim({
      id: "c1",
      entity_type: "workflow_run",
      entity_ref: "run-1",
      task_type: "ci_debug",
    }),
    makeClaim({
      id: "d1",
      entity_type: "workflow_run",
      entity_ref: "run-2",
      task_type: "ci_debug",
    }),
    makeClaim({
      id: "e1",
      entity_type: "repository",
      entity_ref: "repo-1",
      task_type: "repo_health",
    }),
  ];
  const waves = scheduleClaims(claims);
  // Entity groups: issue(12)=[a1,a2], pr=[b1], run-1=[c1], run-2=[d1], repo=[e1]
  // wave1 = [a1,b1,c1] (cap 3), wave2 = [d1,e1,a2]... heads are chunked:
  assert.equal(waves.length, 3);
  assert.deepEqual(
    waves[0].map((c) => c.id),
    ["a1", "b1", "c1"],
  );
  assert.deepEqual(
    waves[1].map((c) => c.id),
    ["d1", "e1"],
  );
  assert.deepEqual(
    waves[2].map((c) => c.id),
    ["a2"],
  );
  // Hard invariants: no wave exceeds the cap; the same entity is never
  // scheduled twice within one wave; per-entity order preserved across waves.
  for (const wave of waves) {
    assert.ok(wave.length <= 3);
    const keys = wave.map(
      (c) => `${c.entity_type}:${c.entity_ref.replace("#", "")}`,
    );
    assert.equal(
      new Set(keys).size,
      keys.length,
      "same entity scheduled twice within one wave",
    );
  }
  assert.ok(
    waves.findIndex((w) => w.some((c) => c.id === "a1")) <
      waves.findIndex((w) => w.some((c) => c.id === "a2")),
  );
});

check(
  "scheduleClaims: five single-claim entities split into waves of 3+2",
  () => {
    const claims: WorkflowClaim[] = [1, 2, 3, 4, 5].map((n) =>
      makeClaim({
        id: `issue-${n}`,
        entity_type: "issue",
        entity_ref: String(n),
        task_type: "issue_analysis",
      }),
    );
    // Only issue 12 exists in the snapshot; scheduling is purely structural,
    // refs need not resolve here (validation is a separate gate).
    const waves = scheduleClaims(claims);
    assert.deepEqual(
      waves.map((w) => w.length),
      [3, 2],
    );
  },
);

// ---------------------------------------------------------------------------
// Observer (legacy observer_agent.py + assignment rule P0/P1 → blocker)
// ---------------------------------------------------------------------------

check("observe: failed task → blocker, skipped task → warning", () => {
  const observation = observeWorkflow({ goal: "g", claims: [] }, [
    makeResult({
      taskId: "t1",
      status: "failed",
      error: "boom",
      confidence: null,
      evidenceCount: 0,
    }),
    makeResult({
      taskId: "t2",
      status: "skipped",
      confidence: 0,
      evidenceCount: 0,
    }),
  ]);
  const types = observation.findings.map((f) => [f.finding_type, f.severity]);
  assert.deepEqual(types, [
    ["task_failed", "blocker"],
    ["task_skipped", "warning"],
  ]);
  assert.equal(observation.human_review_required, true);
  WorkflowObservationSchema.parse(observation);
});

check("observe: P0/P1 triage → blocker, P2 → no priority finding", () => {
  const p0 = observeWorkflow({ goal: "g", claims: [] }, [
    makeResult({
      output: { priority: "P0" },
      confidence: 0.9,
      evidenceCount: 1,
    }),
  ]);
  assert.ok(
    p0.findings.some(
      (f) =>
        f.finding_type === "high_priority_issue" && f.severity === "blocker",
    ),
  );
  const p2 = observeWorkflow({ goal: "g", claims: [] }, [
    makeResult({
      output: { priority: "P2" },
      confidence: 0.9,
      evidenceCount: 1,
    }),
  ]);
  assert.equal(p2.findings.length, 0);
});

check("observe: CI merge gate + PR blocking + cross-agent conflict", () => {
  const ci = makeResult({
    taskId: "ci",
    agentName: "ci_debug_agent",
    taskType: "ci_debug",
    entityType: "workflow_run",
    entityRef: "run-1",
    output: { is_merge_blocking: true, debug_steps: ["Rerun the flaky job"] },
    confidence: 0.7,
    evidenceCount: 3,
  });
  const pr = makeResult({
    taskId: "pr",
    agentName: "pr_review_agent",
    taskType: "pr_review",
    entityType: "pull_request",
    entityRef: "34",
    output: {
      merge_recommendation: "approve",
      blocking_issues: ["Secret committed"],
    },
    confidence: 0.7,
    evidenceCount: 2,
  });
  const observation = observeWorkflow({ goal: "g", claims: [] }, [ci, pr]);
  const types = observation.findings.map((f) => f.finding_type).sort();
  assert.deepEqual(types, [
    "ci_merge_gate",
    "cross_agent_conflict",
    "pr_blocking_issues",
  ]);
  assert.equal(observation.human_review_required, true);
});

check("observe: evidence gap and low confidence warnings", () => {
  const observation = observeWorkflow({ goal: "g", claims: [] }, [
    makeResult({ confidence: 0.3, evidenceCount: 0 }),
  ]);
  const types = observation.findings.map((f) => [f.finding_type, f.severity]);
  assert.deepEqual(types, [
    ["evidence_gap", "warning"],
    ["low_confidence", "warning"],
  ]);
});

check(
  "observe: confidence synthesis follows the legacy formula and clamps",
  () => {
    // base mean(0.8, 0.4) = 0.6; one blocker (P0) −0.2, one warning (low conf) −0.05
    const observation = observeWorkflow({ goal: "g", claims: [] }, [
      makeResult({
        taskId: "t1",
        output: { priority: "P0" },
        confidence: 0.8,
        evidenceCount: 1,
      }),
      makeResult({
        taskId: "t2",
        entityRef: "34",
        taskType: "pr_review",
        entityType: "pull_request",
        output: {},
        confidence: 0.4,
        evidenceCount: 1,
      }),
    ]);
    assert.equal(observation.overall_confidence, 0.35);
    // No successful results → base 0.55; clamped floor at 0.1 with many blockers.
    const empty = observeWorkflow({ goal: "g", claims: [] }, []);
    assert.equal(empty.overall_confidence, 0.55);
    const failing = observeWorkflow(
      { goal: "g", claims: [] },
      [1, 2, 3, 4].map((n) =>
        makeResult({
          taskId: `t${n}`,
          status: "failed",
          error: "x",
          confidence: null,
          evidenceCount: 0,
        }),
      ),
    );
    assert.equal(failing.overall_confidence, 0.1);
  },
);

// ---------------------------------------------------------------------------
// Replan gating (legacy orchestrator _max_replans clamp; assignment ≤2)
// ---------------------------------------------------------------------------

check("shouldReplan: blocker + budget → true; budget exhausted → false", () => {
  const blockerObservation: WorkflowObservation = {
    findings: [
      {
        finding_type: "task_failed",
        severity: "blocker",
        message: "m",
        claim_ids: [],
        recommendation: "r",
      },
    ],
    overall_confidence: 0.3,
    human_review_required: true,
    summary: "s",
  };
  assert.equal(MAX_REPLANS, 2);
  assert.equal(shouldReplan(blockerObservation, 0), true);
  assert.equal(shouldReplan(blockerObservation, 1), true);
  assert.equal(shouldReplan(blockerObservation, 2), false);
  const clean: WorkflowObservation = { ...blockerObservation, findings: [] };
  assert.equal(shouldReplan(clean, 0), false);
});

check(
  "replanClaims: adds claims for uncovered strong signals with unique ids",
  () => {
    const spec = deterministicPlanSpec("g", snapshot);
    // Everything strong is already covered → nothing to add.
    assert.deepEqual(replanClaims(spec, snapshot), []);

    const narrow: WorkflowSpec = {
      goal: "g",
      claims: [makeClaim({ id: "issue_analysis", entity_ref: "12" })],
    };
    const extra = replanClaims(narrow, snapshot);
    assert.deepEqual(
      extra.map((c) => [c.id, c.entity_type, c.entity_ref]),
      [
        ["ci_debug", "workflow_run", "run-1"],
        ["pr_review", "pull_request", "34"],
      ],
    );

    // Id collision → unique suffix (legacy planner _unique_task_id).
    const colliding: WorkflowSpec = {
      goal: "g",
      claims: [
        makeClaim({ id: "issue_analysis", entity_ref: "7" }),
        makeClaim({
          id: "ci_debug",
          entity_type: "workflow_run",
          entity_ref: "run-2",
          task_type: "ci_debug",
        }),
      ],
    };
    const extra2 = replanClaims(colliding, snapshot);
    const ids = extra2.map((c) => c.id);
    assert.ok(
      ids.includes("issue_analysis_2"),
      `expected unique issue id, got ${ids}`,
    );
    assert.ok(ids.includes("ci_debug_2"), `expected unique ci id, got ${ids}`);
  },
);

// ---------------------------------------------------------------------------
// Synthesis (legacy synthesis_agent.py deterministic template)
// ---------------------------------------------------------------------------

check("deterministicMemo: sections, decision and next steps", () => {
  const ci = makeResult({
    taskId: "ci",
    agentName: "ci_debug_agent",
    taskType: "ci_debug",
    entityType: "workflow_run",
    entityRef: "run-1",
    output: {
      is_merge_blocking: true,
      debug_steps: ["Inspect the failing job"],
    },
    confidence: 0.7,
    evidenceCount: 3,
  });
  const spec: WorkflowSpec = {
    goal: "Can we merge PR 34?",
    claims: [
      makeClaim({
        id: "ci",
        entity_type: "workflow_run",
        entity_ref: "run-1",
        task_type: "ci_debug",
      }),
    ],
  };
  const observation = observeWorkflow(spec, [ci]);
  const memo = deterministicMemo(spec, [ci], observation);
  assert.match(memo, /## Multi-agent decision memo/);
  assert.match(memo, /Goal: Can we merge PR 34\?/);
  assert.match(memo, /Hold the merge or release/);
  assert.match(memo, /## Task graph/);
  assert.match(memo, /## Agent output summary/);
  assert.match(memo, /ci_debug_agent \[success\]/);
  assert.match(memo, /## Observer findings/);
  assert.match(memo, /BLOCKER \(ci_merge_gate\)/);
  assert.match(memo, /## Next steps/);
  assert.match(memo, /Inspect the failing job/);
});

check("deterministicMemo: clean run → proceed decision", () => {
  const results = [
    makeResult({
      output: { priority: "P3" },
      confidence: 0.9,
      evidenceCount: 2,
    }),
  ];
  const spec: WorkflowSpec = { goal: "Triage issue 12", claims: [makeClaim()] };
  const observation = observeWorkflow(spec, results);
  const memo = deterministicMemo(spec, results, observation);
  assert.match(memo, /Proceed: no cross-domain blockers were found\./);
  assert.match(memo, /Observer confidence: 0\.90/);
});

await checkAsync(
  "synthesize: falls back to the deterministic memo without an LLM key",
  async () => {
    const results = [makeResult()];
    const spec: WorkflowSpec = { goal: "g", claims: [makeClaim()] };
    const observation = observeWorkflow(spec, results);
    const synthesis = await synthesize(spec, results, observation);
    if (!llmConfigured()) {
      assert.equal(synthesis.generationMode, "deterministic");
      assert.equal(
        synthesis.answer,
        deterministicMemo(spec, results, observation),
      );
    } else {
      assert.ok(synthesis.answer.length > 0);
    }
  },
);

console.log(`DEVFLOW-WORKFLOW SMOKE OK (${checks} checks)`);
