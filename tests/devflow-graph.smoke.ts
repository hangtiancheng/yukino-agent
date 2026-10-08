/**
 * Smoke for the DevFlow knowledge graph port
 * (lib/devflow/knowledge-graph.ts — legacy
 * DevFlow-AI/backend/app/services/knowledge_graph.py):
 *  1. #N reference extraction (legacy ISSUE_REF_RE) — word-glued/branched
 *     refs stay out, dangling numbers create no edge;
 *  2. closing-keyword extraction (legacy CLOSING_ISSUE_RE);
 *  3. decision-line heuristic ("决定" / "decision:" prefixes);
 *  4. deriveEdges fixture pass: references / resolves / assigned_to
 *     (team_member vs github_user, case-insensitive) / authored_by /
 *     documents (name + resolved weekly-report body) / decides, with the
 *     per-relation confidence + "sync" source and dedup/self-loop guards;
 *  5. bfsSubgraphKeys: depth bands, GRAPH_NODE_LIMIT truncation,
 *     unknown-center fallback;
 *  6. node-type aliases + the route zod contracts.
 * Optional live section (DEVFLOW_GRAPH_SMOKE_PG=1, needs the local
 * PostgreSQL): row-level rebuild verification — relation counts, team vs
 * github-user targets, rebuild idempotency (deleteMany + createMany
 * skipDuplicates), summary/subgraph reads, then cascade cleanup.
 * Run: npx tsx tests/devflow-graph.smoke.ts
 */
import assert from "node:assert/strict";
import {
  EDGE_SOURCE,
  GRAPH_NODE_LIMIT,
  GraphActionSchema,
  RELATION_CONFIDENCE,
  SubgraphQuerySchema,
  bfsSubgraphKeys,
  deriveEdges,
  extractClosingRefs,
  extractDecisionLines,
  extractIssueRefs,
  nodeKey,
  normalizeNodeType,
  fetchSubgraph,
  graphSummary,
  rebuildGraph,
  type GraphIssueInput,
  type GraphMessageInput,
  type GraphPrInput,
  type GraphDocumentInput,
  type GraphSnapshot,
  type GraphTeamMemberInput,
} from "@/lib/devflow/knowledge-graph";

let checks = 0;
function ok(name: string): void {
  checks += 1;
  console.log(`  ok  ${name}`);
}

// ---------------------------------------------------------------------------
// 1-3. text extraction (legacy knowledge_graph.py:24-29, 517-526)
// ---------------------------------------------------------------------------
{
  assert.deepEqual(extractIssueRefs("fix #12 and #13, also #12"), [12, 13]);
  assert.deepEqual(extractIssueRefs(""), []);
  assert.deepEqual(extractIssueRefs("branch feature#14 done"), []);
  assert.deepEqual(extractIssueRefs("#15x is not a ref"), []);
  assert.deepEqual(extractIssueRefs("## heading only"), []);
  assert.deepEqual(extractIssueRefs("PR #10 for issue #3"), [3, 10]);
  ok("extractIssueRefs: lookbehind + word boundary, unique ascending");

  assert.deepEqual(extractClosingRefs("Closes #1"), [1]);
  assert.deepEqual(extractClosingRefs("fixes #2"), [2]);
  assert.deepEqual(extractClosingRefs("FIXED #3"), [3]);
  assert.deepEqual(extractClosingRefs("resolve issue #4"), [4]);
  assert.deepEqual(extractClosingRefs("resolved #5, closed #6"), [5, 6]);
  assert.deepEqual(extractClosingRefs("will close #7 soon"), [7]);
  assert.deepEqual(extractClosingRefs("unfixes #8"), []);
  assert.deepEqual(extractClosingRefs("fix: #9"), []);
  ok("extractClosingRefs: all closing keywords, prefix/colon guards");

  assert.deepEqual(
    extractDecisionLines(
      "分析如下\n决定: 先修 #1\nDecision: ship #2\n#3 noted",
    ),
    ["决定: 先修 #1", "Decision: ship #2"],
  );
  assert.deepEqual(extractDecisionLines("no decision here"), []);
  ok("extractDecisionLines: 决定 / decision: prefixes only");
}

