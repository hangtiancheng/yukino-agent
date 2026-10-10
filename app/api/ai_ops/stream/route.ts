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

export const maxDuration = 600;

const aiOpsRequestSchema = z.object({
  query: z.string().max(8000).optional(),
  alert: z.unknown().optional(),
});

function sse(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
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
        { status: 400 },
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

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (payload: Record<string, unknown>) => {
        try {
          controller.enqueue(encoder.encode(sse(payload)));
        } catch {
          // client disconnected; the run row still records the outcome
        }
      };
      send({ type: "run_started", runId });
      const events: Record<string, unknown>[] = [];
      try {
        for await (const event of runPlanExecuteReplan(query, alert, runId)) {
          pushRunEvent(events, event);
          if (event.type === "done") {
            void persistDiagnosticCase(
              event.result,
              event.detail,
              alertName,
            ).catch((e) =>
              console.error("[ai_ops:stream] case persistence failed:", e),
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
            send({
              type: "done",
              runId,
              status,
              result: event.result,
              detail: event.detail,
              ...(event.a2ui ? { a2ui: event.a2ui } : {}),
            });
            break;
          }
          if (event.type === "error") {
            finalizeAiOpsRun(runId, {
              status: "failed",
              error: event.error,
              events,
            });
            send({ type: "error", runId, error: event.error });
            break;
          }
          send({ ...event, runId });
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        finalizeAiOpsRun(runId, { status: "failed", error: message, events });
        send({ type: "error", runId, error: message });
      } finally {
        try {
          controller.close();
        } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
