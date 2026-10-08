// POST /api/chat — unified response shape { message, data }.
import { getTranslations } from "next-intl/server";
import { z } from "zod/v4";
import { chat } from "@/lib/ai/pipelines/chat";

const chatRequestSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
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
  try {
    const parsed = chatRequestSchema.safeParse(await request.json());
    if (!parsed.success) {
      const t = await getTranslations("api.oncall");
      return Response.json(
        { message: t("missingIdOrQuestion"), data: null },
        { status: 400, headers: CORS_HEADERS },
      );
    }
    const { id, question } = parsed.data;
    const { answer, a2ui, references, reasoning } = await chat(id, question);
    return Response.json(
      {
        message: "OK",
        data: {
          answer,
          ...(a2ui ? { a2ui } : {}),
          ...(references ? { references } : {}),
          ...(reasoning ? { reasoning } : {}),
        },
      },
      { headers: CORS_HEADERS },
    );
  } catch (e) {
    // The Vercel AI SDK throws APICallError with the real upstream body in
    // `responseBody`/`statusCode`; `e.message` alone is often empty when a
    // non-official Anthropic-compatible gateway returns a non-standard error.
    const err = e as {
      name?: string;
      message?: string;
      statusCode?: number;
      url?: string;
      responseBody?: string;
      responseHeaders?: Record<string, string>;
      cause?: unknown;
    };
    console.error("[/api/chat] error:", err);
    return Response.json(
      {
        message: JSON.stringify({
          name: err?.name,
          message: err?.message ?? String(e),
          statusCode: err?.statusCode,
          url: err?.url,
          responseBody: err?.responseBody,
          responseHeaders: err?.responseHeaders,
        }),
        data: null,
      },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
