import { prisma } from "@/lib/db";
import { AuditLogsQuerySchema } from "@/lib/devflow/schemas";
import { PermissionError, requirePermission } from "@/lib/devflow/permissions";
import { errorMessage, fail, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

export async function GET(request: Request) {
  try {
    await requirePermission("settings:manage");
  } catch (e) {
    if (e instanceof PermissionError) return failRaw(403, e.message);
    return failRaw(500, errorMessage(e));
  }

  try {
    const url = new URL(request.url);
    const parsed = AuditLogsQuerySchema.safeParse(
      Object.fromEntries(url.searchParams),
    );
    if (!parsed.success) {
      return fail(400, "invalidRequest", {
        detail: parsed.error.issues.map((i) => i.message).join(", "),
      });
    }
    const { repoId, action, limit } = parsed.data;
    const rows = await prisma.auditLog.findMany({
      where: {
        ...(repoId ? { repoId } : {}),
        ...(action ? { action } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { user: { select: { name: true, role: true } } },
    });
    return ok(
      rows.map((row) => ({
        id: row.id,
        userId: row.userId,
        userName: row.user?.name ?? null,
        userRole: row.user?.role ?? null,
        repoId: row.repoId,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        status: row.status,
        requestJson: row.requestJson,
        resultJson: row.resultJson,
        createdAt: row.createdAt,
      })),
    );
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