// ---------------------------------------------------------------------------
// 4. deriveEdges fixture pass
// ---------------------------------------------------------------------------
const issues: GraphIssueInput[] = [
  {
    id: "i1",
    number: 1,
    title: "Login crashes on submit",
    // self-reference must not produce a self-loop (legacy add_edge guard).
    body: "tracking #1 forever",
    author: "alice",
    // "Bob" matches the team member case-insensitively; blank is skipped.
    assignees: ["Bob", "carol", " "],
  },
  {
    id: "i2",
    number: 2,
    title: "Duplicate of #1",
    body: null,
    author: "alice",
    assignees: [],
  },
  {
    id: "i3",
    number: 3,
    title: "Refactor queue",
    body: "see #999 (dangling)",
    author: null,
    assignees: [],
  },
];
const pullRequests: GraphPrInput[] = [
  {
    id: "p10",
    number: 10,
    title: "Fix login",
    body: "Closes #1\nSee also #2",
    author: "dave",
  },
  {
    id: "p11",
    number: 11,
    title: "Follow-up",
    body: "Related PR #10 for issue #3",
    author: "erin",
  },
];
const documents: GraphDocumentInput[] = [
  { id: "d1", name: "Weekly Report W39", content: "Shipped #10, queued #2." },
  // name-only extraction still works when the body is unavailable.
  { id: "d2", name: "Weekly Report W40 mentions #3", content: null },
  { id: "d3", name: "Weekly Report W41", content: "no refs here" },
];
const messages: GraphMessageInput[] = [
  {
    id: "m1",
    conversationId: "c1",
    content: "分析如下\n决定: 先修 #1, 下周处理 #2\nDecision: close #3 later",
  },
  // #N outside a decision line creates no decides edge.
  { id: "m2", conversationId: "c1", content: "#1 is progressing, no decision" },
  // dangling ref inside a decision line → no edge (best-effort).
  { id: "m3", conversationId: "c2", content: "决定: 与 #999 无关" },
];
const teamMembers: GraphTeamMemberInput[] = [
  { id: "tm-bob", githubLogin: "bob" },
];

const snapshot: GraphSnapshot = {
  issues,
  pullRequests,
  documents,
  messages,
  teamMembers,
};
const derived = deriveEdges(snapshot);
const find = (
  fromType: string,
  fromId: string,
  toType: string,
  toId: string,
  relation: string,
) =>
  derived.find(
    (e) =>
      e.fromType === fromType &&
      e.fromId === fromId &&
      e.toType === toType &&
      e.toId === toId &&
      e.relation === relation,
  );

{
  // references: issue→issue, PR→issue, PR→PR; closing refs excluded; self
  // and dangling refs skipped.
  assert.equal(derived.filter((e) => e.relation === "references").length, 4);
  assert.ok(find("issue", "i2", "issue", "i1", "references"));
  assert.ok(find("pull_request", "p10", "issue", "i2", "references"));
  assert.ok(find("pull_request", "p11", "pull_request", "p10", "references"));
  assert.ok(find("pull_request", "p11", "issue", "i3", "references"));
  assert.equal(
    find("pull_request", "p10", "issue", "i1", "references"),
    undefined,
  );
  assert.equal(find("issue", "i1", "issue", "i1", "references"), undefined);
  assert.equal(find("issue", "i3", "issue", "i999", "references"), undefined);
  ok(
    "references edges: #N resolution, closing exclusion, self/dangling guards",
  );

  // resolves: closing keyword → issue only.
  const resolves = derived.filter((e) => e.relation === "resolves");
  assert.equal(resolves.length, 1);
  assert.deepEqual(
    [resolves[0].fromId, resolves[0].toType, resolves[0].toId],
    ["p10", "issue", "i1"],
  );
  assert.equal(resolves[0].confidence, 0.9);
  assert.equal(resolves[0].meta.number, 1);
  ok("resolves edge: closing keyword targets the issue at 0.9");

  // assigned_to: team member wins (case-insensitive), otherwise github_user.
  assert.ok(find("issue", "i1", "team_member", "tm-bob", "assigned_to"));
  assert.ok(find("issue", "i1", "github_user", "carol", "assigned_to"));
  assert.equal(derived.filter((e) => e.relation === "assigned_to").length, 2);
  ok("assigned_to edges: TeamMember match vs github_user fallback");

  // authored_by for issues and PRs; null author skipped.
  const authored = derived.filter((e) => e.relation === "authored_by");
  assert.deepEqual(
    authored.map((e) => `${e.fromType}:${e.fromId}->${e.toId}`).sort(),
    [
      "issue:i1->alice",
      "issue:i2->alice",
      "pull_request:p10->dave",
      "pull_request:p11->erin",
    ],
  );
  assert.ok(authored.every((e) => e.toType === "github_user"));
  ok("authored_by edges: issue + PR authors as github_user");

  // documents: weekly reports only, body + name, resolving #N both ways.
  const docs = derived.filter((e) => e.relation === "documents");
  assert.deepEqual(
    docs.map((e) => `${e.fromId}->${e.toType}:${e.toId}`).sort(),
    ["d1->issue:i2", "d1->pull_request:p10", "d2->issue:i3"],
  );
  assert.ok(docs.every((e) => e.confidence === 0.8));
  ok("documents edges: weekly-report name/body refs at 0.8");

  // decides: decision lines only, one edge per referenced item.
  const decides = derived.filter((e) => e.relation === "decides");
  assert.deepEqual(decides.map((e) => e.toId).sort(), ["i1", "i2", "i3"]);
  assert.ok(
    decides.every((e) => e.fromType === "conversation" && e.fromId === "c1"),
  );
  assert.ok(decides.every((e) => e.confidence === 0.6));
  assert.ok(decides.every((e) => e.meta.messageId === "m1"));
  ok("decides edges: conversation decisions at 0.6, best-effort");

  // every edge carries the "sync" source and the table's confidence.
  assert.ok(derived.every((e) => e.source === EDGE_SOURCE));
  assert.ok(
    derived.every((e) => e.confidence === RELATION_CONFIDENCE[e.relation]),
  );
  const nodeCount = new Set(
    derived.flatMap((e) => [
      nodeKey(e.fromType, e.fromId),
      nodeKey(e.toType, e.toId),
    ]),
  ).size;
  assert.equal(nodeCount, 13);
  ok("confidence table + sync source + 13 distinct nodes");
}

