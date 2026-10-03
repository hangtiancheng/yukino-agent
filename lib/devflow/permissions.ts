// Role-based permissions + audit trail. Port of the Python permissions.py.
// FastAPI's `Depends(require_permission(...))` becomes an async helper that a
// route awaits; it throws PermissionError (mapped to HTTP 403) when denied.
import { prisma } from "@/lib/db";
import {
  Prisma,
  type AuditLog,
  type User,
} from "@/generated/prisma/client";

export type Permission =
  | "repo:read"
  | "repo:sync"
  | "agent:run"
  | "draft:create"
  | "draft:approve"
  | "eval:read"
  | "settings:manage";

export const ROLE_PERMISSIONS: Record<string, ReadonlySet<Permission>> = {
  owner: new Set<Permission>([
    "repo:read",
    "repo:sync",
    "agent:run",
    "draft:create",
    "draft:approve",
    "eval:read",
    "settings:manage",
  ]),
  maintainer: new Set<Permission>([
    "repo:read",
    "repo:sync",
    "agent:run",
    "draft:create",
    "draft:approve",
    "eval:read",
  ]),
  developer: new Set<Permission>([
    "repo:read",
    "agent:run",
    "draft:create",
    "eval:read",
  ]),
  viewer: new Set<Permission>(["repo:read", "eval:read"]),
};

export class PermissionError extends Error {
  constructor(
    public permission: Permission,
  ) {
    super(`Missing permission: ${permission}`);
    this.name = "PermissionError";
  }
}

// Single-tenant dev model: the first user is the acting principal. Created on
// demand as an owner so a fresh install is usable without a signup flow.
export async function ensureDemoUser(): Promise<User> {
  const existing = await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
  if (existing) {
    if (!existing.role) {
      return prisma.user.update({
        where: { id: existing.id },
        data: { role: "owner" },
      });
    }
    return existing;
  }
  return prisma.user.create({ data: { name: "demo-owner", role: "owner" } });
}

export function hasPermission(user: User, permission: Permission): boolean {
  const role = (user.role || "viewer").toLowerCase();
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

// Resolve the acting user and assert a permission. Returns the user on success.
export async function requirePermission(permission: Permission): Promise<User> {
  const user = await ensureDemoUser();
  if (!hasPermission(user, permission)) {
    throw new PermissionError(permission);
  }
  return user;
}

export interface AuditLogInput {
  user?: User | null;
  repoId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  status?: "success" | "failed" | "denied";
  requestJson?: Record<string, unknown> | null;
  resultJson?: Record<string, unknown> | null;
}

// Prisma's InputJsonValue rejects `unknown` leaves; the persisted payloads are
// already JSON-serializable, so assert once at the boundary.
const asJson = (value: unknown): Prisma.InputJsonValue =>
  value as Prisma.InputJsonValue;

// Append an audit row. Failures are swallowed by callers that must not let
// auditing break the primary operation; this function itself does throw on a
// real DB error so the caller decides.
export async function writeAuditLog(input: AuditLogInput): Promise<AuditLog> {
  return prisma.auditLog.create({
    data: {
      userId: input.user?.id ?? null,
      repoId: input.repoId ?? null,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      status: input.status ?? "success",
      ...(input.requestJson ? { requestJson: asJson(input.requestJson) } : {}),
      ...(input.resultJson ? { resultJson: asJson(input.resultJson) } : {}),
    },
  });
}
