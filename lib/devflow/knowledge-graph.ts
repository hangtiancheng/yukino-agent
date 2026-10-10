import { z } from "zod/v4";
import { prisma } from "@/lib/db";

export const GRAPH_NODE_LIMIT = 72;
export const RECENT_EDGES_LIMIT = 20;
export const SUMMARY_NODE_LIMIT = 500;
const DECISION_MESSAGE_SCAN_LIMIT = 200;
const CREATE_BATCH_SIZE = 1_000;

export const GRAPH_NODE_TYPES = [
  "issue",
  "pull_request",
  "team_member",
  "github_user",
  "knowledge_document",
  "conversation",
] as const;
export type GraphNodeType = (typeof GRAPH_NODE_TYPES)[number];

const NODE_TYPE_ALIASES: Record<string, string> = {
  issue: "issue",
  pr: "pull_request",
  pull_request: "pull_request",
  team_member: "team_member",
  member: "team_member",
  github_user: "github_user",
  user: "github_user",
  document: "knowledge_document",
  weekly_report: "knowledge_document",
  knowledge_document: "knowledge_document",
  session: "conversation",
  conversation: "conversation",
};

export function normalizeNodeType(value: string): string {
  const key = value.trim();
  return NODE_TYPE_ALIASES[key] ?? key;
}

const ISSUE_REF_RE = /(?<![A-Za-z])#(\d+)\b/g;
const CLOSING_ISSUE_RE =
  /\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s+(?:issue\s+)?#(\d+)\b/gi;
const DECISION_LINE_RE = /^\s*(?:决定|decision\s*:)/i;

export const GRAPH_RELATIONS = [
  "references",
  "resolves",
  "assigned_to",
  "authored_by",
  "documents",
  "decides",
] as const;
export type GraphRelation = (typeof GRAPH_RELATIONS)[number];

export const RELATION_CONFIDENCE: Record<GraphRelation, number> = {
  references: 1.0,
  resolves: 0.9,
  assigned_to: 1.0,
  authored_by: 1.0,
  documents: 0.8,
  decides: 0.6,
};

export const EDGE_SOURCE = "sync";

export function nodeKey(type: string, id: string): string {
  return `${type}:${id}`;
}

export function extractIssueRefs(text: string): number[] {
  const found = new Set<number>();
  for (const match of text.matchAll(ISSUE_REF_RE)) {
    found.add(Number(match[1]));
  }
  return [...found].sort((a, b) => a - b);
}

export function extractClosingRefs(text: string): number[] {
  const found = new Set<number>();
  for (const match of text.matchAll(CLOSING_ISSUE_RE)) {
    found.add(Number(match[1]));
  }
  return [...found].sort((a, b) => a - b);
}

export function extractDecisionLines(text: string): string[] {
  return text.split("\n").filter((line) => DECISION_LINE_RE.test(line));
}

export interface GraphIssueInput {
  id: string;
  number: number;
  title: string;
  body: string | null;
  author: string | null;
  assignees: string[];
}

export interface GraphPrInput {
  id: string;
  number: number;
  title: string;
  body: string | null;
  author: string | null;
}

export interface GraphDocumentInput {
  id: string;
  name: string;
  content: string | null;
}

export interface GraphMessageInput {
  id: string;
  conversationId: string;
  content: string;
}

export interface GraphTeamMemberInput {
  id: string;
  githubLogin: string;
}

export interface GraphSnapshot {
  issues: GraphIssueInput[];
  pullRequests: GraphPrInput[];
  documents: GraphDocumentInput[];
  messages: GraphMessageInput[];
  teamMembers: GraphTeamMemberInput[];
}

export interface DerivedEdge {
  fromType: string;
  fromId: string;
  toType: string;
  toId: string;
  relation: GraphRelation;
  confidence: number;
  source: string;
  meta: Record<string, string | number>;
}

