import { getSkillRegistry } from "@/lib/devflow/skills";
import { errorMessage, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

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
