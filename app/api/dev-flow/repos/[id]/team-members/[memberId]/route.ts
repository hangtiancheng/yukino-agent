import { prisma } from "@/lib/db";
import { errorMessage, fail, failRaw, ok } from "@/lib/dev-flow/http";
import {
  TeamMemberUpdateSchema,
  deleteTeamMember,
  teamMemberView,
  updateTeamMember,
} from "@/lib/dev-flow/team";

export { OPTIONS } from "@/lib/dev-flow/http";

interface RouteContext {
  params: Promise<{ id: string; memberId: string }>;
}

async function repoExists(repoId: string): Promise<boolean> {
  const repo = await prisma.repository.findUnique({ where: { id: repoId } });
  return repo !== null;
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { id, memberId } = await context.params;
    if (!(await repoExists(id))) {
      return await fail(404, "repoNotFound");
    }

    const parsed = TeamMemberUpdateSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      return await fail(400, "invalidRequest", {
        detail: parsed.error.issues.map((i) => i.message).join(", "),
      });
    }
    const outcome = await updateTeamMember(id, memberId, parsed.data);
    if (!outcome.ok) {
      return await fail(404, "teamMemberNotFound");
    }
    return ok(teamMemberView(outcome.member));
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const { id, memberId } = await context.params;
    if (!(await repoExists(id))) {
      return await fail(404, "repoNotFound");
    }

    const outcome = await deleteTeamMember(id, memberId);
    if (!outcome.ok) {
      return await fail(404, "teamMemberNotFound");
    }
    return ok(teamMemberView(outcome.member));
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
