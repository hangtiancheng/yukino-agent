// PATCH  /api/devflow/repos/:id/team-members/:memberId — update a profile
// DELETE /api/devflow/repos/:id/team-members/:memberId — remove a member
import { prisma } from "@/lib/db";
import { errorMessage, fail, failRaw, ok } from "@/lib/devflow/http";
import {
  TeamMemberUpdateSchema,
  deleteTeamMember,
  teamMemberView,
  updateTeamMember,
} from "@/lib/devflow/team";

export { OPTIONS } from "@/lib/devflow/http";

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
    if (!(await repoExists(id))) return fail(404, "repoNotFound");

    const parsed = TeamMemberUpdateSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      return fail(400, "invalidRequest", {
        detail: parsed.error.issues.map((i) => i.message).join(", "),
      });
    }
    const outcome = await updateTeamMember(id, memberId, parsed.data);
    if (!outcome.ok) {
      return fail(404, "teamMemberNotFound");
    }
    return ok(teamMemberView(outcome.member));
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const { id, memberId } = await context.params;
    if (!(await repoExists(id))) return fail(404, "repoNotFound");

    const outcome = await deleteTeamMember(id, memberId);
    if (!outcome.ok) {
      return fail(404, "teamMemberNotFound");
    }
    return ok(teamMemberView(outcome.member));
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
