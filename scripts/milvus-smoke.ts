// Milvus smoke test: embed → lazy collection create → upsert → hybrid/dense
// retrieval → filtered delete. Run: npx tsx scripts/milvus-smoke.ts
import { indexChunks, deleteBySource } from "@/lib/milvus/indexer";
import { retrieve, retrieveDense } from "@/lib/milvus/retriever";
import { count, close } from "@/lib/milvus/client";

async function main() {
  const n = await indexChunks([
    {
      id: "smoke-1",
      content:
        "Milvus hybrid search combines dense vectors and BM25 sparse retrieval with RRF fusion.",
      metadata: { _source: "smoke-test", title: "milvus" },
    },
    {
      id: "smoke-2",
      content:
        "PostgreSQL stores relational data such as repositories, issues and pull requests.",
      metadata: { _source: "smoke-test", title: "postgres" },
    },
    {
      id: "smoke-3",
      content:
        "The OnCall assistant answers alerts using runbooks from the knowledge base.",
      metadata: { _source: "smoke-test", title: "oncall" },
    },
  ]);
  console.log("indexed:", n);

  const hybrid = await retrieve("how does hybrid vector search work?", 3);
  console.log(
    "hybrid top:",
    hybrid.map((d) => [d.id, d.score.toFixed(4)]),
  );
  if (hybrid[0]?.id !== "smoke-1") {
    throw new Error("hybrid retrieval did not rank the milvus chunk first");
  }

  const dense = await retrieveDense("relational database for issues", 3);
  console.log(
    "dense top:",
    dense.map((d) => [d.id, d.score.toFixed(4)]),
  );
  if (dense[0]?.id !== "smoke-2") {
    throw new Error("dense retrieval did not rank the postgres chunk first");
  }

  const filtered = await retrieve("anything", 10, `source == "smoke-test"`);
  console.log("filtered hits:", filtered.length);

  console.log("total in collection:", await count());
  await deleteBySource("smoke-test");
  console.log("after delete:", await count());
  await close();
  console.log("MILVUS SMOKE OK");
}

main().catch((e) => {
  console.error("SMOKE FAILED:", e);
  process.exit(1);
});
