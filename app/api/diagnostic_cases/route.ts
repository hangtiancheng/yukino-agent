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

export async function GET(request: Request) {
  const t = await getTranslations("api.oncall");
  const url = new URL(request.url);
  const limit = Math.min(
    Math.max(
      Number.parseInt(url.searchParams.get("limit") ?? "50", 10) || 50,
      1,
    ),
    200,
  );
  try {
    const cases = await prisma.diagnosticCaseRecord.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return Response.json(
      {
        message: "OK",
        data: {
          items: cases.map((c) => ({
            id: c.id,
            hash: c.hash,
            title: c.title,
            alertName: c.alertName,
            summary: c.summary,
            fileName: c.fileName,
            createdAt: c.createdAt,
          })),
        },
      },
      { headers: CORS_HEADERS },
    );
  } catch (e) {
    console.error("[/api/diagnostic_cases] error:", e);
    return Response.json(
      { message: t("historyUnavailable"), data: null },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
