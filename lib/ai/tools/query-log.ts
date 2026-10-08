// Multi-connection MCP tool provider — restores the agent_py
// mcp_connections capability (multi-connection CRUD + connectivity probe +
// duplicate-tool detection) on top of the single-MCP_URL design.
//
// Connections come from two places:
//   1. the built-in log source: MCP_URL env (kept first for zero-config parity
//      with the previous single-connection behavior);
//   2. enabled rows in the McpConnection table (managed via /api/mcp_connections).
// Each connection is connected once and cached in-process; on failure the
// connection degrades to "no tools" with the error recorded (same honest
// fallback as the previous single-client code). Duplicate tool names across
// connections are renamed `<connection>__<tool>` instead of silently dropped.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { tool, jsonSchema, type Tool } from "ai";
import { z } from "zod/v4";
import { config } from "@/lib/config";
import { prisma } from "@/lib/db";

const CONNECT_TIMEOUT_MS = 15_000;

export const mcpConnectionInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(80)
    .regex(
      /^[A-Za-z0-9_-]+$/,
      "name may only contain letters, digits, _ and -",
    ),
  transport: z.enum(["sse", "http"]),
  url: z
    .string()
    .max(2000)
    .refine((value) => {
      try {
        const u = new URL(value);
        return u.protocol === "http:" || u.protocol === "https:";
      } catch {
        return false;
      }
    }, "url must be an absolute http(s) URL"),
  headers: z.record(z.string(), z.string().max(2000)).default({}),
  enabled: z.boolean().default(true),
});
export type McpConnectionInput = z.infer<typeof mcpConnectionInputSchema>;

interface ResolvedConnection {
  id: string; // "env" or the row id
  name: string;
  transport: "sse" | "http";
  url: string;
  headers: Record<string, string>;
}

const envHeaders: Record<string, string> = ((): Record<string, string> => {
  // Optional bearer token for the built-in log MCP server.
  const token = process.env.MCP_TOKEN ?? "";
  return token === "" ? {} : { Authorization: `Bearer ${token}` };
})();

function parseHeaders(raw: unknown): Record<string, string> {
  const parsed = z.record(z.string(), z.string()).safeParse(raw);
  return parsed.success ? parsed.data : {};
}

