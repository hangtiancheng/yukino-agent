// Plan-Execute-Replan event types
export type PlanExecuteEvent =
  | { type: "plan_created"; steps: string[] }
  | { type: "step_start"; index: number; step: string }
  | { type: "step_done"; index: number; output: string }
  | { type: "replan"; done: boolean; remaining: string[] }
  | { type: "done"; result: string; detail: string[]; a2ui?: unknown[] }
  | { type: "error"; error: string };
