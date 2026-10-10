import { prisma } from "@/lib/db";
import { Prisma, type AuditLog, type User } from "@/generated/prisma/client";

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
  constructor(public permission: Permission) {
    super(`Missing permission: ${permission}`);
    this.name = "PermissionError";
  }
}

export async function ensureDemoUser(): Promise<User> {
  const existing = await prisma.user.findFirst({
    orderBy: { createdAt: "asc" },
  });
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

const asJson = (value: unknown): Prisma.InputJsonValue =>
  value as Prisma.InputJsonValue;

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