export function deriveEdges(snapshot: GraphSnapshot): DerivedEdge[] {
  const issuesByNumber = new Map<number, string>();
  for (const issue of snapshot.issues) {
    issuesByNumber.set(issue.number, issue.id);
  }
  const prsByNumber = new Map<number, string>();
  for (const pr of snapshot.pullRequests) {
    prsByNumber.set(pr.number, pr.id);
  }
  const memberIdsByLogin = new Map<string, string>();
  for (const member of snapshot.teamMembers) {
    memberIdsByLogin.set(member.githubLogin.trim().toLowerCase(), member.id);
  }

  const edges = new Map<string, DerivedEdge>();
  function addEdge(
    fromType: string,
    fromId: string,
    toType: string,
    toId: string,
    relation: GraphRelation,
    meta: Record<string, string | number>,
  ): void {
    if (!fromId || !toId || (fromType === toType && fromId === toId)) return;
    const key = [fromType, fromId, toType, toId, relation].join("|");
    const existing = edges.get(key);
    if (existing) {
      existing.confidence = Math.max(
        existing.confidence,
        RELATION_CONFIDENCE[relation],
      );
      Object.assign(existing.meta, meta);
      return;
    }
    edges.set(key, {
      fromType,
      fromId,
      toType,
      toId,
      relation,
      confidence: RELATION_CONFIDENCE[relation],
      source: EDGE_SOURCE,
      meta: { ...meta },
    });
  }

  function resolveRef(n: number): { type: string; id: string } | null {
    const issueId = issuesByNumber.get(n);
    if (issueId) return { type: "issue", id: issueId };
    const prId = prsByNumber.get(n);
    if (prId) return { type: "pull_request", id: prId };
    return null;
  }

  function addReferenceEdges(
    fromType: string,
    fromId: string,
    text: string,
    relation: GraphRelation,
    exclude?: Set<number>,
    extraMeta?: Record<string, string | number>,
  ): void {
    for (const n of extractIssueRefs(text)) {
      if (exclude?.has(n)) continue;
      const target = resolveRef(n);
      if (!target) continue;
      addEdge(fromType, fromId, target.type, target.id, relation, {
        number: n,
        ...extraMeta,
      });
    }
  }

  for (const issue of snapshot.issues) {
    addReferenceEdges(
      "issue",
      issue.id,
      `${issue.title}\n${issue.body ?? ""}`,
      "references",
    );
    for (const assignee of issue.assignees) {
      const login = assignee.trim();
      if (!login) continue;
      const memberId = memberIdsByLogin.get(login.toLowerCase());
      addEdge(
        "issue",
        issue.id,
        memberId ? "team_member" : "github_user",
        memberId ?? login,
        "assigned_to",
        { login },
      );
    }
    const author = issue.author?.trim();
    if (author) {
      addEdge("issue", issue.id, "github_user", author, "authored_by", {
        login: author,
      });
    }
  }

  for (const pr of snapshot.pullRequests) {
    const text = `${pr.title}\n${pr.body ?? ""}`;
    const closing = new Set<number>();
    for (const n of extractClosingRefs(text)) {
      closing.add(n);
      const issueId = issuesByNumber.get(n);
      if (issueId) {
        addEdge("pull_request", pr.id, "issue", issueId, "resolves", {
          number: n,
        });
      }
    }
    addReferenceEdges("pull_request", pr.id, text, "references", closing);
    const author = pr.author?.trim();
    if (author) {
      addEdge("pull_request", pr.id, "github_user", author, "authored_by", {
        login: author,
      });
    }
  }

  for (const doc of snapshot.documents) {
    addReferenceEdges(
      "knowledge_document",
      doc.id,
      `${doc.name}\n${doc.content ?? ""}`,
      "documents",
    );
  }

  for (const message of snapshot.messages) {
    for (const line of extractDecisionLines(message.content)) {
      addReferenceEdges(
        "conversation",
        message.conversationId,
        line,
        "decides",
        undefined,
        { messageId: message.id },
      );
    }
  }

  return [...edges.values()];
}

export interface RebuildGraphOptions {
  resolveWeeklyReportContent?: (doc: {
    id: string;
    name: string;
    chunkCount: number;
  }) => Promise<string | null>;
}

export interface RebuildGraphResult {
  edges: number;
  nodes: number;
}

function createWeeklyReportContentResolver(): NonNullable<
  RebuildGraphOptions["resolveWeeklyReportContent"]
