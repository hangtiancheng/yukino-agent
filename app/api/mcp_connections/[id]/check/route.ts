import { getTranslations } from "next-intl/server";
import { NextRequest } from "next/server";
import { z } from "zod/v4";
import { prisma } from "@/lib/db";
import { checkMcpConnection } from "@/lib/ai/tools/query-log";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const adhocSchema = z.object({
  transport: z.enum(["sse", "http"]).optional(),
  url: z.string().url().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, ctx: Ctx) {
  const t = await getTranslations("api.oncall");
  const { id } = await ctx.params;

  let target: {
    transport: "sse" | "http";
    url: string;
    headers: Record<string, string>;
    name: string;
  };
  if (id === "adhoc") {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { message: t("invalidJsonBody"), data: null },
        { status: 400, headers: CORS_HEADERS },
      );
    }
    const parsed = adhocSchema.safeParse(body);
    if (!parsed.success || !parsed.data.url) {
      return Response.json(
        { message: t("invalidMcpConnection"), data: null },
        { status: 400, headers: CORS_HEADERS },
      );
    }
    target = {
      transport: parsed.data.transport ?? "sse",
      url: parsed.data.url,
      headers: parsed.data.headers ?? {},
      name: "adhoc",
    };
  } else {
    const row = await prisma.mcpConnection.findUnique({ where: { id } });
    if (!row) {
      return Response.json(
        { message: t("mcpConnectionNotFound"), data: null },
        { status: 404, headers: CORS_HEADERS },
      );
    }
    const headers =
      row.headers &&
      typeof row.headers === "object" &&
      !Array.isArray(row.headers)
        ? Object.fromEntries(
            Object.entries(row.headers as Record<string, unknown>).map(
              ([k, v]) => [k, String(v)],
            ),
          )
        : {};
    target = {
      transport: row.transport === "http" ? "http" : "sse",
      url: row.url,
      headers,
      name: row.name,
    };
  }

  const result = await checkMcpConnection(target);
  if (id !== "adhoc") {
    await prisma.mcpConnection
      .update({
        where: { id },
        data: {
          lastCheckStatus: result.ok ? "ok" : "error",
          lastCheckMessage: result.message.slice(0, 1000),
          lastToolNames: result.toolNames,
          lastCheckedAt: new Date(),
        },
      })
      .catch(() => undefined);
  }
  const status = result.ok ? 200 : 502;
  return Response.json(
    { message: result.ok ? "OK" : result.message, data: result },
    { status, headers: CORS_HEADERS },
  );
}
