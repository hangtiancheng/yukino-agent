import assert from "node:assert/strict";

import { PlanExecuteEventSchema } from "@/lib/ai/pipelines/plan-execute-replan/events";
import {
  MAX_ITERATIONS,
  RECURSION_LIMIT,
  opsGraph,
} from "@/lib/ai/pipelines/plan-execute-replan/graph";

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
  { type: "done", result: "x" },
  { type: "step_start", index: "0", step: "a" },
  "not-an-object",
]) {
  assert.ok(
    !PlanExecuteEventSchema.safeParse(invalid).success,
    `event should NOT parse: ${JSON.stringify(invalid)}`,
  );
}

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

if (process.env.AI_OPS_SMOKE_LIVE === "1") {
  const { initObservability } = await import("@/lib/observability");
  initObservability();
  const { runPlanExecuteReplan } =
    await import("@/lib/ai/pipelines/plan-execute-replan/index");
  const query = process.env.AI_OPS_SMOKE_QUERY;
  const events = query ? runPlanExecuteReplan(query) : runPlanExecuteReplan();
  for await (const event of events) {
    console.log("[event]", JSON.stringify(event).slice(0, 400));
    if (event.type === "done" || event.type === "error") break;
  }
}

console.log("OK ai-ops-graph-smoke passed");
process.exit(0);
