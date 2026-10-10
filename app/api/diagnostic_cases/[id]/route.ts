import path from "node:path";
import { readFile } from "node:fs/promises";
import { getTranslations } from "next-intl/server";
import { prisma } from "@/lib/db";
import { config } from "@/lib/config";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, ctx: Ctx) {
  const t = await getTranslations("api.oncall");
  const { id } = await ctx.params;
  try {
    const record = await prisma.diagnosticCaseRecord.findUnique({
      where: { id },
    });
    if (!record) {
      return Response.json(
        { message: t("historyUnavailable"), data: null },
        { status: 404, headers: CORS_HEADERS },
      );
    }
    let body = "";
    const baseName = path.basename(record.fileName);
    if (baseName.startsWith("aiops-case-") && baseName.endsWith(".md")) {
      const full = path.resolve(config.fileDir, baseName);
      body = await readFile(full, "utf8").catch(() => "");
    }
    return Response.json(
      {
        message: "OK",
        data: {
          id: record.id,
          hash: record.hash,
          title: record.title,
          alertName: record.alertName,
          summary: record.summary,
          keywords: record.keywords,
          fileName: record.fileName,
          body,
          createdAt: record.createdAt,
        },
      },
      { headers: CORS_HEADERS },
    );
  } catch (e) {
    console.error("[/api/diagnostic_cases/:id] error:", e);
    return Response.json(
      { message: t("historyUnavailable"), data: null },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
