// POST /api/a2ui_action — answers a surface action with in-place A2UI update
// messages for the same surface. Unified response shape { message, data }.
import { getTranslations } from "next-intl/server";
import { z } from "zod/v4";
import { runA2uiAction } from "@/lib/ai/a2ui/action";

const a2uiActionRequestSchema = z.object({
  action: z.object({
    name: z.string().min(1),
    surfaceId: z.string().min(1),
    sourceComponentId: z.string().optional(),
    context: z.record(z.string(), z.unknown()).optional(),
  }),
  // Full current message list of the surface (its authoritative state).
  a2ui: z.array(z.unknown()).min(1),
});

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(request: Request) {
  const t = await getTranslations("api.oncall");
  try {
    const parsed = a2uiActionRequestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return Response.json(
        { message: t("missingActionOrMessages"), data: null },
        { status: 400, headers: CORS_HEADERS },
      );
    }
    const { action, a2ui } = parsed.data;
    const result = await runA2uiAction(action, a2ui);
    if (result.error || !result.a2ui) {
      return Response.json(
        { message: result.error ?? t("noUpdateProduced"), data: null },
        { status: 502, headers: CORS_HEADERS },
      );
    }
    return Response.json(
      { message: "OK", data: { a2ui: result.a2ui } },
      { headers: CORS_HEADERS },
    );
  } catch (e) {
    const err = e as {
      name?: string;
      message?: string;
      statusCode?: number;
      responseBody?: string;
    };
    console.error("[/api/a2ui_action] error:", err);
    return Response.json(
      {
        message: JSON.stringify({
          name: err?.name,
          message: err?.message ?? String(e),
          statusCode: err?.statusCode,
          responseBody: err?.responseBody,
        }),
        data: null,
      },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