async function resolveConnections(): Promise<ResolvedConnection[]> {
  const list: ResolvedConnection[] = [];
  if (config.mcpUrl !== "") {
    list.push({
      id: "env",
      name: "logs",
      transport: "sse",
      url: config.mcpUrl,
      headers: envHeaders,
    });
  }
  try {
    const rows = await prisma.mcpConnection.findMany({
      where: { enabled: true },
      orderBy: { createdAt: "asc" },
    });
    for (const row of rows) {
      const transport = row.transport === "http" ? "http" : "sse";
      list.push({
        id: row.id,
        name: row.name,
        transport,
        url: row.url,
        headers: parseHeaders(row.headers),
      });
    }
  } catch (e) {
    // DB unavailable: fall back to the env connection only (never fail chat).
    console.warn(
      "[mcp] connection list unavailable, using env only:",
      e instanceof Error ? e.message : e,
    );
  }
  return list;
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function connectAndList(conn: ResolvedConnection): Promise<{
  client: Client;
  toolNames: string[];
}> {
  const url = new URL(conn.url);
  const requestInit = { headers: conn.headers };
  const transport =
    conn.transport === "http"
      ? new StreamableHTTPClientTransport(url, { requestInit })
      : new SSEClientTransport(url, { requestInit });
  const client = new Client(
    { name: "yukino-agent", version: "1.0.0" },
    { capabilities: {} },
  );
  await withTimeout(
    client.connect(transport),
    CONNECT_TIMEOUT_MS,
    `mcp connect ${conn.name}`,
  );
  const listed = await withTimeout(
    client.listTools(),
    CONNECT_TIMEOUT_MS,
    `mcp listTools ${conn.name}`,
  );
  return { client, toolNames: listed.tools.map((t) => t.name) };
}

const mcpInputSchemaShape = z.record(z.string(), z.unknown());

interface ConnectionCacheEntry {
  signature: string;
  tools: Record<string, Tool>;
  toolNames: string[];
  error?: string;
}

// In-process cache keyed by connection id; invalidated when the connection
// definition changes (signature) or on invalidateMcpConnections() (CRUD).
const cache = new Map<string, ConnectionCacheEntry>();
const liveClients = new Map<string, Client>();

function signature(conn: ResolvedConnection): string {
  return `${conn.transport}|${conn.url}|${JSON.stringify(conn.headers)}`;
}

async function getToolsForConnection(
  conn: ResolvedConnection,
): Promise<ConnectionCacheEntry> {
  const sig = signature(conn);
  const cached = cache.get(conn.id);
  if (cached && cached.signature === sig) return cached;

  const previous = liveClients.get(conn.id);
  if (previous) {
    await previous.close().catch(() => undefined);
    liveClients.delete(conn.id);
  }

  const entry: ConnectionCacheEntry = {
    signature: sig,
    tools: {},
    toolNames: [],
  };
  try {
    const { client, toolNames } = await connectAndList(conn);
    liveClients.set(conn.id, client);
    entry.toolNames = toolNames;
    const listed = await client.listTools();
    for (const t of listed.tools) {
      const toolName = t.name;
      const inputSchema = mcpInputSchemaShape.parse(t.inputSchema ?? {});
      entry.tools[toolName] = tool({
        description: t.description ?? toolName,
        inputSchema: jsonSchema(inputSchema),
        execute: async (input) => {
          const args = z.record(z.string(), z.unknown()).parse(input);
          const res = await client.callTool({
            name: toolName,
            arguments: args,
          });
          return JSON.stringify(res.content);
        },
      });
    }
  } catch (e) {
    entry.error = e instanceof Error ? e.message : String(e);
    console.warn(
      `[mcp] connection "${conn.name}" unavailable, skipping its tools:`,
      entry.error,
    );
  }
  cache.set(conn.id, entry);
  return entry;
}

// Drop every cached connection (called after CRUD so the next chat rebuilds).
export async function invalidateMcpConnections(): Promise<void> {
  cache.clear();
  const closing = [...liveClients.values()].map((c) =>
    c.close().catch(() => undefined),
  );
  liveClients.clear();
  await Promise.all(closing);
}

// Probe helper for the :check endpoint — never cached, always closed.
export async function checkMcpConnection(conn: {
  transport: "sse" | "http";
  url: string;
  headers: Record<string, string>;
  name: string;
}): Promise<{ ok: boolean; toolNames: string[]; message: string }> {
  try {
    const { client, toolNames } = await connectAndList({
      id: `check:${conn.name}`,
      ...conn,
    });
    await client.close().catch(() => undefined);
    return {
      ok: true,
      toolNames,
      message: `connected, ${toolNames.length} tools`,
    };
  } catch (e) {
    return {
      ok: false,
      toolNames: [],
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

// All MCP tools for the chat pipeline (kept export name for compatibility).
export async function getLogMcpTools(): Promise<Record<string, Tool>> {
  const connections = await resolveConnections();
  const merged: Record<string, Tool> = {};
  for (const conn of connections) {
    const entry = await getToolsForConnection(conn);
    for (const [name, t] of Object.entries(entry.tools)) {
      if (name in merged) {
        const renamed = `${conn.name}__${name}`;
        console.warn(
          `[mcp] duplicate tool "${name}" from connection "${conn.name}" exposed as "${renamed}"`,
        );
        merged[renamed] = t;
      } else {
        merged[name] = t;
      }
    }
  }
  return merged;
}

// Test/observability helper.
export async function closeLogMcpClient(): Promise<void> {
  await invalidateMcpConnections();
}
