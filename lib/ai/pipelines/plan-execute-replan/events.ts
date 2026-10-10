import { z } from "zod/v4";

export const PlanExecuteEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("plan_created"), steps: z.array(z.string()) }),
  z.object({
    type: z.literal("step_start"),
    index: z.number(),
    step: z.string(),
  }),
  z.object({
    type: z.literal("step_done"),
    index: z.number(),
    output: z.string(),
  }),
  z.object({
    type: z.literal("replan"),
    done: z.boolean(),
    remaining: z.array(z.string()),
  }),
  z.object({
    type: z.literal("done"),
    result: z.string(),
    detail: z.array(z.string()),
    a2ui: z.array(z.unknown()).optional(),
  }),
  z.object({ type: z.literal("error"), error: z.string() }),
]);

export type PlanExecuteEvent = z.infer<typeof PlanExecuteEventSchema>;
