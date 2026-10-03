// Smoke test for DevFlow Category B project-indexing (non-embedding parts):
// discovery, classification, summary building, and chunking against a real
// checkout. Run: npx tsx scripts/devflow-b-smoke.ts <checkoutDir>
import { discoverProjectDocs, buildSummary } from "../lib/devflow/project-index";
import { chunkText } from "../lib/devflow/rag";

async function main() {
  const checkout =
    process.argv[2] ??
    "/Users/hangtiancheng/github/yukino-agent/data/workspaces/0cea0ff1-de28-43af-9c5b-9e4f6e7b3cf9-sindresorhus__is";

  console.log("checkout:", checkout);
  const docs = await discoverProjectDocs(checkout, 500);
  console.log("discovered docs:", docs.length);
  const byType: Record<string, number> = {};
  for (const d of docs) byType[d.sourceType] = (byType[d.sourceType] ?? 0) + 1;
  console.log("by sourceType:", JSON.stringify(byType));
  console.log(
    "first 10:",
    docs.slice(0, 10).map((d) => `${d.sourceType}/${d.tier} ${d.rel}`),
  );

  const summary = await buildSummary(checkout, docs);
  console.log("techStack:", JSON.stringify(summary.techStack));
  console.log("topDirs:", JSON.stringify(summary.topDirs));
  console.log("coverage:", JSON.stringify(summary.sourceTypeCoverage));

  // Prove chunking works on a discovered doc (readme).
  const readme = docs.find((d) => d.sourceType === "readme");
  if (readme) {
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const text = await readFile(path.join(checkout, readme.rel), "utf8");
    const chunks = chunkText(text);
    console.log(
      `chunked ${readme.rel}: ${text.length} chars -> ${chunks.length} chunks (first ${chunks[0]?.length ?? 0} chars)`,
    );
  }
  console.log("DEVFLOW-B SMOKE OK");
}

main().catch((e) => {
  console.error("SMOKE FAILED:", e);
  process.exit(1);
});