{
  // duplicate mentions merge into ONE edge (legacy add_edge dedup).
  const dup = deriveEdges({
    issues: [
      {
        id: "a",
        number: 5,
        title: "t",
        body: "#7 and again #7",
        author: null,
        assignees: [],
      },
    ],
    pullRequests: [
      { id: "b", number: 7, title: "p", body: null, author: null },
    ],
    documents: [],
    messages: [],
    teamMembers: [],
  });
  assert.equal(dup.length, 1);
  assert.equal(dup[0].relation, "references");
  ok("deriveEdges dedups repeated mentions");
}

// ---------------------------------------------------------------------------
// 5. BFS subgraph core (legacy _select_subgraph, knowledge_graph.py:373-393)
// ---------------------------------------------------------------------------
{
  // a - b - c - d - e
  const adjacency = new Map<string, string[]>([
    ["a", ["b"]],
    ["b", ["a", "c"]],
    ["c", ["b", "d"]],
    ["d", ["c", "e"]],
    ["e", ["d"]],
  ]);
  assert.deepEqual(bfsSubgraphKeys(adjacency, "c", 1), {
    keys: ["c", "b", "d"],
    truncated: false,
  });
  assert.deepEqual(bfsSubgraphKeys(adjacency, "c", 2), {
    keys: ["c", "b", "d", "a", "e"],
    truncated: false,
  });
  assert.deepEqual(bfsSubgraphKeys(adjacency, "c", 0), {
    keys: ["c"],
    truncated: false,
  });
  // Unknown center: legacy still returns the center as a fallback node.
  assert.deepEqual(bfsSubgraphKeys(adjacency, "zz", 2), {
    keys: ["zz"],
    truncated: false,
  });
  ok("bfsSubgraphKeys: depth bands, unknown-center fallback");

  // star with 100 leaves hits the 72-node cap mid-frontier.
  const star = new Map<string, string[]>([["hub", []]]);
  const hub: string[] = [];
  for (let i = 0; i < 100; i++) {
    const leaf = `leaf-${String(i).padStart(2, "0")}`;
    hub.push(leaf);
    star.set(leaf, ["hub"]);
  }
  star.set("hub", hub);
  const capped = bfsSubgraphKeys(star, "hub", 1);
  assert.equal(capped.keys.length, GRAPH_NODE_LIMIT);
  assert.equal(capped.keys[0], "hub");
  assert.equal(capped.truncated, true);
  ok(`bfsSubgraphKeys: ${GRAPH_NODE_LIMIT}-node cap reports truncation`);
}

