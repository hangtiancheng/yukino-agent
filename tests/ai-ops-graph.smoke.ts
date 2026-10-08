// AI Ops LangGraph smoke: offline structural checks for the plan-execute-replan
// graph (compile, nodes, edges) and the PlanExecuteEvent schema round-trip.
// A full live run (LLM upstreams + tools required) is gated behind an env flag.
// Run: npx tsx tests/ai-ops-graph.smoke.ts
// Live: AI_OPS_SMOKE_LIVE=1 npx tsx tests/ai-ops-graph.smoke.ts
import assert from "node:assert/strict";

import { PlanExecuteEventSchema } from "@/lib/ai/pipelines/plan-execute-replan/events";
import {
  MAX_ITERATIONS,
  RECURSION_LIMIT,
  opsGraph,
} from "@/lib/ai/pipelines/plan-execute-replan/graph";

// ---- 1. Event schema ----
const validEvents: unknown[] = [
  { type: "plan_created", steps: ["a", "b"] },
  { type: "step_start", index: 0, step: "a" },
  { type: "step_done", index: 0, output: "ok" },
  { type: "replan", done: false, remaining: ["b"] },
  { type: "done", result: "report", detail: ["ok"] },
  { type: "done", result: "report", detail: [], a2ui: [{ x: 1 }] },
  { type: "error", error: "boom" },
];
for (const event of validEvents) {
  assert.ok(
    PlanExecuteEventSchema.safeParse(event).success,
    `event should parse: ${JSON.stringify(event)}`,
  );
}
for (const invalid of [
  { type: "unknown_event" },
  { type: "done", result: "x" }, // missing detail
  { type: "step_start", index: "0", step: "a" }, // wrong index type
  "not-an-object",
]) {
  assert.ok(
    !PlanExecuteEventSchema.safeParse(invalid).success,
    `event should NOT parse: ${JSON.stringify(invalid)}`,
  );
}

// ---- 2. Graph structure ----
assert.ok(RECURSION_LIMIT > MAX_ITERATIONS, "recursion limit too small");
const rep = await opsGraph.getGraphAsync({});
const nodeIds = Object.keys(rep.nodes);
for (const expected of [
  "__start__",
  "planner",
  "executor",
  "replanner",
  "uiify",
  "exhausted",
  "__end__",
]) {
  assert.ok(nodeIds.includes(expected), `missing node: ${expected}`);
}
const edges = rep.edges.map((e) => `${e.source}->${e.target}`);
for (const expected of [
  "__start__->planner",
  "planner->executor",
  "planner->exhausted",
  "executor->executor",
  "executor->replanner",
  "replanner->executor",
  "replanner->uiify",
  "replanner->exhausted",
  "uiify->__end__",
  "exhausted->__end__",
]) {
  assert.ok(edges.includes(expected), `missing edge: ${expected}`);
}
console.log(rep.drawMermaid());

// ---- 3. Optional live run (requires LLM upstreams; Langfuse when configured) ----
if (process.env.AI_OPS_SMOKE_LIVE === "1") {
  const { initObservability } = await import("@/lib/observability");
  initObservability();
  const { runPlanExecuteReplan } =
    await import("@/lib/ai/pipelines/plan-execute-replan/index");
  // AI_OPS_SMOKE_QUERY keeps the live run cheap; default is the alert-analysis query.
  const query = process.env.AI_OPS_SMOKE_QUERY;
  const events = query ? runPlanExecuteReplan(query) : runPlanExecuteReplan();
  for await (const event of events) {
    console.log("[event]", JSON.stringify(event).slice(0, 400));
    if (event.type === "done" || event.type === "error") break;
  }
}

console.log("OK ai-ops-graph-smoke passed");
// Live mode may leave transient handles (e.g. a failed MCP SSE connect); never
// let a smoke run linger.
process.exit(0);
