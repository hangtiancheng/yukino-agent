import { getTranslations } from "next-intl/server";
import { z } from "zod/v4";
import { persistDiagnosticCase } from "@/lib/ai/pipelines/diagnostic-cases";
import {
  buildAiOpsQuery,
  runPlanExecuteReplan,
} from "@/lib/ai/pipelines/plan-execute-replan";
import { EXHAUSTED_RESULT } from "@/lib/ai/pipelines/plan-execute-replan/graph";
import {
  alertNameOf,
  createAiOpsRun,
  finalizeAiOpsRun,
  normalizeAlertInput,
  pushRunEvent,
} from "@/lib/ai/aiops-run";

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
  const runId = await createAiOpsRun(query, alertName);

  const events: Record<string, unknown>[] = [];
  try {
    for await (const event of runPlanExecuteReplan(query, alert, runId)) {
      pushRunEvent(events, event);
      if (event.type === "done") {
        void persistDiagnosticCase(event.result, event.detail, alertName).catch(
          (e) =>
            console.error("[ai_ops] diagnostic case persistence failed:", e),
        );
        const status =
          event.result === EXHAUSTED_RESULT ? "exhausted" : "success";
        finalizeAiOpsRun(runId, {
          status,
          report: event.result,
          detail: event.detail,
          events,
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
        finalizeAiOpsRun(runId, {
          status: "failed",
          error: event.error,
          events,
        });
        return Response.json(
          { message: event.error, data: null },
          { status: 500, headers: CORS_HEADERS },
        );
      }
    }
    finalizeAiOpsRun(runId, {
      status: "failed",
      error: "stream ended without done/error",
      events,
    });
    return Response.json(
      { message: t("internalError"), data: null },
      { status: 500, headers: CORS_HEADERS },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    finalizeAiOpsRun(runId, { status: "failed", error: message, events });
    return Response.json(
      { message, data: null },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
