// Offline smoke test for the DevFlow skill registry port (legacy
// services/skills/registry.py). Verifies SKILL.md loading + frontmatter
// parsing, trigger/explicit activation, the catalog prompt and the injected
// instruction block. No network/DB/Milvus required:
//   npx tsx tests/devflow-skills.smoke.ts
import assert from "node:assert/strict";
import {
  getSkillRegistry,
  resetSkillRegistry,
  SkillRegistry,
} from "@/lib/devflow/skills";

async function main() {
  resetSkillRegistry();
  const registry = await getSkillRegistry();
  const skills = registry.listSkills();

  // The six bundled playbooks load and are name-sorted.
  const names = skills.map((s) => s.manifest.name);
  assert.ok(names.length >= 6, `expected >=6 skills, got ${names.length}`);
  for (const expected of [
    "ci-debug",
    "issue-triage",
    "pr-review",
    "project-investigation",
    "safety-draft",
    "weekly-report",
  ]) {
    assert.ok(names.includes(expected), `missing skill ${expected}`);
  }
  assert.deepEqual(
    names,
    [...names].sort((a, b) => a.localeCompare(b)),
    "skills are name-sorted",
  );

  // Frontmatter parsed into a full manifest.
  const triage = registry.getSkill("issue-triage");
  assert.ok(triage, "issue-triage found");
  assert.equal(triage!.manifest.title, "Issue Triage");
  assert.equal(triage!.manifest.safetyLevel, "read_only");
  assert.ok(triage!.manifest.tools.includes("get_issue"), "tools parsed");
  assert.ok(triage!.manifest.triggers.includes("issue"), "triggers parsed");
  assert.ok(
    triage!.manifest.workflowSteps.includes("classify_impact_and_type"),
    "workflow_steps parsed",
  );
  assert.ok(triage!.instructions.includes("Issue Triage"), "body kept");

  // getSkill is case-insensitive on name.
  assert.ok(registry.getSkill("PR-REVIEW"), "case-insensitive lookup");
  assert.equal(
    registry.getSkill("nope"),
    undefined,
    "unknown skill -> undefined",
  );

  // Trigger-based activation: an ASCII trigger on a word boundary fires.
  const autoCi = await registry.activate("why did the ci workflow fail?");
  assert.ok(autoCi.length > 0, "ci triggers activate");
  assert.ok(
    autoCi.some((a) => a.skillName === "ci-debug"),
    "ci-debug activated by trigger",
  );
  assert.equal(autoCi[0]!.activationMode, "automatic");

  // A CJK trigger fires for the weekly report.
  const autoReport = await registry.activate("帮我生成本周周报");
  assert.ok(
    autoReport.some((a) => a.skillName === "weekly-report"),
    "weekly-report activated by CJK trigger",
  );

  // Explicit request by name wins over triggers.
  const explicit = await registry.activate("anything", "pr-review");
  assert.equal(explicit.length, 1, "explicit single activation");
  assert.equal(explicit[0]!.skillName, "pr-review");
  assert.equal(explicit[0]!.activationMode, "explicit");

  // Explicit request for an unknown skill fails honestly (async rejection).
  await assert.rejects(
    () => registry.activate("x", "does-not-exist"),
    /not found/i,
    "unknown explicit skill rejects",
  );

  // Word-boundary: "civic" must not match the "ci" trigger.
  const noMatch = await registry.activate(
    "a civic duty discussion about nothing technical",
  );
  assert.ok(
    !noMatch.some((a) => a.skillName === "ci-debug"),
    "ci trigger respects word boundaries",
  );

  // Catalog + injected block render.
  const catalog = registry.promptContext();
  assert.ok(catalog.includes("issue-triage"), "catalog lists skills");
  const block = SkillRegistry.renderPromptBlock(autoCi);
  assert.ok(block.includes("CI Debug"), "block renders title");
  assert.ok(
    block.includes("Activation: automatic"),
    "block notes activation mode",
  );
  assert.equal(
    SkillRegistry.renderPromptBlock([]),
    "",
    "empty activations -> empty block",
  );

  // Activation carries a stable instruction digest.
  assert.match(
    autoCi[0]!.instructionDigest,
    /^[0-9a-f]{16}$/,
    "digest is 16 hex chars",
  );

  console.log("DEVFLOW SKILLS SMOKE OK");
}

void main();
