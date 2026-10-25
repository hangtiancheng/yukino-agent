import { errorMessage, failRaw, ok } from "@/lib/dev-flow/http";
import { getSkillRegistry } from "@/lib/dev-flow/skills";

export { OPTIONS } from "@/lib/dev-flow/http";

interface RouteContext {
  params: Promise<{ name: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { name } = await context.params;
    const registry = await getSkillRegistry();
    const skill = registry.getSkill(name);
    if (!skill) {
      return failRaw(404, "Skill not found");
    }
    return ok({
      manifest: skill.manifest,
      path: skill.path,
      instructions: skill.instructions,
    });
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