> {
  let unavailable = false;
  return async (doc) => {
    if (unavailable || doc.chunkCount <= 0) return null;
    try {
      const { getByIds } = await import("@/lib/milvus/client");
      const ids = Array.from(
        { length: doc.chunkCount },
        (_, i) => `${doc.id}#${i}`,
      );
      const hits = await getByIds(ids);
      if (hits.length === 0) return null;
      const chunkIndex = (id: string): number => {
        const at = id.lastIndexOf("#");
        const parsed = at === -1 ? NaN : Number(id.slice(at + 1));
        return Number.isFinite(parsed) ? parsed : 0;
      };
      return [...hits]
        .sort((a, b) => chunkIndex(a.id) - chunkIndex(b.id))
        .map((hit) => hit.content)
        .join("\n");
    } catch {
      unavailable = true;
      return null;
    }
  };
}

export async function rebuildGraph(
  repoId: string,
  options: RebuildGraphOptions = {},
): Promise<RebuildGraphResult> {
  const [issues, pullRequests, weeklyDocs, assistantMessages, teamMembers] =
    await Promise.all([
      prisma.issue.findMany({
        where: { repoId },
        select: {
          id: true,
          number: true,
          title: true,
          body: true,
          author: true,
          assignees: true,
        },
        orderBy: { number: "asc" },
      }),
      prisma.pullRequest.findMany({
        where: { repoId },
        select: {
          id: true,
          number: true,
          title: true,
          body: true,
          author: true,
        },
        orderBy: { number: "asc" },
      }),
      prisma.knowledgeDocument.findMany({
        where: { repoId, sourceType: "weekly_report" },
        select: { id: true, name: true, chunkCount: true },
        orderBy: { createdAt: "asc" },
      }),
      prisma.chatMessage.findMany({
        where: {
          repoId,
          role: "assistant",
          OR: [
            { content: { contains: "决定" } },
            { content: { contains: "decision", mode: "insensitive" } },
          ],
        },
        select: { id: true, conversationId: true, content: true },
        orderBy: { createdAt: "desc" },
        take: DECISION_MESSAGE_SCAN_LIMIT,
      }),
      prisma.teamMember.findMany({
        where: { repoId },
        select: { id: true, githubLogin: true },
        orderBy: { githubLogin: "asc" },
      }),
    ]);

  const resolveContent =
    options.resolveWeeklyReportContent ?? createWeeklyReportContentResolver();
  const documents = await Promise.all(
    weeklyDocs.map(async (doc) => ({
      id: doc.id,
      name: doc.name,
      content: await resolveContent(doc),
    })),
  );

  const derived = deriveEdges({
    issues,
    pullRequests,
    documents,
    messages: [...assistantMessages].reverse(),
    teamMembers,
  });

  const nodeKeys = new Set<string>();
  for (const edge of derived) {
    nodeKeys.add(nodeKey(edge.fromType, edge.fromId));
    nodeKeys.add(nodeKey(edge.toType, edge.toId));
  }

  const batches: Array<
    Array<{
      repoId: string;
      fromType: string;
      fromId: string;
      toType: string;
      toId: string;
      relation: string;
      confidence: number;
      source: string;
      meta: Record<string, string | number>;
    }>
  > = [];
  for (let i = 0; i < derived.length; i += CREATE_BATCH_SIZE) {
    batches.push(
      derived.slice(i, i + CREATE_BATCH_SIZE).map((edge) => ({
        repoId,
        fromType: edge.fromType,
        fromId: edge.fromId,
        toType: edge.toType,
        toId: edge.toId,
        relation: edge.relation,
        confidence: edge.confidence,
        source: edge.source,
        meta: edge.meta,
      })),
    );
  }
  await prisma.$transaction([
    prisma.knowledgeGraphEdge.deleteMany({ where: { repoId } }),
    ...batches.map((data) =>
      prisma.knowledgeGraphEdge.createMany({ data, skipDuplicates: true }),
    ),
  ]);

  return { edges: derived.length, nodes: nodeKeys.size };
}

export interface GraphNodeView {
  type: string;
  id: string;
  label: string;
}

