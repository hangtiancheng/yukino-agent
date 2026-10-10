import { prisma } from "@/lib/db";
import {
  approveMemoryCandidate,
  rejectMemoryCandidate,
  MemoryCandidateActionSchema,
} from "@/lib/devflow/memory";
import { errorMessage, fail, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

interface RouteContext {
  params: Promise<{ id: string; candidateId: string }>;
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { id, candidateId } = await context.params;
    const repo = await prisma.repository.findUnique({ where: { id } });
    if (!repo) return fail(404, "repoNotFound");
    const parsed = MemoryCandidateActionSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      return fail(400, "invalidRequest", {
        detail: parsed.error.issues.map((i) => i.message).join(", "),
      });
    }
    if (parsed.data.action === "approve") {
      const result = await approveMemoryCandidate(id, candidateId);
      if (!result) return fail(404, "memoryCandidateNotFound");
      return ok(result);
    }
    const candidate = await rejectMemoryCandidate(id, candidateId);
    if (!candidate) return fail(404, "memoryCandidateNotFound");
    return ok({ candidate, documentId: null, kbStatus: null, kbError: null });
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
