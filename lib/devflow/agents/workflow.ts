// DevFlow multi-agent workflow orchestration — port of the legacy Python
// subsystem (the largest single DevFlow subsystem; Yukino.md #24):
//   - planner_agent.py    → planWorkflow / deterministicPlanSpec / replanClaims
//   - observer_agent.py   → observeWorkflow (findings + confidence synthesis)
//   - synthesis_agent.py  → synthesize / deterministicMemo (decision memo)
//   - workflow_orchestrator.py → executeWorkflow (task graph, parallel cap,
//                           90 s task timeout, ≤2 replan rounds)
//   - chat.py /plan + /plan/execute/stream → the two-phase protocol served by
//                           app/api/devflow/chat/plan{,/execute}/route.ts
//
// Like the legacy orchestrator, every stage has a deterministic fallback: with
// no LLM key the planner degrades to a bounded "latest open issue / failed CI /
// open PR" spec, the observer is pure rules, and synthesis is a template memo —
// the whole pipeline runs offline. Task execution reuses the three analysis
// agents (analysis.ts analyzeIssue / reviewPull / debugRun), which already
// carry their own deterministic-first guarantees.
//
// Safety note: the legacy SafetyAgent (safety_agent.py) gate is preserved
// structurally — workflow tasks are read-only analyses and every GitHub write
// still flows exclusively through ActionDraft confirmation (lib/devflow/drafts.ts).
import { Output, generateText } from "ai";
import { z } from "zod/v4";
import { prisma } from "@/lib/db";
import { thinkModel, providerOptions } from "@/lib/ai/models";
import { observeGeneration } from "@/lib/observability";
import {
  analyzeIssue,
  debugRun,
  llmConfigured,
  reviewPull,
} from "@/lib/devflow/agents/analysis";
import { AI_META_RULES } from "@/lib/devflow/agents/prompts";

// ---------------------------------------------------------------------------
// Constants (workflow_orchestrator.py: _task_timeout_seconds default from
// settings.workflow_task_timeout_seconds = 90; _max_replans clamps to 2;
// WorkflowSpec.max_parallel_tasks default 3)
// ---------------------------------------------------------------------------

export const TASK_TIMEOUT_MS = 90_000;
export const MAX_PARALLEL_TASKS = 3;
export const MAX_REPLANS = 2;

// ---------------------------------------------------------------------------
// WorkflowSpec schema (assignment spec: goal + bounded claims; legacy
// schemas/workflow.py WorkflowSpec/WorkflowClaim/WorkflowTask collapsed into
// one claim-per-task shape — each claim IS the task boundary)
// ---------------------------------------------------------------------------

export const WorkflowEntityTypeSchema = z.enum([
  "issue",
  "pull_request",
  "workflow_run",
  "repository",
]);
export type WorkflowEntityType = z.infer<typeof WorkflowEntityTypeSchema>;

export const WorkflowTaskTypeSchema = z.enum([
  "issue_analysis",
  "pr_review",
  "ci_debug",
  "repo_health",
]);
export type WorkflowTaskType = z.infer<typeof WorkflowTaskTypeSchema>;

export const WorkflowClaimSchema = z.object({
  id: z.string().min(1).max(64),
  entity_type: WorkflowEntityTypeSchema,
  // issue / pull_request: GitHub number ("123", "#123" tolerated);
  // workflow_run: synced WorkflowRun id, GitHub run id, or workflow name;
  // repository: repo id or "owner/name".
  entity_ref: z.string().max(200),
  task_type: WorkflowTaskTypeSchema,
  acceptance_criteria: z.array(z.string().min(1)).min(1).max(8),
});
export type WorkflowClaim = z.infer<typeof WorkflowClaimSchema>;

export const WorkflowSpecSchema = z.object({
  goal: z.string().min(1).max(2000),
  claims: z.array(WorkflowClaimSchema).max(24),
});
export type WorkflowSpec = z.infer<typeof WorkflowSpecSchema>;

// Request payloads for the two-phase protocol (schemas.ts is frozen for this
// task, so the workflow request schemas live beside the workflow logic).
export const WorkflowPlanRequestSchema = z.object({
  repoId: z.string().min(1),
  goal: z.string().trim().min(1).max(2000),
});

export const WorkflowExecuteRequestSchema = z.object({
  runId: z.string().min(1),
});

// Observation (legacy schemas/workflow.py WorkflowFinding/WorkflowObservation).
export const WorkflowFindingSeveritySchema = z.enum([
  "info",
  "warning",
  "blocker",
]);

export const WorkflowFindingSchema = z.object({
  finding_type: z.string(),
  severity: WorkflowFindingSeveritySchema,
  message: z.string(),
  claim_ids: z.array(z.string()),
  recommendation: z.string(),
});
export type WorkflowFinding = z.infer<typeof WorkflowFindingSchema>;

export const WorkflowObservationSchema = z.object({
  findings: z.array(WorkflowFindingSchema),
  overall_confidence: z.number().min(0).max(1),
  human_review_required: z.boolean(),
  summary: z.string(),
});
export type WorkflowObservation = z.infer<typeof WorkflowObservationSchema>;

// Per-task result (legacy WorkflowTaskResult; status "error" is renamed
// "failed" to match the AgentTaskRun status comment in prisma/schema.prisma).
export type WorkflowTaskStatus = "success" | "failed" | "skipped";

export interface WorkflowTaskResult {
  taskId: string;
  agentName: string;
  taskType: WorkflowTaskType;
  entityType: WorkflowEntityType;
  entityRef: string;
  status: WorkflowTaskStatus;
  summary: string;
  confidence: number | null;
  evidenceCount: number;
  output: Record<string, unknown>;
  error: string | null;
  startedAt: string;
  completedAt: string;
}

export interface WorkflowMetrics {
  durationMs: number;
  taskCount: number;
  planTaskCount: number;
  executionRounds: number;
  replanCount: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
  observerFindings: number;
}

