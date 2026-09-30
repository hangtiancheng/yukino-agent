// POST /api/ai_ops —
// runs the plan-execute-replan pipeline and returns { result, detail }.
import { runPlanExecuteReplan } from "@/lib/ai/pipelines/plan-execute-replan";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST() {
  try {
    for await (const event of runPlanExecuteReplan()) {
      if (event.type === "done") {
        return Response.json(
          {
            message: "OK",
            data: {
              result: event.result,
              detail: event.detail,
              ...(event.a2ui ? { a2ui: event.a2ui } : {}),
            },
          },
          { headers: CORS_HEADERS },
        );
      }
      if (event.type === "error") {
        return Response.json(
          { message: event.error, data: null },
          { status: 500, headers: CORS_HEADERS },
        );
      }
    }
    // No done/error event emitted.
    return Response.json(
      { message: "internal error", data: null },
      { status: 500, headers: CORS_HEADERS },
    );
  } catch (e) {
    return Response.json(
      { message: e instanceof Error ? e.message : String(e), data: null },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
