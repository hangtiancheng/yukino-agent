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

const SUMMARY_CHARS = 200;

export async function GET() {
  const t = await getTranslations("api.oncall");
  try {
    const runs = await prisma.aiOpsRun.findMany({
      orderBy: { startedAt: "desc" },
      take: 20,
      select: {
        id: true,
        query: true,
        status: true,
        alertName: true,
        report: true,
        startedAt: true,
        endedAt: true,
      },
    });
    return Response.json(
      {
        message: "OK",
        data: {
          items: runs.map((run) => ({
            id: run.id,
            query: run.query.slice(0, SUMMARY_CHARS),
            status: run.status,
            alertName: run.alertName,
            reportExcerpt: run.report.slice(0, SUMMARY_CHARS),
            startedAt: run.startedAt.toISOString(),
            endedAt: run.endedAt?.toISOString() ?? null,
          })),
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
