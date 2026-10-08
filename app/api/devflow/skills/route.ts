// GET /api/devflow/skills — list the registered DevFlow skills (manifest +
// path, without the full instruction body). Port of legacy routes/skills.py
// list_skills. The legacy /mcp-status probe targeted the stdio MCP memory
// subprocess, which is replaced by in-process tools here (Yukino.md #25), so
// it is not ported.
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