// legacy planner_agent.py agent naming (WorkflowTask.agent_name).
const AGENT_NAMES: Record<WorkflowTaskType, string> = {
  issue_analysis: "issue_analyst_agent",
  pr_review: "pr_review_agent",
  ci_debug: "ci_debug_agent",
  repo_health: "repo_health_agent",
};

export function agentNameForTaskType(taskType: WorkflowTaskType): string {
  return AGENT_NAMES[taskType];
}

// Entity/task coherence guard: a claim's task_type must be the analysis that
// belongs to its entity_type (validateClaims rejects mismatches).
const TASK_TYPE_FOR_ENTITY: Record<WorkflowEntityType, WorkflowTaskType> = {
  issue: "issue_analysis",
  pull_request: "pr_review",
  workflow_run: "ci_debug",
  repository: "repo_health",
};

// Deterministic acceptance criteria per task type (legacy planner_agent.py
// WorkflowSpec.acceptance_criteria, pushed down to claim level).
const ACCEPTANCE_CRITERIA: Record<WorkflowTaskType, string[]> = {
  issue_analysis: [
    "Priority and category are assigned with cited evidence",
    "Suggested owner comes from the validated allow-list",
    "Next actions are listed as an executable checklist",
  ],
  pr_review: [
    "Findings are graded P1/P2/P3 with evidence",
    "Blocking issues are listed explicitly before any merge advice",
    "The merge recommendation states WHY, not just the verdict",
  ],
  ci_debug: [
    "Failure type is classified from the synced logs",
    "Root cause is traced back to the first error",
    "Fix steps are executable against the related files",
  ],
  repo_health: [
    "Counts come from the synced repository snapshot",
    "The most recent signals are listed with identifiers",
  ],
};

// ---------------------------------------------------------------------------
// Entity snapshot — the boundary a claim may reference (legacy planner built
// this from repo evidence via _build_engineering_workflow_runtime in chat.py;
// validateClaims rejects any entity_ref outside it)
// ---------------------------------------------------------------------------

export interface SnapshotIssue {
  id: string;
  number: number;
  title: string;
  state: string;
}

export interface SnapshotPullRequest {
  id: string;
  number: number;
  title: string;
  state: string;
  merged: boolean;
}

export interface SnapshotWorkflowRun {
  id: string;
  githubRunId: string | null;
  name: string;
  conclusion: string | null;
}

export interface EntitySnapshot {
  repoId: string;
  fullName: string;
  issues: SnapshotIssue[];
  pullRequests: SnapshotPullRequest[];
  workflowRuns: SnapshotWorkflowRun[];
}

export async function loadEntitySnapshot(
  repoId: string,
): Promise<EntitySnapshot | null> {
  const repo = await prisma.repository.findUnique({ where: { id: repoId } });
  if (!repo) return null;
  const [issues, pulls, runs] = await Promise.all([
    prisma.issue.findMany({
      where: { repoId },
      orderBy: { githubUpdatedAt: "desc" },
      take: 200,
      select: { id: true, number: true, title: true, state: true },
    }),
    prisma.pullRequest.findMany({
      where: { repoId },
      orderBy: { githubUpdatedAt: "desc" },
      take: 200,
      select: {
        id: true,
        number: true,
        title: true,
        state: true,
        mergedAt: true,
      },
    }),
    prisma.workflowRun.findMany({
      where: { repoId },
      orderBy: { githubCreatedAt: "desc" },
      take: 200,
      select: {
        id: true,
        githubRunId: true,
        name: true,
        conclusion: true,
      },
    }),
  ]);
  return {
    repoId,
    fullName: repo.fullName,
    issues,
    pullRequests: pulls.map((pr) => ({
      id: pr.id,
      number: pr.number,
      title: pr.title,
      state: pr.state,
      merged: pr.mergedAt !== null,
    })),
    workflowRuns: runs.map((run) => ({
      id: run.id,
      githubRunId: run.githubRunId === null ? null : String(run.githubRunId),
      name: run.name,
      conclusion: run.conclusion,
    })),
  };
}

// ---------------------------------------------------------------------------
// Claim validation (assignment: validateClaims rejects vague / out-of-bounds
// claims — the legacy boundary lived in WorkflowClaim.allowed_sources and the
// planner only ever emitted refs from the assembled repo context)
// ---------------------------------------------------------------------------

export interface ResolvedEntity {
  id: string;
  label: string;
}

