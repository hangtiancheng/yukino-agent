import { prisma } from "@/lib/db";
import type { PlanExecuteEvent } from "@/lib/ai/pipelines/plan-execute-replan/events";

export interface AiOpsRunFinalize {
  status: string;
  report?: string;
  detail?: string[];
  events?: unknown[];
  a2uiJson?: unknown[];
  error?: string;
}

// The legacy pipeline persisted a full evidence chain (steps, per-tool
// evidence, checkpoints). The current run row keeps a bounded, truncated
// PlanExecuteEvent timeline instead — enough to reconstruct the step-by-step
// diagnosis after the fact; per-tool detail lives in ToolCallAudit rows keyed
// by `aiops:<runId>`.
export const MAX_RUN_EVENTS = 300;
export const RUN_EVENT_OUTPUT_CHARS = 1_200;
export const RUN_EVENT_STEP_CHARS = 400;

function clipEventText(value: string, max: number): string {
  const normalized = value.split(/\s+/).join(" ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3)}...`;
}

/** Truncated, JSON-safe projection of a stream event for run persistence. */
export function toRunEvent(event: PlanExecuteEvent): Record<string, unknown> {
  switch (event.type) {
    case "plan_created":
      return {
        type: "plan_created",
        steps: event.steps.map((step) =>
          clipEventText(step, RUN_EVENT_STEP_CHARS),
        ),
      };
    case "step_start":
      return {
        type: "step_start",
        index: event.index,
        step: clipEventText(event.step, RUN_EVENT_STEP_CHARS),
      };
    case "step_done":
      return {
        type: "step_done",
        index: event.index,
        output: clipEventText(event.output, RUN_EVENT_OUTPUT_CHARS),
      };
    case "replan":
      return {
        type: "replan",
        done: event.done,
        remaining: event.remaining.map((step) =>
          clipEventText(step, RUN_EVENT_STEP_CHARS),
        ),
      };
    case "done":
      // The report itself is stored on the run row; keep the marker only.
      return { type: "done" };
    case "error":
      return {
        type: "error",
        error: clipEventText(event.error, RUN_EVENT_STEP_CHARS),
      };
  }
}

export function pushRunEvent(
  events: Record<string, unknown>[],
  event: PlanExecuteEvent,
): void {
  if (events.length >= MAX_RUN_EVENTS) return;
  events.push(toRunEvent(event));
}

export async function createAiOpsRun(
  query: string,
  alertName: string | null,
): Promise<string | null> {
  try {
    const created = await prisma.aiOpsRun.create({
      data: { query, alertName, status: "running" },
    });
    return created.id;
  } catch (e) {
    console.error("[ai_ops] run persistence unavailable:", e);
    return null;
  }
}

export function finalizeAiOpsRun(
  runId: string | null,
  update: AiOpsRunFinalize,
): void {
  if (runId === null) return;
  void prisma.aiOpsRun
    .update({
      where: { id: runId },
      data: {
        status: update.status,
        ...(update.report !== undefined ? { report: update.report } : {}),
        ...(update.detail !== undefined ? { detail: update.detail } : {}),
        ...(update.events !== undefined
          ? { events: JSON.parse(JSON.stringify(update.events)) }
          : {}),
        ...(update.a2uiJson !== undefined
          ? { a2ui: JSON.parse(JSON.stringify(update.a2uiJson)) }
          : {}),
        ...(update.error !== undefined ? { error: update.error } : {}),
        endedAt: new Date(),
      },
    })
    .catch((e) => console.error("[ai_ops] run finalize failed:", e));
}

export function alertNameOf(
  alert: Record<string, string> | null,
): string | null {
  if (alert === null) return null;
  return alert["alert_name"] ?? alert["alertName"] ?? alert["name"] ?? null;
}

export function normalizeAlertInput(
  raw: unknown,
): Record<string, string> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") flat[key] = value;
  }
  return Object.keys(flat).length > 0 ? flat : null;
}
