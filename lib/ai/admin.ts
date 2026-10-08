// Admin gate for mutating OnCall operational surfaces.
// The product is public with no login (AGENTS.md); endpoints that change
// server-side configuration (MCP connections) or expose audit trails require
// the ONCALL_ADMIN_TOKEN bearer/`x-admin-token` header when the token is
// configured. When no token is configured, guarded mutations are disabled
// outright (fail-closed) rather than left open.
import { timingSafeEqual } from "node:crypto";
import { config } from "@/lib/config";

function tokenMatches(candidate: string): boolean {
  const expected = config.oncallAdminToken;
  if (expected === "") return false;
  const a = Buffer.from(candidate, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Returns null when authorized, otherwise the reason code for the response:
// "not_configured" (no token set -> mutations disabled) or "unauthorized".
export function requireOncallAdmin(
  request: Request,
): "not_configured" | "unauthorized" | null {
  if (config.oncallAdminToken === "") return "not_configured";
  const bearer = request.headers.get("authorization");
  if (bearer?.toLowerCase().startsWith("bearer ")) {
    if (tokenMatches(bearer.slice(7).trim())) return null;
  }
  const header = request.headers.get("x-admin-token");
  if (header && tokenMatches(header)) return null;
  return "unauthorized";
}