export interface GraphEdgeView {
  id: string;
  fromType: string;
  fromId: string;
  toType: string;
  toId: string;
  relation: string;
  confidence: number;
  source: string;
  createdAt: Date;
}

export interface GraphSummary {
  repoId: string;
  nodeCount: number;
  edgeCount: number;
  relationCounts: Record<string, number>;
  nodes: GraphNodeView[];
  recentEdges: GraphEdgeView[];
}

export interface SubgraphResult {
  fromType: string;
  fromId: string;
  depth: number;
  nodes: GraphNodeView[];
  edges: GraphEdgeView[];
  truncated: boolean;
}

const EDGE_VIEW_SELECT = {
  id: true,
  fromType: true,
  fromId: true,
  toType: true,
  toId: true,
  relation: true,
  confidence: true,
  source: true,
  createdAt: true,
} as const;

const NODE_TYPE_PRIORITY: Record<string, number> = {
  issue: 0,
  pull_request: 1,
  team_member: 2,
  github_user: 3,
  knowledge_document: 4,
  conversation: 5,
};

function splitNodeKey(key: string): { type: string; id: string } | null {
  const at = key.indexOf(":");
  if (at <= 0) return null;
  return { type: key.slice(0, at), id: key.slice(at + 1) };
}

async function resolveNodeLabels(
  idsByType: Map<string, string[]>,
): Promise<Map<string, string>> {
  const ids = (type: string): string[] => idsByType.get(type) ?? [];
  const [issues, prs, members, docs, conversations] = await Promise.all([
    ids("issue").length
      ? prisma.issue.findMany({
          where: { id: { in: ids("issue") } },
          select: { id: true, number: true, title: true },
        })
      : [],
    ids("pull_request").length
      ? prisma.pullRequest.findMany({
          where: { id: { in: ids("pull_request") } },
          select: { id: true, number: true, title: true },
        })
      : [],
    ids("team_member").length
      ? prisma.teamMember.findMany({
          where: { id: { in: ids("team_member") } },
          select: { id: true, githubLogin: true, displayName: true },
        })
      : [],
    ids("knowledge_document").length
      ? prisma.knowledgeDocument.findMany({
          where: { id: { in: ids("knowledge_document") } },
          select: { id: true, name: true },
        })
      : [],
    ids("conversation").length
      ? prisma.conversation.findMany({
          where: { id: { in: ids("conversation") } },
          select: { id: true, title: true },
        })
      : [],
  ]);
  const labels = new Map<string, string>();
  for (const issue of issues) {
    labels.set(nodeKey("issue", issue.id), `#${issue.number} ${issue.title}`);
  }
  for (const pr of prs) {
    labels.set(nodeKey("pull_request", pr.id), `#${pr.number} ${pr.title}`);
  }
  for (const member of members) {
    labels.set(
      nodeKey("team_member", member.id),
      member.displayName?.trim() || member.githubLogin,
    );
  }
  for (const doc of docs) {
    labels.set(nodeKey("knowledge_document", doc.id), doc.name);
  }
  for (const conversation of conversations) {
    labels.set(nodeKey("conversation", conversation.id), conversation.title);
  }
  for (const login of ids("github_user")) {
    labels.set(nodeKey("github_user", login), login);
  }
  return labels;
}

async function buildNodeViews(keys: string[]): Promise<GraphNodeView[]> {
  const idsByType = new Map<string, string[]>();
  for (const key of keys) {
    const split = splitNodeKey(key);
    if (!split) continue;
    const list = idsByType.get(split.type) ?? [];
    list.push(split.id);
    idsByType.set(split.type, list);
  }
  const labels = await resolveNodeLabels(idsByType);
  const views: GraphNodeView[] = [];
  for (const key of keys) {
    const split = splitNodeKey(key);
    if (!split) continue;
    views.push({
      type: split.type,
      id: split.id,
      label: labels.get(key) ?? split.id,
    });
  }
  views.sort(
    (a, b) =>
      (NODE_TYPE_PRIORITY[a.type] ?? 20) - (NODE_TYPE_PRIORITY[b.type] ?? 20) ||
      a.label.localeCompare(b.label),
  );
  return views;
}

