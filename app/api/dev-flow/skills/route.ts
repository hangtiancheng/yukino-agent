import { errorMessage, failRaw, ok } from "@/lib/dev-flow/http";
import { getSkillRegistry } from "@/lib/dev-flow/skills";

export { OPTIONS } from "@/lib/dev-flow/http";

export async function GET() {
  try {
    const registry = await getSkillRegistry();
    return ok({
      skills: registry.listSkills().map((s) => ({
        manifest: s.manifest,
        path: s.path,
      })),
    });
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
