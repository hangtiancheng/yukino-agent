import { getTranslations } from "next-intl/server";
import { z } from "zod/v4";
import { prisma } from "@/lib/db";
import { persistDiagnosticCase } from "@/lib/ai/pipelines/diagnostic-cases";
import {
  buildAiOpsQuery,
  runPlanExecuteReplan,
} from "@/lib/ai/pipelines/plan-execute-replan";
import { EXHAUSTED_RESULT } from "@/lib/ai/pipelines/plan-execute-replan/graph";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

const aiOpsRequestSchema = z.object({
  query: z.string().max(8000).optional(),
  alert: z.unknown().optional(),
});

function normalizeAlertInput(raw: unknown): Record<string, string> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") flat[key] = value;
  }
  return Object.keys(flat).length > 0 ? flat : null;
}

function alertNameOf(alert: Record<string, string> | null): string | null {
  if (alert === null) return null;
  return alert["alert_name"] ?? alert["alertName"] ?? alert["name"] ?? null;
}

export async function POST(request: Request) {
  const t = await getTranslations("api.oncall");
  let body: z.infer<typeof aiOpsRequestSchema> = {};
  try {
    const rawBody: unknown = await request.json();
    const parsed = aiOpsRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return Response.json(
        { message: t("invalidAiOpsBody"), data: null },
        { status: 400, headers: CORS_HEADERS },
      );
    }
    body = parsed.data;
  } catch {}

  const { query, alert } = buildAiOpsQuery({
    query: body.query,
    alert: normalizeAlertInput(body.alert),
  });
  const alertName = alertNameOf(alert);

  let runId: string | null = null;
  try {
    const created = await prisma.aiOpsRun.create({
      data: { query, alertName, status: "running" },
    });
    runId = created.id;
  } catch (e) {
    console.error("[ai_ops] run persistence unavailable:", e);
  }

  const finishRun = (update: {
    status: string;
    report?: string;
    detail?: string[];
    a2uiJson?: unknown[];
    error?: string;
  }) => {
    if (runId === null) return;
    void prisma.aiOpsRun
      .update({
        where: { id: runId },
        data: {
          status: update.status,
          ...(update.report !== undefined ? { report: update.report } : {}),
          ...(update.detail !== undefined ? { detail: update.detail } : {}),
          ...(update.a2uiJson !== undefined
            ? { a2ui: JSON.parse(JSON.stringify(update.a2uiJson)) }
            : {}),
          ...(update.error !== undefined ? { error: update.error } : {}),
          endedAt: new Date(),
        },
      })
      .catch((e) => console.error("[ai_ops] run finalize failed:", e));
  };

  try {
    for await (const event of runPlanExecuteReplan(query, alert)) {
      if (event.type === "done") {
        void persistDiagnosticCase(event.result, event.detail, alertName).catch(
          (e) =>
            console.error("[ai_ops] diagnostic case persistence failed:", e),
        );
        const status =
          event.result === EXHAUSTED_RESULT ? "exhausted" : "success";
        finishRun({
          status,
          report: event.result,
          detail: event.detail,
          ...(event.a2ui ? { a2uiJson: event.a2ui } : {}),
        });
        return Response.json(
          {
            message: "OK",
            data: {
              runId,
              result: event.result,
              detail: event.detail,
              ...(event.a2ui ? { a2ui: event.a2ui } : {}),
            },
          },
          { headers: CORS_HEADERS },
        );
      }
      if (event.type === "error") {
        finishRun({ status: "failed", error: event.error });
        return Response.json(
          { message: event.error, data: null },
          { status: 500, headers: CORS_HEADERS },
        );
      }
    }
    finishRun({ status: "failed", error: "stream ended without done/error" });
    return Response.json(
      { message: t("internalError"), data: null },
      { status: 500, headers: CORS_HEADERS },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    finishRun({ status: "failed", error: message });
    return Response.json(
      { message, data: null },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
