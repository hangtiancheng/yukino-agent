import { prisma } from "@/lib/db";

export const AUDIT_TEXT_CHARS = 500;

export function summarizeAuditText(value: unknown): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  const normalized = text.split(/\s+/).join(" ").trim();
  if (normalized.length <= AUDIT_TEXT_CHARS) return normalized;
  return `${normalized.slice(0, AUDIT_TEXT_CHARS - 3)}...`;
}

export interface ToolAuditInput {
  sessionId: string;
  turnIndex: number;
  toolName: string;
  source: "builtin" | "mcp";
  input: unknown;
  resultText: unknown;
  status: "success" | "error";
  durationMs: number;
}

/**
 * Fire-and-forget audit row. Shared by the OnCall chat pipeline (session id =
 * chat session) and the AI Ops pipeline (session id = `aiops:<runId>`), mirroring
 * the legacy `tool_call_audits` + `aiops_tool_call_audits` tables.
 */
export function recordToolAudit(input: ToolAuditInput): void {
  prisma.toolCallAudit
    .create({
      data: {
        sessionId: input.sessionId,
        turnIndex: input.turnIndex,
        toolName: input.toolName,
        source: input.source,
        inputJson: { input: summarizeAuditText(input.input) },
        resultText: summarizeAuditText(input.resultText),
        status: input.status,
        durationMs: input.durationMs,
      },
    })
    .catch((e: unknown) => {
      console.warn(
        "[tool-audit] audit write failed:",
        e instanceof Error ? e.message : String(e),
      );
    });
}
