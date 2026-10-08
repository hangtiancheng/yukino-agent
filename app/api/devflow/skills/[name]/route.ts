// GET /api/devflow/skills/:name — one skill with its full instruction body
// (legacy routes/skills.py get_skill, include_instructions=True).
import { getSkillRegistry } from "@/lib/devflow/skills";
import { errorMessage, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

interface RouteContext {
  params: Promise<{ name: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { name } = await context.params;
    const registry = await getSkillRegistry();
    const skill = registry.getSkill(name);
    if (!skill) return failRaw(404, "Skill not found");
    return ok({
      manifest: skill.manifest,
      path: skill.path,
      instructions: skill.instructions,
    });
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
