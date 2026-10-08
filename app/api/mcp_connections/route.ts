// GET/POST /api/mcp_connections — administrator-managed MCP connections
// (port of the agent_py mcp_connections CRUD + duplicate-aware tool listing).
// Reads are public; writes require ONCALL_ADMIN_TOKEN (fail-closed when unset:
// the product is public/no-login, and these rows steer server-side outbound
// connections).
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
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-admin-token",
};

// Header values may carry credentials — never echo them back verbatim.
function sanitizeRow(row: {
  id: string;
  name: string;
  transport: string;
  url: string;
  headers: unknown;
  enabled: boolean;
  lastCheckStatus: string;
  lastCheckMessage: string | null;
  lastToolNames: unknown;
  lastCheckedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  const headers =
    row.headers && typeof row.headers === "object"
      ? Object.fromEntries(
          Object.keys(row.headers as Record<string, unknown>).map((k) => [
            k,
            "***",
          ]),
        )
      : {};
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    url: row.url,
    headerNames: Object.keys(headers),
    enabled: row.enabled,
    lastCheckStatus: row.lastCheckStatus,
    lastCheckMessage: row.lastCheckMessage,
    lastToolNames: Array.isArray(row.lastToolNames) ? row.lastToolNames : [],
    lastCheckedAt: row.lastCheckedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

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

export async function GET() {
  try {
    const rows = await prisma.mcpConnection.findMany({
      orderBy: { createdAt: "asc" },
    });
    return Response.json(
      { message: "OK", data: rows.map(sanitizeRow) },
      { headers: CORS_HEADERS },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return Response.json(
      { message, data: null },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}

export async function POST(request: NextRequest) {
  const admin = requireOncallAdmin(request);
  if (admin)
    return admin === "not_configured"
      ? fail(403, "adminNotConfigured")
      : fail(401, "adminUnauthorized");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "invalidJsonBody");
  }
  const parsed = mcpConnectionInputSchema.safeParse(body);
  if (!parsed.success) return fail(400, "invalidMcpConnection");

  const existing = await prisma.mcpConnection.findUnique({
    where: { name: parsed.data.name },
  });
  if (existing) return fail(409, "mcpConnectionNameTaken");

  try {
    const row = await prisma.mcpConnection.create({
      data: {
        name: parsed.data.name,
        transport: parsed.data.transport,
        url: parsed.data.url,
        headers: parsed.data.headers,
        enabled: parsed.data.enabled,
      },
    });
    await invalidateMcpConnections();
    return Response.json(
      { message: "OK", data: sanitizeRow(row) },
      { headers: CORS_HEADERS },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return Response.json(
      { message, data: null },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
