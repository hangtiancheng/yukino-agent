// PATCH/DELETE /api/mcp_connections/[id] — admin-gated updates (port of the
// agent_py mcp_connections CRUD).
import { getTranslations } from "next-intl/server";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireOncallAdmin } from "@/lib/ai/admin";
import {
  mcpConnectionInputSchema,
  invalidateMcpConnections,
} from "@/lib/ai/tools/query-log";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-admin-token",
};

type OncallKey =
  | "adminNotConfigured"
  | "adminUnauthorized"
  | "invalidJsonBody"
  | "invalidMcpConnection"
  | "mcpConnectionNameTaken"
  | "mcpConnectionNotFound";

async function fail(status: number, key: OncallKey) {
  const t = await getTranslations("api.oncall");
  return Response.json(
    { message: t(key), data: null },
    { status, headers: CORS_HEADERS },
  );
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, ctx: Ctx) {
  const admin = requireOncallAdmin(request);
  if (admin)
    return admin === "not_configured"
      ? fail(403, "adminNotConfigured")
      : fail(401, "adminUnauthorized");

  const { id } = await ctx.params;
  const row = await prisma.mcpConnection.findUnique({ where: { id } });
  if (!row) return fail(404, "mcpConnectionNotFound");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "invalidJsonBody");
  }
  // Partial update: same shape but every field optional except identity.
  const parsed = mcpConnectionInputSchema.partial().safeParse(body);
  if (!parsed.success) return fail(400, "invalidMcpConnection");

  const updated = await prisma.mcpConnection.update({
    where: { id },
    data: {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.transport !== undefined
        ? { transport: parsed.data.transport }
        : {}),
      ...(parsed.data.url !== undefined ? { url: parsed.data.url } : {}),
      ...(parsed.data.headers !== undefined
        ? { headers: parsed.data.headers }
        : {}),
      ...(parsed.data.enabled !== undefined
        ? { enabled: parsed.data.enabled }
        : {}),
    },
  });
  await invalidateMcpConnections();
  return Response.json(
    { message: "OK", data: { id: updated.id, name: updated.name } },
    { headers: CORS_HEADERS },
  );
}

export async function DELETE(request: NextRequest, ctx: Ctx) {
  const admin = requireOncallAdmin(request);
  if (admin)
    return admin === "not_configured"
      ? fail(403, "adminNotConfigured")
      : fail(401, "adminUnauthorized");

  const { id } = await ctx.params;
  const row = await prisma.mcpConnection.findUnique({ where: { id } });
  if (!row) return fail(404, "mcpConnectionNotFound");
  await prisma.mcpConnection.delete({ where: { id } });
  await invalidateMcpConnections();
  return Response.json(
    { message: "OK", data: { deleted: id } },
    { headers: CORS_HEADERS },
  );
}