export async function graphSummary(repoId: string): Promise<GraphSummary> {
  const edges = await prisma.knowledgeGraphEdge.findMany({
    where: { repoId },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    select: EDGE_VIEW_SELECT,
  });
  const relationCounts: Record<string, number> = {};
  const keys = new Set<string>();
  for (const edge of edges) {
    relationCounts[edge.relation] = (relationCounts[edge.relation] ?? 0) + 1;
    keys.add(nodeKey(edge.fromType, edge.fromId));
    keys.add(nodeKey(edge.toType, edge.toId));
  }
  const nodes = await buildNodeViews([...keys]);
  return {
    repoId,
    nodeCount: keys.size,
    edgeCount: edges.length,
    relationCounts,
    nodes: nodes.slice(0, SUMMARY_NODE_LIMIT),
    recentEdges: edges.slice(0, RECENT_EDGES_LIMIT),
  };
}

export function bfsSubgraphKeys(
  adjacency: Map<string, string[]>,
  centerKey: string,
  depth: number,
  limit: number = GRAPH_NODE_LIMIT,
): { keys: string[]; truncated: boolean } {
  const keys: string[] = [];
  const seen = new Set<string>([centerKey]);
  const queue: Array<[string, number]> = [[centerKey, 0]];
  while (queue.length > 0 && keys.length < limit) {
    const head = queue.shift();
    if (!head) break;
    const [key, distance] = head;
    keys.push(key);
    if (distance >= depth) continue;
    for (const next of adjacency.get(key) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push([next, distance + 1]);
    }
  }
  return { keys, truncated: queue.length > 0 };
}

export async function fetchSubgraph(
  repoId: string,
  params: { fromType: string; fromId: string; depth?: number },
): Promise<SubgraphResult> {
  const fromType = normalizeNodeType(params.fromType);
  const depth = Math.max(1, Math.min(params.depth ?? 1, 2));
  const center = nodeKey(fromType, params.fromId);

  const rows = await prisma.knowledgeGraphEdge.findMany({
    where: { repoId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: EDGE_VIEW_SELECT,
  });

  const keys = new Set<string>([center]);
  const adjacency = new Map<string, string[]>();
  const push = (a: string, b: string): void => {
    keys.add(a);
    keys.add(b);
    const list = adjacency.get(a) ?? [];
    list.push(b);
    adjacency.set(a, list);
  };
  for (const row of rows) {
    const a = nodeKey(row.fromType, row.fromId);
    const b = nodeKey(row.toType, row.toId);
    push(a, b);
    push(b, a);
  }

  const allViews = await buildNodeViews([...keys]);
  const viewByKey = new Map(
    allViews.map((view) => [nodeKey(view.type, view.id), view]),
  );
  for (const [, list] of adjacency) {
    list.sort((a, b) => {
      const la = viewByKey.get(a)?.label ?? a;
      const lb = viewByKey.get(b)?.label ?? b;
      return la.localeCompare(lb) || a.localeCompare(b);
    });
  }

  const selected = bfsSubgraphKeys(adjacency, center, depth);
  const selectedSet = new Set(selected.keys);
  const edges = rows.filter(
    (row) =>
      selectedSet.has(nodeKey(row.fromType, row.fromId)) &&
      selectedSet.has(nodeKey(row.toType, row.toId)),
  );
  const nodes = selected.keys.map((key) => {
    const view = viewByKey.get(key);
    if (view) return view;
    const split = splitNodeKey(key) ?? { type: key, id: key };
    return { type: split.type, id: split.id, label: split.id };
  });
  return {
    fromType,
    fromId: params.fromId,
    depth,
    nodes,
    edges,
    truncated: selected.truncated,
  };
}

export const GraphActionSchema = z.object({ action: z.literal("rebuild") });
export type GraphAction = z.infer<typeof GraphActionSchema>;

export const SubgraphQuerySchema = z.object({
  fromType: z.string().min(1).max(40),
  fromId: z.string().min(1).max(120),
  depth: z.coerce.number().int().min(1).max(2).default(1),
});
export type SubgraphQuery = z.infer<typeof SubgraphQuerySchema>;
