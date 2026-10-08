// GET /api/devflow/analyses?targetType=&targetId= — saved analysis history
// for one target, newest first.
import { z } from "zod/v4";
import { prisma } from "@/lib/db";
import { errorMessage, fail, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

const querySchema = z.object({
  targetType: z.enum(["issue", "pull_request", "workflow_run"]),
  targetId: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const parsed = querySchema.safeParse({
      targetType: url.searchParams.get("targetType"),
      targetId: url.searchParams.get("targetId"),
      limit: url.searchParams.get("limit") ?? undefined,
    });
    if (!parsed.success) {
      return fail(400, "invalidQuery", {
        detail: parsed.error.issues.map((i) => i.message).join(", "),
      });
    }
    const rows = await prisma.analysisResult.findMany({
      where: {
        targetType: parsed.data.targetType,
        targetId: parsed.data.targetId,
      },
      orderBy: { createdAt: "desc" },
      take: parsed.data.limit,
    });
    return ok(
      rows.map((row) => ({
        id: row.id,
        analysisType: row.analysisType,
        result: row.resultJson,
        modelName: row.modelName,
        createdAt: row.createdAt,
      })),
    );
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
