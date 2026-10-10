import { getTranslations } from "next-intl/server";
import { prisma } from "@/lib/db";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function DELETE(_request: Request, context: RouteContext) {
  const t = await getTranslations("api.oncall");
  const { id } = await context.params;
  try {
    const existing = await prisma.userFeedback.findUnique({ where: { id } });
    if (existing === null) {
      return Response.json(
        { message: t("feedbackNotFound"), data: null },
        { status: 404, headers: CORS_HEADERS },
      );
    }
    await prisma.userFeedback.delete({ where: { id } });
    return Response.json(
      { message: "OK", data: { deleted: id } },
      { headers: CORS_HEADERS },
    );
  } catch (e) {
    console.error("[/api/feedback] delete failed:", e);
    return Response.json(
      { message: t("feedbackUnavailable"), data: null },
      { status: 503, headers: CORS_HEADERS },
    );
  }
}