export function resolveClaimEntity(
  claim: WorkflowClaim,
  snapshot: EntitySnapshot,
): ResolvedEntity | null {
  const ref = claim.entity_ref.trim();
  if (ref.length === 0) return null;
  if (claim.entity_type === "issue") {
    const number = Number(ref.replace(/^#/, ""));
    const issue = snapshot.issues.find(
      (item) =>
        item.id === ref || (Number.isFinite(number) && item.number === number),
    );
    return issue ? { id: issue.id, label: `Issue #${issue.number}` } : null;
  }
  if (claim.entity_type === "pull_request") {
    const number = Number(ref.replace(/^#/, ""));
    const pr = snapshot.pullRequests.find(
      (item) =>
        item.id === ref || (Number.isFinite(number) && item.number === number),
    );
    return pr ? { id: pr.id, label: `PR #${pr.number}` } : null;
  }
  if (claim.entity_type === "workflow_run") {
    const lowered = ref.toLowerCase();
    const run = snapshot.workflowRuns.find(
      (item) =>
        item.id === ref ||
        item.githubRunId === ref ||
        item.name.toLowerCase() === lowered,
    );
    return run ? { id: run.id, label: `CI run "${run.name}"` } : null;
  }
  // repository
  if (
    ref === snapshot.repoId ||
    ref.toLowerCase() === snapshot.fullName.toLowerCase()
  ) {
    return { id: snapshot.repoId, label: snapshot.fullName };
  }
  return null;
}

export interface ClaimViolation {
  claimId: string;
  reason: string;
}

export interface ClaimValidation {
  claims: WorkflowClaim[];
  violations: ClaimViolation[];
}

export function validateClaims(
  spec: WorkflowSpec,
  snapshot: EntitySnapshot,
): ClaimValidation {
  const claims: WorkflowClaim[] = [];
  const violations: ClaimViolation[] = [];
  const seenIds = new Set<string>();
  for (const claim of spec.claims) {
    if (seenIds.has(claim.id)) {
      violations.push({ claimId: claim.id, reason: "duplicate claim id" });
      continue;
    }
    seenIds.add(claim.id);
    if (claim.entity_ref.trim().length === 0) {
      violations.push({
        claimId: claim.id,
        reason: "vague claim: entity_ref is empty",
      });
      continue;
    }
    if (TASK_TYPE_FOR_ENTITY[claim.entity_type] !== claim.task_type) {
      violations.push({
        claimId: claim.id,
        reason: `task_type ${claim.task_type} does not match entity_type ${claim.entity_type}`,
      });
      continue;
    }
    if (resolveClaimEntity(claim, snapshot) === null) {
      violations.push({
        claimId: claim.id,
        reason: `out-of-bounds claim: ${claim.entity_type} "${claim.entity_ref}" is not in the synced data of ${snapshot.fullName}`,
      });
      continue;
    }
    claims.push(claim);
  }
  return { claims, violations };
}

// ---------------------------------------------------------------------------
// Planner (legacy planner_agent.py run(); deterministic fallback per the
// assignment: one claim each for the latest open issue / failed CI run /
// open PR from the synced snapshot)
// ---------------------------------------------------------------------------

export function deterministicPlanSpec(
  goal: string,
  snapshot: EntitySnapshot,
): WorkflowSpec {
  const claims: WorkflowClaim[] = [];
  const openIssue = snapshot.issues.find((issue) => issue.state === "open");
  if (openIssue) {
    claims.push({
      id: "issue_analysis",
      entity_type: "issue",
      entity_ref: String(openIssue.number),
      task_type: "issue_analysis",
      acceptance_criteria: ACCEPTANCE_CRITERIA.issue_analysis,
    });
  }
  const failedRun = snapshot.workflowRuns.find(
    (run) => run.conclusion === "failure",
  );
  if (failedRun) {
    claims.push({
      id: "ci_debug",
      entity_type: "workflow_run",
      entity_ref: failedRun.id,
      task_type: "ci_debug",
      acceptance_criteria: ACCEPTANCE_CRITERIA.ci_debug,
    });
  }
  const openPr = snapshot.pullRequests.find(
    (pr) => pr.state === "open" && !pr.merged,
  );
  if (openPr) {
    claims.push({
      id: "pr_review",
      entity_type: "pull_request",
      entity_ref: String(openPr.number),
      task_type: "pr_review",
      acceptance_criteria: ACCEPTANCE_CRITERIA.pr_review,
    });
  }
  return { goal, claims };
}

function plannerPrompt(goal: string, snapshot: EntitySnapshot): string {
  return `${AI_META_RULES}

You are the DevFlow Workflow Planner (legacy planner_agent.py). Build a bounded
multi-agent workflow spec for the engineering goal below. Every claim is one
task with an explicit entity boundary: agents may only reason about the entity
their claim references.

Engineering goal:
${goal}

Repository snapshot (the ONLY entities a claim may reference):
${JSON.stringify(
  {
    repo: { id: snapshot.repoId, fullName: snapshot.fullName },
    issues: snapshot.issues.slice(0, 20).map((i) => ({
      number: i.number,
      title: i.title,
      state: i.state,
    })),
    pull_requests: snapshot.pullRequests.slice(0, 20).map((p) => ({
      number: p.number,
      title: p.title,
      state: p.state,
      merged: p.merged,
    })),
    workflow_runs: snapshot.workflowRuns.slice(0, 20).map((r) => ({
      id: r.id,
      name: r.name,
      conclusion: r.conclusion,
    })),
  },
  null,
  2,
)}

Rules:
- goal must restate the engineering goal.
- Each claim: unique short id, entity_type (issue | pull_request | workflow_run | repository),
  entity_ref taken VERBATIM from the snapshot (issue/PR number, workflow run id, or repo id),
  task_type matching the entity_type (issue→issue_analysis, pull_request→pr_review,
  workflow_run→ci_debug, repository→repo_health), and 1-3 concrete acceptance_criteria.
- Prefer at most one claim per entity and at most 6 claims total; pick the entities
  whose analysis actually answers the goal (open issues, failed CI, open PRs first).
- Never reference entities outside the snapshot; vague refs like "latest" or "all" are rejected.

Return a JSON object that exactly matches the required schema. No markdown, no code fences.`;
}

// Structured generation with one strict retry — mirrors the (frozen)
// generateStructured in analysis.ts; some OpenAI-compatible gateways wrap JSON
// in prose on the first attempt.
async function generateSpec(
  goal: string,
  snapshot: EntitySnapshot,
): Promise<WorkflowSpec> {
  const runOnce = (prompt: string) =>
    observeGeneration("devflow-workflow-planner", async (generation) => {
      const res = await generateText({
        model: thinkModel,
        system: "You are the DevFlow Workflow Planner. Respond with JSON only.",
        prompt,
        output: Output.object({ schema: WorkflowSpecSchema }),
        providerOptions,
      });
      generation?.update({ input: prompt, output: res.text });
      return res;
    });

  const prompt = plannerPrompt(goal, snapshot);
  let firstError: unknown;
  try {
    const res = await runOnce(prompt);
    if (res.output) return res.output;
    firstError = new Error("empty structured output");
  } catch (e) {
    firstError = e;
  }
  const retryPrompt = `${prompt}\n\nIMPORTANT: respond with ONLY a JSON object that matches the required schema. No markdown, no code fences, no commentary.`;
  try {
    const res = await runOnce(retryPrompt);
    if (res.output) return res.output;
  } catch (e) {
    firstError = e;
  }
  throw new Error(
    `devflow-workflow-planner: model did not produce schema-valid output (${
      firstError instanceof Error ? firstError.message : String(firstError)
    })`,
  );
}

export interface PlanWorkflowResult {
  spec: WorkflowSpec;
  generationMode: "llm" | "deterministic";
  violations: ClaimViolation[];
}

export async function planWorkflow(
  repoId: string,
  goal: string,
): Promise<PlanWorkflowResult | null> {
  const snapshot = await loadEntitySnapshot(repoId);
  if (!snapshot) return null;

  if (llmConfigured()) {
    try {
      const llmSpec = await generateSpec(goal, snapshot);
      // The user's goal is authoritative (legacy: spec.goal = message).
      const { claims, violations } = validateClaims(
        { goal, claims: llmSpec.claims },
        snapshot,
      );
      if (claims.length > 0) {
        return {
          spec: { goal, claims },
          generationMode: "llm",
          violations,
        };
      }
      console.warn(
        "[devflow-workflow] planner LLM spec had no valid claims; degrading to deterministic spec. Violations:",
        violations,
      );
    } catch (e) {
      console.warn(
        "[devflow-workflow] planner LLM failed; degrading to deterministic spec:",
        e,
      );
    }
  }

  const spec = deterministicPlanSpec(goal, snapshot);
  // The deterministic spec is built from the snapshot, but re-validate so the
  // contract (only in-bounds claims are persisted) holds on every path.
  const { claims, violations } = validateClaims(spec, snapshot);
  return {
    spec: { goal, claims },
    generationMode: "deterministic",
    violations,
  };
}

// ---------------------------------------------------------------------------
// Task graph scheduling (legacy workflow_orchestrator.py _run_task_graph;
// assignment topology: same entity sequential, different entities parallel,
// global cap 3). Returns ordered waves; a wave runs concurrently.
// ---------------------------------------------------------------------------

export function claimEntityKey(claim: WorkflowClaim): string {
  // "#12" and "12" are the same issue entity (resolveClaimEntity parity).
  const ref = claim.entity_ref.trim().replace(/^#/, "").toLowerCase();
  return `${claim.entity_type}:${ref}`;
}

export function scheduleClaims(
  claims: WorkflowClaim[],
  maxParallel: number = MAX_PARALLEL_TASKS,
): WorkflowClaim[][] {
  const groups: WorkflowClaim[][] = [];
  const byEntity = new Map<string, WorkflowClaim[]>();
  for (const claim of claims) {
    const key = claimEntityKey(claim);
    let group = byEntity.get(key);
    if (!group) {
      group = [];
      byEntity.set(key, group);
      groups.push(group);
    }
    group.push(claim);
  }
  const waves: WorkflowClaim[][] = [];
  const cursors = groups.map(() => 0);
  for (;;) {
    const heads: WorkflowClaim[] = [];
    groups.forEach((group, index) => {
      if (cursors[index] < group.length) {
        heads.push(group[cursors[index]]);
        cursors[index] += 1;
      }
    });
    if (heads.length === 0) break;
    for (let i = 0; i < heads.length; i += maxParallel) {
      waves.push(heads.slice(i, i + maxParallel));
    }
  }
  return waves;
}

// ---------------------------------------------------------------------------
// Observer (legacy observer_agent.py — status/evidence/confidence/merge-gate
// findings + confidence synthesis; assignment adds the deterministic rule
// "issue triaged P0/P1 → blocker")
// ---------------------------------------------------------------------------

function byType(
  results: WorkflowTaskResult[],
  taskType: WorkflowTaskType,
): WorkflowTaskResult | null {
  return (
    results.find((r) => r.taskType === taskType && r.status === "success") ??
    null
  );
}

function finding(input: {
  finding_type: string;
  severity: WorkflowFinding["severity"];
  message: string;
  claim_ids?: string[];
  recommendation?: string;
}): WorkflowFinding {
  return {
    finding_type: input.finding_type,
    severity: input.severity,
    message: input.message,
    claim_ids: input.claim_ids ?? [],
    recommendation: input.recommendation ?? "",
  };
}

export function observeWorkflow(
  spec: WorkflowSpec,
  results: WorkflowTaskResult[],
): WorkflowObservation {
  const findings: WorkflowFinding[] = [];
  void spec;

  // legacy _status_findings
  for (const result of results) {
    if (result.status === "failed") {
      findings.push(
        finding({
          finding_type: "task_failed",
          severity: "blocker",
          message: `${result.agentName} failed: ${result.error ?? "unknown error"}`,
          claim_ids: [result.taskId],
          recommendation:
            "Fix the failing task or rerun with a narrower scope before trusting the memo.",
        }),
      );
    } else if (result.status === "skipped") {
      findings.push(
        finding({
          finding_type: "task_skipped",
          severity: "warning",
          message: `${result.agentName} was skipped, so workflow coverage is incomplete.`,
          claim_ids: [result.taskId],
          recommendation:
            "Sync or connect the missing repository signal if this area affects the decision.",
        }),
      );
    }
  }

  // assignment rule: P0/P1 triage → blocker (deterministic)
  for (const result of results) {
    if (result.status !== "success" || result.taskType !== "issue_analysis") {
      continue;
    }
    const priority = result.output.priority;
    if (priority === "P0" || priority === "P1") {
      const ref = result.entityRef.startsWith("#")
        ? result.entityRef
        : `#${result.entityRef}`;
      findings.push(
        finding({
          finding_type: "high_priority_issue",
          severity: "blocker",
          message: `Issue ${ref} was triaged as ${priority}: ${result.summary}`,
          claim_ids: [result.taskId],
          recommendation:
            "Treat this issue as a release blocker candidate; confirm the triage before the next merge window.",
        }),
      );
    }
  }

  // legacy _merge_gate_findings
  const prResult = byType(results, "pr_review");
  const ciResult = byType(results, "ci_debug");
  if (ciResult && ciResult.output.is_merge_blocking === true) {
    findings.push(
      finding({
        finding_type: "ci_merge_gate",
        severity: "blocker",
        message:
          "The CI agent marked the latest failed workflow run as merge-blocking.",
        claim_ids: [ciResult.taskId],
        recommendation:
          "Fix or explicitly explain the CI failure before approving a merge or release.",
      }),
    );
  }
  if (
    prResult &&
    Array.isArray(prResult.output.blocking_issues) &&
    prResult.output.blocking_issues.length > 0
  ) {
    findings.push(
      finding({
        finding_type: "pr_blocking_issues",
        severity: "blocker",
        message: "The PR review found blocking issues.",
        claim_ids: [prResult.taskId],
        recommendation:
          "Resolve the PR blocking issues, then rerun the workflow.",
      }),
    );
  }
  if (
    prResult &&
    ciResult &&
    ciResult.output.is_merge_blocking === true &&
    prResult.output.merge_recommendation === "approve"
  ) {
    findings.push(
      finding({
        finding_type: "cross_agent_conflict",
        severity: "blocker",
        message:
          "The PR agent leans toward merging while the CI agent reports a merge-blocking failure.",
        claim_ids: [prResult.taskId, ciResult.taskId],
        recommendation:
          "Let the CI gate win over the PR merge advice until the failure is resolved.",
      }),
    );
  }

  // legacy _evidence_findings / _confidence_findings
  for (const result of results) {
    if (result.status !== "success" || result.taskType === "repo_health")
      continue;
    if (result.evidenceCount <= 0) {
      findings.push(
        finding({
          finding_type: "evidence_gap",
          severity: "warning",
          message: `${result.agentName} returned no explicit evidence.`,
          claim_ids: [result.taskId],
          recommendation:
            "Sync the related issues, PR files or CI logs before making a high-stakes decision.",
        }),
      );
    }
    if (result.confidence !== null && result.confidence < 0.5) {
      findings.push(
        finding({
          finding_type: "low_confidence",
          severity: "warning",
          message: `${result.agentName} confidence is low (${result.confidence.toFixed(2)}).`,
          claim_ids: [result.taskId],
          recommendation:
            "Add more context or check the underlying evidence before acting.",
        }),
      );
    }
  }

  // legacy confidence synthesis (observer_agent.py L26-30): mean of successful
  // task confidences (0.55 when absent) − 0.2·blockers − 0.05·warnings,
  // clamped to [0.1, 0.95].
  const confidences = results
    .filter((r) => r.status === "success" && r.confidence !== null)
    .map((r) => r.confidence as number);
  const base =
    confidences.length > 0
      ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
      : 0.55;
  const blockers = findings.filter((f) => f.severity === "blocker").length;
  const warnings = findings.filter((f) => f.severity === "warning").length;
  const overall =
    Math.round(
      Math.max(0.1, Math.min(0.95, base - 0.2 * blockers - 0.05 * warnings)) *
        100,
    ) / 100;

  return {
    findings,
    overall_confidence: overall,
    human_review_required: blockers > 0,
    summary:
      blockers > 0
        ? `Observer found ${blockers} blocker(s) and ${warnings} warning(s); confidence ${overall.toFixed(2)}.`
        : warnings > 0
          ? `Observer found ${warnings} warning(s); confidence ${overall.toFixed(2)}.`
          : `Observer found no cross-agent blockers; confidence ${overall.toFixed(2)}.`,
  };
}

// ---------------------------------------------------------------------------
// Replan (legacy planner_agent.py replan() + orchestrator _max_replans clamp;
// assignment rule: replan when a blocker appeared and entities in the snapshot
// are still uncovered, at most MAX_REPLANS times)
// ---------------------------------------------------------------------------

export function shouldReplan(
  observation: WorkflowObservation,
  replanCount: number,
): boolean {
  return (
    replanCount < MAX_REPLANS &&
    observation.findings.some((f) => f.severity === "blocker")
  );
}

function uniqueClaimId(spec: WorkflowSpec, base: string): string {
  const existing = new Set(spec.claims.map((claim) => claim.id));
  if (!existing.has(base)) return base;
  let index = 2;
  while (existing.has(`${base}_${index}`)) index += 1;
  return `${base}_${index}`;
}

// Deterministic replan: add claims for the strongest uncovered signals
// (latest open issue / failed CI run / open PR). Returns [] when everything
// strong is already covered — the caller then stops the replan loop.
export function replanClaims(
  spec: WorkflowSpec,
  snapshot: EntitySnapshot,
): WorkflowClaim[] {
  const covered = new Set(
    spec.claims.map(
      (claim) =>
        `${claim.entity_type}:${resolveClaimEntity(claim, snapshot)?.id ?? claim.entity_ref}`,
    ),
  );
  const extra: WorkflowClaim[] = [];
  const openIssue = snapshot.issues.find(
    (issue) => issue.state === "open" && !covered.has(`issue:${issue.id}`),
  );
  if (openIssue) {
    extra.push({
      id: uniqueClaimId(
        { ...spec, claims: [...spec.claims, ...extra] },
        "issue_analysis",
      ),
      entity_type: "issue",
      entity_ref: String(openIssue.number),
      task_type: "issue_analysis",
      acceptance_criteria: ACCEPTANCE_CRITERIA.issue_analysis,
    });
  }
  const failedRun = snapshot.workflowRuns.find(
    (run) =>
      run.conclusion === "failure" && !covered.has(`workflow_run:${run.id}`),
  );
  if (failedRun) {
    extra.push({
      id: uniqueClaimId(
        { ...spec, claims: [...spec.claims, ...extra] },
        "ci_debug",
      ),
      entity_type: "workflow_run",
      entity_ref: failedRun.id,
      task_type: "ci_debug",
      acceptance_criteria: ACCEPTANCE_CRITERIA.ci_debug,
    });
  }
  const openPr = snapshot.pullRequests.find(
    (pr) =>
      pr.state === "open" &&
      !pr.merged &&
      !covered.has(`pull_request:${pr.id}`),
  );
  if (openPr) {
    extra.push({
      id: uniqueClaimId(
        { ...spec, claims: [...spec.claims, ...extra] },
        "pr_review",
      ),
      entity_type: "pull_request",
      entity_ref: String(openPr.number),
      task_type: "pr_review",
      acceptance_criteria: ACCEPTANCE_CRITERIA.pr_review,
    });
  }
  return extra;
}

// ---------------------------------------------------------------------------
// Synthesis (legacy synthesis_agent.py — decision memo; deterministic template
// fallback keeps the pipeline honest without an LLM)
// ---------------------------------------------------------------------------

function memoDecision(
  observation: WorkflowObservation,
  results: WorkflowTaskResult[],
): string {
  const blockers = observation.findings.filter((f) => f.severity === "blocker");
  const warnings = observation.findings.filter((f) => f.severity === "warning");
  if (blockers.length > 0) {
    if (
      blockers.some(
        (f) =>
          f.finding_type === "ci_merge_gate" ||
          f.finding_type === "cross_agent_conflict",
      )
    ) {
      return "Hold the merge or release: resolve the CI failure / cross-agent conflict first.";
    }
    return "Blockers found; do not proceed until they are addressed.";
  }
  const prResult = byType(results, "pr_review");
  if (prResult && typeof prResult.output.merge_recommendation === "string") {
    return `Proceed per the PR review recommendation: ${prResult.output.merge_recommendation}.`;
  }
  if (warnings.length > 0) {
    return "Proceed with caution: close the evidence or coverage gaps flagged by the observer.";
  }
  return "Proceed: no cross-domain blockers were found.";
}

function memoNextSteps(
  observation: WorkflowObservation,
  results: WorkflowTaskResult[],
): string[] {
  const steps: string[] = [];
  const ciResult = byType(results, "ci_debug");
  const prResult = byType(results, "pr_review");
  const issueResult = byType(results, "issue_analysis");
  const strings = (value: unknown): string[] =>
    Array.isArray(value)
      ? value
          .map((item) => String(item))
          .filter((item) => item.trim().length > 0)
      : [];

  // legacy _next_steps
  if (ciResult && ciResult.output.is_merge_blocking === true) {
    const debugSteps = strings(ciResult.output.debug_steps);
    steps.push(
      ...(debugSteps.length > 0
        ? debugSteps.slice(0, 3)
        : ["Locate and fix the latest failed CI run first."]),
    );
  }
  if (prResult) {
    steps.push(...strings(prResult.output.blocking_issues).slice(0, 2));
    steps.push(...strings(prResult.output.test_suggestions).slice(0, 2));
  }
  if (issueResult) {
    steps.push(...strings(issueResult.output.checklist).slice(0, 2));
  }
  for (const f of observation.findings) {
    if (f.recommendation) steps.push(f.recommendation);
  }
  if (steps.length === 0) {
    steps.push(
      "Feed this memo back into the PR/Issue description or the team sync.",
    );
  }
  return [...new Set(steps)].slice(0, 6);
}

export function deterministicMemo(
  spec: WorkflowSpec,
  results: WorkflowTaskResult[],
  observation: WorkflowObservation,
): string {
  const lines = [
    "## Multi-agent decision memo",
    "",
    `Goal: ${spec.goal}`,
    `Decision: ${memoDecision(observation, results)}`,
    `Observer confidence: ${observation.overall_confidence.toFixed(2)}`,
    observation.human_review_required
      ? "Human review: required (blocker findings present)."
      : "Human review: not required by the observer.",
    "",
    "## Task graph",
  ];
  for (const claim of spec.claims) {
    lines.push(
      `- ${claim.id}: ${agentNameForTaskType(claim.task_type)} on ${claim.entity_type} "${claim.entity_ref}" (${claim.task_type})`,
    );
  }
  lines.push("", "## Agent output summary");
  for (const result of results) {
    lines.push(
      `- ${result.agentName} [${result.status}]: ${result.summary || "(no summary)"}`,
    );
  }
  lines.push("", "## Observer findings");
  if (observation.findings.length === 0) {
    lines.push("- No cross-agent conflicts found.");
  } else {
    for (const f of observation.findings) {
      lines.push(
        `- ${f.severity.toUpperCase()} (${f.finding_type}): ${f.message}${f.recommendation ? ` Recommendation: ${f.recommendation}` : ""}`,
      );
    }
  }
  lines.push("", "## Next steps");
  for (const step of memoNextSteps(observation, results)) {
    lines.push(`- ${step}`);
  }
  return lines.join("\n");
}

const SYNTHESIS_PROMPT = `${AI_META_RULES}

You are the DevFlow Synthesis Agent (legacy synthesis_agent.py). Turn the
multi-agent workflow results below into ONE engineering decision memo in
markdown with exactly these sections: "## Multi-agent decision memo" (goal,
decision, observer confidence), "## Agent output summary", "## Observer
findings", "## Next steps". Preserve What / Why / Tradeoff / Open Questions /
Next Action. Never invent evidence that is not in the input; when a task
failed or was skipped, say so plainly. Respond with the memo text only.`;

export interface SynthesisResult {
  answer: string;
  generationMode: "llm" | "deterministic";
}

export async function synthesize(
  spec: WorkflowSpec,
  results: WorkflowTaskResult[],
  observation: WorkflowObservation,
): Promise<SynthesisResult> {
  if (llmConfigured()) {
    try {
      const input = JSON.stringify(
        {
          spec,
          task_results: results.map((r) => ({
            task_id: r.taskId,
            agent_name: r.agentName,
            task_type: r.taskType,
            status: r.status,
            summary: r.summary,
            confidence: r.confidence,
            evidence_count: r.evidenceCount,
            output: r.output,
            error: r.error,
          })),
          observation,
        },
        null,
        2,
      );
      const answer = await observeGeneration(
        "devflow-workflow-synthesis",
        async (generation) => {
          const res = await generateText({
            model: thinkModel,
            system: SYNTHESIS_PROMPT,
            prompt: input,
            providerOptions,
          });
          generation?.update({ input, output: res.text });
          return res.text;
        },
      );
      if (answer && answer.trim().length > 0) {
        return { answer: answer.trim(), generationMode: "llm" };
      }
    } catch (e) {
      console.warn(
        "[devflow-workflow] synthesis LLM failed; using deterministic memo:",
        e,
      );
    }
  }
  return {
    answer: deterministicMemo(spec, results, observation),
    generationMode: "deterministic",
  };
}

// ---------------------------------------------------------------------------
// Executor (legacy workflow_orchestrator.py run_spec / _run_single_task;
// assignment: reuse analysis.ts per task_type, 90 s per-task timeout → failed,
// same entity sequential / different entities parallel ≤3, ≤2 replans)
// ---------------------------------------------------------------------------

export type WorkflowStreamEvent =
  | {
      type: "task_start";
      taskId: string;
      agentName: string;
      taskType: string;
      entityType: string;
      entityRef: string;
    }
  | {
      type: "task_result";
      taskId: string;
      status: WorkflowTaskStatus;
      summary: string;
      confidence: number | null;
      error: string | null;
    }
  | {
      type: "observation";
      iteration: number;
      isReplan: boolean;
      observation: WorkflowObservation;
      replannedClaims: string[];
    }
  | { type: "memo"; answer: string; generationMode: "llm" | "deterministic" }
  | {
      type: "done";
      runId: string;
      status: "success" | "failed";
      metrics: WorkflowMetrics;
    };

class TaskTimeoutError extends Error {
  constructor(ms: number) {
    super(`task exceeded ${Math.round(ms / 1000)}s timeout`);
    this.name = "TaskTimeoutError";
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TaskTimeoutError(ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function repoHealthOutput(snapshot: EntitySnapshot): {
  output: Record<string, unknown>;
  summary: string;
  evidenceCount: number;
} {
  const openIssues = snapshot.issues.filter((i) => i.state === "open").length;
  const openPrs = snapshot.pullRequests.filter(
    (p) => p.state === "open" && !p.merged,
  ).length;
  const failedRuns = snapshot.workflowRuns.filter(
    (r) => r.conclusion === "failure",
  ).length;
  return {
    output: {
      open_issues: openIssues,
      open_pull_requests: openPrs,
      failed_ci_runs: failedRuns,
      recent_issues: snapshot.issues
        .slice(0, 5)
        .map((i) => ({ number: i.number, title: i.title, state: i.state })),
      recent_runs: snapshot.workflowRuns
        .slice(0, 5)
        .map((r) => ({ name: r.name, conclusion: r.conclusion })),
    },
    summary: `Repository snapshot: ${openIssues} open issue(s), ${openPrs} open PR(s), ${failedRuns} failed CI run(s).`,
    evidenceCount:
      Math.min(5, snapshot.issues.length) +
      Math.min(5, snapshot.workflowRuns.length),
  };
}

export interface ExecuteWorkflowOptions {
  runId: string;
  onEvent?: (event: WorkflowStreamEvent) => void;
  taskTimeoutMs?: number;
}

export interface ExecuteWorkflowOutcome {
  status: "success" | "failed";
  metrics: WorkflowMetrics;
}

export async function executeWorkflow(
  options: ExecuteWorkflowOptions,
): Promise<ExecuteWorkflowOutcome> {
  const { runId, onEvent } = options;
  const taskTimeoutMs = options.taskTimeoutMs ?? TASK_TIMEOUT_MS;
  const started = Date.now();
  const emit = (event: WorkflowStreamEvent) => {
    onEvent?.(event);
  };

  const run = await prisma.agentWorkflowRun.findUnique({
    where: { id: runId },
  });
  if (!run) throw new Error(`Workflow run ${runId} not found`);
  if (run.status !== "running") {
    throw new Error(
      `Workflow run ${runId} is not runnable (status: ${run.status})`,
    );
  }
  const parsedSpec = WorkflowSpecSchema.safeParse(run.specJson);
  if (!parsedSpec.success) {
    await prisma.agentWorkflowRun.update({
      where: { id: runId },
      data: { status: "failed", completedAt: new Date() },
    });
    throw new Error(`Workflow run ${runId} has no valid spec`);
  }
  if (!run.repoId) {
    throw new Error(`Workflow run ${runId} has no repository`);
  }
  const snapshot = await loadEntitySnapshot(run.repoId);
  if (!snapshot) throw new Error(`Repository ${run.repoId} not found`);

  let spec = parsedSpec.data;
  const resultsByTask = new Map<string, WorkflowTaskResult>();
  let replanCount = 0;
  let rounds = 0;
  let observation: WorkflowObservation = {
    findings: [],
    overall_confidence: 0,
    human_review_required: false,
    summary: "Workflow did not run.",
  };

  try {
    // legacy run_spec loop: run graph → observe → maybe replan (≤ MAX_REPLANS)
    let pendingClaims = spec.claims;
    for (;;) {
      rounds += 1;
      const waves = scheduleClaims(pendingClaims);
      for (const wave of waves) {
        await Promise.all(
          wave.map(async (claim) => {
            const result = await runClaim(
              claim,
              runId,
              snapshot,
              taskTimeoutMs,
              emit,
            );
            // Latest result per task wins (deviation from legacy, which kept
            // stale error results across rounds and re-flagged them forever).
            resultsByTask.set(claim.id, result);
          }),
        );
      }

      const results = [...resultsByTask.values()];
      observation = observeWorkflow(spec, results);
      const replannedClaims: string[] = [];
      if (shouldReplan(observation, replanCount)) {
        const extra = replanClaims(spec, snapshot);
        if (extra.length > 0) {
          spec = { goal: spec.goal, claims: [...spec.claims, ...extra] };
          await prisma.agentTaskRun.createMany({
            data: extra.map((claim) => ({
              workflowId: runId,
              taskId: claim.id,
              agentName: agentNameForTaskType(claim.task_type),
              taskType: claim.task_type,
              claimJson: claim as object,
              status: "pending",
            })),
          });
          await prisma.agentWorkflowRun.update({
            where: { id: runId },
            data: { specJson: spec as object },
          });
          replanCount += 1;
          replannedClaims.push(...extra.map((claim) => claim.id));
          pendingClaims = extra;
          emit({
            type: "observation",
            iteration: rounds - 1,
            // isReplan = this observation triggered a replan round.
            isReplan: true,
            observation,
            replannedClaims,
          });
          continue;
        }
      }
      emit({
        type: "observation",
        iteration: rounds - 1,
        isReplan: false,
        observation,
        replannedClaims,
      });
      break;
    }

    const results = [...resultsByTask.values()];
    const synthesis = await synthesize(spec, results, observation);
    emit({
      type: "memo",
      answer: synthesis.answer,
      generationMode: synthesis.generationMode,
    });

    const metrics: WorkflowMetrics = {
      durationMs: Date.now() - started,
      taskCount: results.length,
      planTaskCount: spec.claims.length,
      executionRounds: rounds,
      replanCount,
      successCount: results.filter((r) => r.status === "success").length,
      failedCount: results.filter((r) => r.status === "failed").length,
      skippedCount: results.filter((r) => r.status === "skipped").length,
      observerFindings: observation.findings.length,
    };
    await prisma.agentWorkflowRun.update({
      where: { id: runId },
      data: {
        specJson: spec as object,
        observationJson: observation as object,
        finalAnswer: synthesis.answer,
        metrics: {
          ...metrics,
          synthesisMode: synthesis.generationMode,
        } as object,
        status: "success",
        completedAt: new Date(),
      },
    });
    emit({ type: "done", runId, status: "success", metrics });
    return { status: "success", metrics };
  } catch (e) {
    await prisma.agentWorkflowRun
      .update({
        where: { id: runId },
        data: { status: "failed", completedAt: new Date() },
      })
      .catch(() => undefined);
    throw e;
  }

  // Runs one claim: task_start → resolve entity → analysis agent with the
  // 90 s timeout (legacy _run_single_task) → persist AgentTaskRun → task_result.
  async function runClaim(
    claim: WorkflowClaim,
    workflowId: string,
    entities: EntitySnapshot,
    timeoutMs: number,
    notify: (event: WorkflowStreamEvent) => void,
  ): Promise<WorkflowTaskResult> {
    const agentName = agentNameForTaskType(claim.task_type);
    const startedAt = new Date();
    notify({
      type: "task_start",
      taskId: claim.id,
      agentName,
      taskType: claim.task_type,
      entityType: claim.entity_type,
      entityRef: claim.entity_ref,
    });
    await prisma.agentTaskRun
      .updateMany({
        where: { workflowId, taskId: claim.id },
        data: { status: "running", startedAt, error: null },
      })
      .catch(() => undefined);

    const finish = async (
      result: WorkflowTaskResult,
      rowStatus: "success" | "failed" | "skipped",
    ): Promise<WorkflowTaskResult> => {
      await prisma.agentTaskRun
        .updateMany({
          where: { workflowId, taskId: claim.id },
          data: {
            status: rowStatus,
            resultJson: result as unknown as object,
            error: result.error,
            completedAt: new Date(),
          },
        })
        .catch(() => undefined);
      notify({
        type: "task_result",
        taskId: claim.id,
        status: result.status,
        summary: result.summary,
        confidence: result.confidence,
        error: result.error,
      });
      return result;
    };

    const base = {
      taskId: claim.id,
      agentName,
      taskType: claim.task_type,
      entityType: claim.entity_type,
      entityRef: claim.entity_ref,
      startedAt: startedAt.toISOString(),
    };

    const resolved = resolveClaimEntity(claim, entities);
    if (!resolved) {
      // legacy _dependency_blocked_result semantics: not runnable → skipped
      return finish(
        {
          ...base,
          status: "skipped",
          summary: `${agentName} was skipped: ${claim.entity_type} "${claim.entity_ref}" is no longer in the synced data.`,
          confidence: 0,
          evidenceCount: 0,
          output: { error_kind: "entity_not_found" },
          error: `entity ${claim.entity_type}:${claim.entity_ref} not found`,
          completedAt: new Date().toISOString(),
        },
        "skipped",
      );
    }

    try {
      const executed = await withTimeout(
        runAnalysis(claim.task_type, resolved.id, entities),
        timeoutMs,
      );
      return finish(
        {
          ...base,
          status: "success",
          summary: executed.summary,
          confidence: executed.confidence,
          evidenceCount: executed.evidenceCount,
          output: executed.output,
          error: null,
          completedAt: new Date().toISOString(),
        },
        "success",
      );
    } catch (e) {
      const isTimeout = e instanceof TaskTimeoutError;
      return finish(
        {
          ...base,
          // legacy status "error" → "failed" (AgentTaskRun status comment)
          status: "failed",
          summary: `${agentName} failed.`,
          confidence: null,
          evidenceCount: 0,
          output: { error_kind: isTimeout ? "timeout" : "task_runtime_error" },
          error: e instanceof Error ? e.message : String(e),
          completedAt: new Date().toISOString(),
        },
        "failed",
      );
    }
  }
}

// Maps a claim to the reused analysis agent (assignment: analyzeIssue /
// reviewPull / debugRun by task_type) and normalizes its record into the
// legacy WorkflowTaskResult fields the observer consumes.
async function runAnalysis(
  taskType: WorkflowTaskType,
  entityId: string,
  snapshot: EntitySnapshot,
): Promise<{
  summary: string;
  confidence: number | null;
  evidenceCount: number;
  output: Record<string, unknown>;
}> {
  if (taskType === "issue_analysis") {
    const record = await analyzeIssue(entityId);
    return {
      summary: record.result.summary,
      confidence: record.result.confidence,
      evidenceCount: record.result.evidence.length,
      output: record.result as unknown as Record<string, unknown>,
    };
  }
  if (taskType === "pr_review") {
    const record = await reviewPull(entityId);
    return {
      summary: record.result.summary,
      confidence: record.result.confidence,
      evidenceCount: record.result.review_findings.length,
      output: record.result as unknown as Record<string, unknown>,
    };
  }
  if (taskType === "ci_debug") {
    const record = await debugRun(entityId);
    return {
      summary: record.result.failure_summary,
      confidence: record.result.confidence,
      evidenceCount: record.result.executed_steps.length,
      output: record.result as unknown as Record<string, unknown>,
    };
  }
  // repo_health: deterministic snapshot summary (no legacy analysis agent to
  // reuse; repo_health_agent stayed in the legacy runtime and only assembled
  // counts that sync.ts already provides).
  const health = repoHealthOutput(snapshot);
  return {
    summary: health.summary,
    confidence: 1,
    evidenceCount: health.evidenceCount,
    output: health.output,
  };
}
