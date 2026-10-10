"use client";
import { z } from "zod/v4";

const planCreatedSchema = z.object({
  type: z.literal("plan_created"),
  steps: z.array(z.string()),
});
const stepStartSchema = z.object({
  type: z.literal("step_start"),
  index: z.number(),
  step: z.string(),
});
const stepDoneSchema = z.object({
  type: z.literal("step_done"),
  index: z.number(),
  output: z.string(),
});
const replanSchema = z.object({
  type: z.literal("replan"),
  done: z.boolean(),
  remaining: z.array(z.string()),
});
const doneSchema = z.object({
  type: z.literal("done"),
  runId: z.string().nullish(),
  status: z.string(),
  result: z.string(),
  detail: z.array(z.string()),
  a2ui: z.array(z.unknown()).optional(),
});
const errorSchema = z.object({
  type: z.literal("error"),
  error: z.string(),
});

const frameSchema = z.discriminatedUnion("type", [
  planCreatedSchema,
  stepStartSchema,
  stepDoneSchema,
  replanSchema,
  doneSchema,
  errorSchema,
  z.object({ type: z.literal("run_started"), runId: z.string().nullish() }),
]);

export interface AiOpsStreamHandlers {
  onPlan?: (steps: string[]) => void;
  onStepStart?: (index: number, step: string) => void;
  onStepDone?: (index: number, output: string) => void;
  onReplan?: (done: boolean, remaining: string[]) => void;
}

export interface AiOpsStreamResult {
  runId: string | null;
  status: string;
  result: string;
  detail: string[];
  a2ui?: unknown[];
}

export class AiOpsStreamError extends Error {}

export async function runAiOpsStream(
  body: { query?: string; alert?: unknown },
  handlers: AiOpsStreamHandlers = {},
  signal?: AbortSignal,
): Promise<AiOpsStreamResult> {
  const resp = await fetch("/api/ai_ops/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok || resp.body === null) {
    throw new AiOpsStreamError(`HTTP ${resp.status}`);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  let finalResult: AiOpsStreamResult | null = null;
  let failure: string | null = null;

  const dispatch = () => {
    if (dataLines.length === 0) return;
    const payload = dataLines.join("\n");
    dataLines = [];
    let json: unknown;
    try {
      json = JSON.parse(payload);
    } catch {
      return;
    }
    const parsed = frameSchema.safeParse(json);
    if (!parsed.success) return;
    const frame = parsed.data;
    if (frame.type === "plan_created") handlers.onPlan?.(frame.steps);
    else if (frame.type === "step_start")
      handlers.onStepStart?.(frame.index, frame.step);
    else if (frame.type === "step_done")
      handlers.onStepDone?.(frame.index, frame.output);
    else if (frame.type === "replan")
      handlers.onReplan?.(frame.done, frame.remaining);
    else if (frame.type === "done") {
      finalResult = {
        runId: frame.runId ?? null,
        status: frame.status,
        result: frame.result,
        detail: frame.detail,
        ...(frame.a2ui && frame.a2ui.length > 0 ? { a2ui: frame.a2ui } : {}),
      };
    } else if (frame.type === "error") {
      failure = frame.error;
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      } else if (line.trim() === "") {
        dispatch();
      }
    }
  }
  dispatch();

  if (failure !== null) throw new AiOpsStreamError(failure);
  if (finalResult === null) {
    throw new AiOpsStreamError("stream ended without a result");
  }
  return finalResult;
}
