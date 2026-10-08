// GET /api/ai_ops/runs/[id] — one full AI Ops run (report + step detail +
// optional A2UI surface) for the history drawer. Legacy counterpart: the
// per-task diagnostic payload (agent_py app.py _diagnostic_task_payload).
import { getTranslations } from "next-intl/server";
import { prisma } from "@/lib/db";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  const t = await getTranslations("api.oncall");
  const { id } = await context.params;
  try {
    const run = await prisma.aiOpsRun.findUnique({ where: { id } });
    if (run === null) {
      return Response.json(
        { message: t("runNotFound"), data: null },
        { status: 404, headers: CORS_HEADERS },
      );
    }
    return Response.json(
      {
        message: "OK",
        data: {
          id: run.id,
          query: run.query,
          status: run.status,
          alertName: run.alertName,
          report: run.report,
          detail: run.detail,
          a2ui: run.a2ui,
          error: run.error,
          startedAt: run.startedAt.toISOString(),
          endedAt: run.endedAt?.toISOString() ?? null,
        },
      },
      { headers: CORS_HEADERS },
    );
  } catch (e) {
    return Response.json(
      {
        message: t("historyUnavailable", {
          error: e instanceof Error ? e.message : String(e),
        }),
        data: null,
      },
      { status: 503, headers: CORS_HEADERS },
    );
  }
}