// ---------------------------------------------------------------------------
// 6. aliases + zod route contracts
// ---------------------------------------------------------------------------
{
  assert.equal(normalizeNodeType("pr"), "pull_request");
  assert.equal(normalizeNodeType(" issue "), "issue");
  assert.equal(normalizeNodeType("weekly_report"), "knowledge_document");
  assert.equal(normalizeNodeType("session"), "conversation");
  assert.equal(normalizeNodeType("unknown_thing"), "unknown_thing");
  assert.equal(nodeKey("issue", "x"), "issue:x");
  ok("normalizeNodeType aliases (legacy NODE_TYPE_ALIASES subset)");

  assert.ok(GraphActionSchema.safeParse({ action: "rebuild" }).success);
  assert.equal(
    GraphActionSchema.safeParse({ action: "refresh" }).success,
    false,
  );
  assert.equal(GraphActionSchema.safeParse(null).success, false);
  assert.equal(GraphActionSchema.safeParse({}).success, false);

  const q1 = SubgraphQuerySchema.safeParse({ fromType: "issue", fromId: "x" });
  assert.ok(q1.success && q1.data.depth === 1);
  const q2 = SubgraphQuerySchema.safeParse({
    fromType: "pr",
    fromId: "x",
    depth: "2",
  });
  assert.ok(q2.success && q2.data.depth === 2);
  assert.equal(
    SubgraphQuerySchema.safeParse({
      fromType: "issue",
      fromId: "x",
      depth: "3",
    }).success,
    false,
  );
  assert.equal(
    SubgraphQuerySchema.safeParse({ fromType: "", fromId: "x" }).success,
    false,
  );
  assert.equal(
    SubgraphQuerySchema.safeParse({ fromType: "issue" }).success,
    false,
  );
  ok("GraphActionSchema + SubgraphQuerySchema (depth 1..2, default 1)");
}

