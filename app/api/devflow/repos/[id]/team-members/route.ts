// GET  /api/devflow/repos/:id/team-members — list team-member profiles
// POST /api/devflow/repos/:id/team-members — create a team member
// (legacy /{repo_id}/team-members endpoints on team_member Documents, now on
// the TeamMember table)
import { prisma } from "@/lib/db";
import { errorMessage, fail, failRaw, ok } from "@/lib/devflow/http";
import {
  TeamMemberCreateSchema,
  createTeamMember,
  listTeamMembers,
  teamMemberView,
} from "@/lib/devflow/team";

export { OPTIONS } from "@/lib/devflow/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const repo = await prisma.repository.findUnique({ where: { id } });
    if (!repo) return fail(404, "repoNotFound");
    const members = await listTeamMembers(id);
    return ok(members.map(teamMemberView));
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const repo = await prisma.repository.findUnique({ where: { id } });
    if (!repo) return fail(404, "repoNotFound");

    const parsed = TeamMemberCreateSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      return fail(400, "invalidRequest", {
        detail: parsed.error.issues.map((i) => i.message).join(", "),
      });
    }
    const outcome = await createTeamMember(id, parsed.data);
    if (!outcome.ok) {
      if (outcome.error === "duplicate") {
        return fail(409, "teamMemberExists");
      }
      return fail(404, "teamMemberNotFound");
    }
    return ok(teamMemberView(outcome.member), 201);
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
