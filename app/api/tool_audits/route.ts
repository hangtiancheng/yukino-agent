import { getTranslations } from "next-intl/server";
import { z } from "zod/v4";
import { prisma } from "@/lib/db";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const MAX_AUDITS = 50;

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

const querySchema = z.object({
  session: z.string().min(1),
});

export async function GET(request: Request) {
  const t = await getTranslations("api.oncall");
  const parsed = querySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!parsed.success) {
    return Response.json(
      { message: t("missingSessionId"), data: null },
      { status: 400, headers: CORS_HEADERS },
    );
  }
  try {
    const audits = await prisma.toolCallAudit.findMany({
      where: { sessionId: parsed.data.session },
      orderBy: { createdAt: "desc" },
      take: MAX_AUDITS,
    });
    return Response.json(
      { message: "OK", data: { audits } },
      { headers: CORS_HEADERS },
    );
  } catch (e) {
    console.error("[/api/tool_audits] error:", e);
    return Response.json(
      { message: t("internalError"), data: null },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