// ---------------------------------------------------------------------------
// Optional live pass against local PostgreSQL (row-level, self-cleaning)
// ---------------------------------------------------------------------------
async function live(): Promise<void> {
  const { prisma } = await import("@/lib/db");
  const stamp = Date.now();
  const repo = await prisma.repository.create({
    data: {
      owner: "smoke-graph",
      name: `repo-${stamp}`,
      fullName: `smoke-graph/repo-${stamp}`,
    },
  });
  try {
    const member = await prisma.teamMember.create({
      data: { repoId: repo.id, githubLogin: "bob" },
    });
    const issue1 = await prisma.issue.create({
      data: {
        repoId: repo.id,
        number: 1,
        title: "Login crashes",
        body: "Assign to bob",
        author: "alice",
        assignees: ["bob", "carol"],
      },
    });
    await prisma.issue.create({
      data: {
        repoId: repo.id,
        number: 2,
        title: "Duplicate of #1",
        body: null,
        author: "alice",
        assignees: [],
      },
    });
    const pr10 = await prisma.pullRequest.create({
      data: {
        repoId: repo.id,
        number: 10,
        title: "Fix login",
        body: "Closes #1\nSee also #2",
        author: "dave",
      },
    });
    await prisma.knowledgeDocument.create({
      data: {
        repoId: repo.id,
        name: "Weekly Report W39",
        sourceType: "weekly_report",
        status: "ready",
        contentHash: `smoke-graph-${stamp}`,
        chunkCount: 0,
      },
    });
    const conv = await prisma.conversation.create({
      data: { repoId: repo.id, title: "graph smoke" },
    });
    await prisma.chatMessage.create({
      data: {
        conversationId: conv.id,
        repoId: repo.id,
        role: "assistant",
        content: "分析如下\n决定: 先修 #1, 下周处理 #2",
      },
    });

    const injectContent = async () => "#10 shipped, #2 pending";
    const first = await rebuildGraph(repo.id, {
      resolveWeeklyReportContent: injectContent,
    });
    assert.equal(first.edges, 12);
    assert.equal(first.nodes, 9);
    const rows = await prisma.knowledgeGraphEdge.findMany({
      where: { repoId: repo.id },
    });
    assert.equal(rows.length, 12);
    const countBy = (relation: string) =>
      rows.filter((r) => r.relation === relation).length;
    assert.equal(countBy("references"), 2);
    assert.equal(countBy("resolves"), 1);
    assert.equal(countBy("assigned_to"), 2);
    assert.equal(countBy("authored_by"), 3);
    assert.equal(countBy("documents"), 2);
    assert.equal(countBy("decides"), 2);
    const bobEdge = rows.find(
      (r) => r.relation === "assigned_to" && r.toType === "team_member",
    );
    assert.ok(bobEdge && bobEdge.toId === member.id);
    const carolEdge = rows.find(
      (r) => r.relation === "assigned_to" && r.toType === "github_user",
    );
    assert.ok(carolEdge && carolEdge.toId === "carol");
    assert.equal(rows.find((r) => r.relation === "resolves")?.confidence, 0.9);
    assert.equal(rows.find((r) => r.relation === "documents")?.confidence, 0.8);
    assert.equal(rows.find((r) => r.relation === "decides")?.confidence, 0.6);
    assert.ok(rows.every((r) => r.source === "sync"));
    ok(
      "live rebuild: 12 edges across all six relations, row-level spot checks",
    );

    // Idempotency: deleteMany + createMany skipDuplicates — a second rebuild
    // must not double the rows.
    const second = await rebuildGraph(repo.id, {
      resolveWeeklyReportContent: injectContent,
    });
    assert.equal(second.edges, 12);
    assert.equal(
      await prisma.knowledgeGraphEdge.count({ where: { repoId: repo.id } }),
      12,
    );
    ok("live rebuild idempotency: repeated rebuild keeps 12 rows");

    // Default (Milvus-backed) resolver with Milvus down: the documents edge
    // degrades to name-only extraction and the rebuild still succeeds.
    const degraded = await rebuildGraph(repo.id);
    assert.equal(degraded.edges, 10, "documents edges drop without content");
    assert.equal(
      await prisma.knowledgeGraphEdge.count({
        where: { repoId: repo.id, relation: "documents" },
      }),
      0,
    );
    // Restore the full graph for the read-path checks.
    await rebuildGraph(repo.id, { resolveWeeklyReportContent: injectContent });

    const summary = await graphSummary(repo.id);
    assert.equal(summary.edgeCount, 12);
    assert.equal(summary.nodeCount, 9);
    assert.equal(summary.relationCounts.references, 2);
    assert.equal(summary.recentEdges.length, 12);
    assert.ok(summary.nodes.some((n) => n.label === "#1 Login crashes"));
    assert.ok(summary.nodes.some((n) => n.type === "team_member"));
    ok("graphSummary: counts, relation distribution, labeled nodes");

    const sub1 = await fetchSubgraph(repo.id, {
      fromType: "issue",
      fromId: issue1.id,
      depth: 1,
    });
    assert.equal(sub1.nodes.length, 7);
    assert.equal(sub1.nodes[0].label, "#1 Login crashes");
    assert.equal(sub1.truncated, false);
    // Alias "pr" + depth clamp (legacy ge=1 le=2 → clamps to 2).
    const sub2 = await fetchSubgraph(repo.id, {
      fromType: "pr",
      fromId: pr10.id,
      depth: 5,
    });
    assert.equal(sub2.fromType, "pull_request");
    assert.equal(sub2.depth, 2);
    assert.ok(sub2.nodes.some((n) => n.label === "#2 Duplicate of #1"));
    // Unknown center: fallback single node (legacy _fallback_node).
    const sub3 = await fetchSubgraph(repo.id, {
      fromType: "issue",
      fromId: "nope",
      depth: 1,
    });
    assert.deepEqual(sub3.nodes, [
      { type: "issue", id: "nope", label: "nope" },
    ]);
    assert.equal(sub3.edges.length, 0);
    ok(
      "fetchSubgraph: depth-1 ring, alias + depth clamp, unknown-center fallback",
    );

    // The returned edge list is closed over the returned node set (legacy
    // selected_edges filter, knowledge_graph.py:117-119).
    const keys = new Set(sub1.nodes.map((n) => `${n.type}:${n.id}`));
    assert.ok(
      sub1.edges.every(
        (e) =>
          keys.has(`${e.fromType}:${e.fromId}`) &&
          keys.has(`${e.toType}:${e.toId}`),
      ),
    );
    ok("fetchSubgraph: edges are closed over the returned node set");
  } finally {
    await prisma.repository
      .delete({ where: { id: repo.id } })
      .catch(() => undefined);
    assert.equal(
      await prisma.knowledgeGraphEdge.count({ where: { repoId: repo.id } }),
      0,
      "repo deletion cascades graph edges",
    );
    await prisma.$disconnect();
  }
}

async function main(): Promise<void> {
  console.log("devflow-graph smoke: offline section");
  console.log(`  ${checks} checks passed`);
  if (process.env.DEVFLOW_GRAPH_SMOKE_PG === "1") {
    console.log("devflow-graph smoke: LIVE section (PostgreSQL)");
    await live();
    console.log(`  live pass done (total ${checks} checks)`);
  } else {
    console.log("  LIVE section skipped (set DEVFLOW_GRAPH_SMOKE_PG=1)");
  }
  console.log("DEVFLOW-GRAPH SMOKE OK");
}

main().catch((e) => {
  console.error("SMOKE FAILED:", e);
  process.exit(1);
});
