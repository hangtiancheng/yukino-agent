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
