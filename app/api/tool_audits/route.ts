// GET /api/tool_audits?session=<id> — read-only view of the OnCall agent
// tool-call audit trail (public surface of the legacy agent_tool_call_audits,
// simplified: rows are written fire-and-forget by chat/chatStream with the
// input/result excerpts already truncated to AUDIT_TEXT_CHARS). Returns the
// most recent 50 calls for one session, newest first.
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
