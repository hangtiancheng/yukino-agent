// MCP log tools via SSE —
// connects to the MCP server, lists tools, and wraps each as an AI SDK tool.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { tool, jsonSchema, type Tool } from "ai";
import { z } from "zod/v4";
import { config } from "@/lib/config";

let cachedClient: Client | null = null;
let cachedTools: Record<string, Tool> | null = null;

// MCP inputSchema comes back as an unknown object; validate it is a record
// before handing it to jsonSchema().
const mcpInputSchemaShape = z.record(z.string(), z.unknown());

export async function getLogMcpTools(): Promise<Record<string, Tool>> {
  if (cachedTools) return cachedTools;

  try {
    const transport = new SSEClientTransport(new URL(config.mcpUrl));
    const client = new Client(
      { name: "yukino-agent", version: "1.0.0" },
      { capabilities: {} },
    );
    await client.connect(transport);
    cachedClient = client;

    const { tools } = await client.listTools();
    const result: Record<string, Tool> = {};
    for (const t of tools) {
      const toolName = t.name;
      const inputSchema = mcpInputSchemaShape.parse(t.inputSchema ?? {});
      result[toolName] = tool({
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

    cachedTools = result;
    return result;
  } catch (e) {
    // MCP server unavailable — degrade gracefully.
    console.warn(
      "[mcp] failed to connect, skipping log tools:",
      e instanceof Error ? e.message : e,
    );
    cachedTools = {};
    return cachedTools;
  }
}

export async function closeLogMcpClient(): Promise<void> {
  if (cachedClient) {
    await cachedClient.close();
    cachedClient = null;
    cachedTools = null;
  }
}
