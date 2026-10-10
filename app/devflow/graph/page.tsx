"use client";

import { useEffect, useMemo, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { Network, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { notify } from "@/components/devflow/notify";
import PageHeader from "@/components/devflow/page-header";
import { dfGet, dfPost, useDevflow } from "@/components/devflow/provider";
import type {
  GraphEdgeView,
  GraphNodeView,
  GraphSummary,
  SubgraphResult,
} from "@/lib/devflow/knowledge-graph";

const RELATION_COLORS: Record<string, string> = {
  references: "#64748b",
  resolves: "#16a34a",
  assigned_to: "#4f46e5",
  authored_by: "#0f766e",
  documents: "#2563eb",
  decides: "#9333ea",
};
const FALLBACK_RELATION_COLOR = "#64748b";

const NODE_STYLES: Record<string, { fill: string; stroke: string }> = {
  issue: { fill: "#fef3c7", stroke: "#d97706" },
  pull_request: { fill: "#ccfbf1", stroke: "#0f766e" },
  team_member: { fill: "#e0e7ff", stroke: "#4f46e5" },
  github_user: { fill: "#f1f5f9", stroke: "#64748b" },
  knowledge_document: { fill: "#dbeafe", stroke: "#2563eb" },
  conversation: { fill: "#f3e8ff", stroke: "#9333ea" },
};
const FALLBACK_NODE_STYLE = { fill: "#f1f5f9", stroke: "#64748b" };

const RELATION_KEYS = {
  references: "references",
  resolves: "resolves",
  assigned_to: "assignedTo",
  authored_by: "authoredBy",
  documents: "documents",
  decides: "decides",
} as const;

const NODE_TYPE_KEYS = {
  issue: "issue",
  pull_request: "pullRequest",
  team_member: "teamMember",
  github_user: "githubUser",
  knowledge_document: "knowledgeDocument",
  conversation: "conversation",
} as const;

function isRelationKey(value: string): value is keyof typeof RELATION_KEYS {
  return value in RELATION_KEYS;
}

function isNodeTypeKey(value: string): value is keyof typeof NODE_TYPE_KEYS {
  return value in NODE_TYPE_KEYS;
}

const DEPTHS: Array<1 | 2> = [1, 2];

const VIEW_W = 720;
const VIEW_H = 440;
const CX = 360;
const CY = 200;
const RING1_RADIUS = 115;
const RING1_WIDE_RADIUS = 135;
const RING2_RADIUS = 180;

function keyOf(type: string, id: string): string {
  return `${type}:${id}`;
}

function clipLabel(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trim()}…`;
}

interface PlacedNode {
  node: GraphNodeView;
  x: number;
  y: number;
  hop: number;
}

function ringLayout(
  nodes: GraphNodeView[],
  edges: GraphEdgeView[],
  centerKey: string,
): Map<string, PlacedNode> {
  const positions = new Map<string, PlacedNode>();
  if (nodes.length === 0) return positions;

  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const a = keyOf(edge.fromType, edge.fromId);
    const b = keyOf(edge.toType, edge.toId);
    const la = adjacency.get(a) ?? [];
    la.push(b);
    adjacency.set(a, la);
    const lb = adjacency.get(b) ?? [];
    lb.push(a);
    adjacency.set(b, lb);
  }
  const hop = new Map<string, number>([[centerKey, 0]]);
  const queue: string[] = [centerKey];
  for (let head = 0; head < queue.length; head++) {
    const key = queue[head];
    const distance = hop.get(key) ?? 0;
    for (const next of adjacency.get(key) ?? []) {
      if (hop.has(next)) continue;
      hop.set(next, distance + 1);
      queue.push(next);
    }
  }

  const center = nodes.find((n) => keyOf(n.type, n.id) === centerKey);
  if (center) {
    positions.set(centerKey, { node: center, x: CX, y: CY, hop: 0 });
  }
  const ring1 = nodes.filter((n) => hop.get(keyOf(n.type, n.id)) === 1);
  const ring2 = nodes.filter((n) => {
    const key = keyOf(n.type, n.id);
    return key !== centerKey && (hop.get(key) ?? 99) >= 2;
  });

  const placeRing = (
    ring: GraphNodeView[],
    radius: number,
    start: number,
    band: number,
  ): void => {
    ring.forEach((node, index) => {
      const angle = start + (Math.PI * 2 * index) / ring.length;
      positions.set(keyOf(node.type, node.id), {
        node,
        x: CX + Math.cos(angle) * radius,
        y: CY + Math.sin(angle) * radius,
        hop: band,
      });
    });
  };
  placeRing(
    ring1,
    ring1.length > 10 ? RING1_WIDE_RADIUS : RING1_RADIUS,
    -Math.PI / 2,
    1,
  );
  placeRing(ring2, RING2_RADIUS, Math.PI / 9, 2);
  return positions;
}

export default function DevflowGraphPage() {
  const { repoId } = useDevflow();
  const t = useTranslations("devflow.graph");
  const format = useFormatter();

  const [summary, setSummary] = useState<GraphSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [selected, setSelected] = useState<{ type: string; id: string } | null>(
    null,
  );
  const [depth, setDepth] = useState<1 | 2>(1);
  const [subgraph, setSubgraph] = useState<SubgraphResult | null>(null);
  const [subLoading, setSubLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!repoId) return;
    let cancelled = false;
    (async () => {
      setSummaryLoading(true);
      setSubgraph(null);
      setQuery("");
      try {
        const data = await dfGet<GraphSummary>(`/repos/${repoId}/graph`);
        if (cancelled) return;
        setSummary(data);
        setSelected((current) => {
          if (
            current &&
            data.nodes.some(
              (n) => n.type === current.type && n.id === current.id,
            )
          ) {
            return current;
          }
          const first = data.nodes[0];
          return first ? { type: first.type, id: first.id } : null;
        });
      } catch (e) {
        if (!cancelled)
          notify.error(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setSummaryLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoId, reloadKey]);

  useEffect(() => {
    if (!repoId || !selected) return;
    let cancelled = false;
    (async () => {
      setSubLoading(true);
      try {
        const params = new URLSearchParams({
          fromType: selected.type,
          fromId: selected.id,
          depth: String(depth),
        });
        const data = await dfGet<SubgraphResult>(
          `/repos/${repoId}/graph/subgraph?${params.toString()}`,
        );
        if (!cancelled) setSubgraph(data);
      } catch (e) {
        if (!cancelled)
          notify.error(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setSubLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoId, selected, depth, reloadKey]);

  const relationLabel = (relation: string): string =>
    isRelationKey(relation)
      ? t(`relations.${RELATION_KEYS[relation]}`)
      : relation;
  const nodeTypeLabel = (type: string): string =>
    isNodeTypeKey(type) ? t(`nodeTypes.${NODE_TYPE_KEYS[type]}`) : type;

  async function rebuild(): Promise<void> {
    if (!repoId) return;
    setRebuilding(true);
    try {
      const result = await dfPost<{ edges: number; nodes: number }>(
        `/repos/${repoId}/graph`,
        { action: "rebuild" },
      );
      notify.success(
        t("rebuildSuccess", { edges: result.edges, nodes: result.nodes }),
      );
      setReloadKey((k) => k + 1);
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setRebuilding(false);
    }
  }

  const filteredNodes = useMemo(() => {
    const nodes = summary?.nodes ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return nodes;
    return nodes.filter(
      (n) => n.label.toLowerCase().includes(q) || n.type.includes(q),
    );
  }, [summary, query]);

  const centerKey = selected ? keyOf(selected.type, selected.id) : null;
  const positions = useMemo(
    () =>
      subgraph && centerKey
        ? ringLayout(subgraph.nodes, subgraph.edges, centerKey)
        : new Map<string, PlacedNode>(),
    [subgraph, centerKey],
  );
  const labelByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const node of summary?.nodes ?? []) {
      map.set(keyOf(node.type, node.id), node.label);
    }
    for (const node of subgraph?.nodes ?? []) {
      map.set(keyOf(node.type, node.id), node.label);
    }
    return map;
  }, [summary, subgraph]);

  const adjacencyRows = useMemo(() => {
    if (!subgraph || !centerKey) return [];
    return subgraph.edges.filter(
      (edge) =>
        keyOf(edge.fromType, edge.fromId) === centerKey ||
        keyOf(edge.toType, edge.toId) === centerKey,
    );
  }, [subgraph, centerKey]);

  const legendRelations = useMemo(() => {
    const present = new Set<string>();
    for (const edge of subgraph?.edges ?? []) present.add(edge.relation);
    for (const relation of Object.keys(summary?.relationCounts ?? {})) {
      present.add(relation);
    }
    return [...present].sort();
  }, [subgraph, summary]);

  const showEdgeLabels = (subgraph?.edges.length ?? 0) <= 8;

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <Button
            onClick={() => void rebuild()}
            disabled={rebuilding || !repoId}
          >
            {rebuilding ? (
              <RefreshCw className="h-4 w-4 animate-spin" />
            ) : (
              <Network className="h-4 w-4" />
            )}
            {rebuilding ? t("rebuilding") : t("rebuild")}
          </Button>
        }
      />

      {!repoId ? (
        <Card>
          <CardContent className="text-muted-foreground pt-6 text-sm">
            {t("noRepo")}
          </CardContent>
        </Card>
      ) : null}

      {summaryLoading && !summary ? <Skeleton className="h-40 w-full" /> : null}

      {repoId && summary && summary.edgeCount === 0 ? (
        <Card>
          <CardContent className="text-muted-foreground pt-6 text-sm">
            {t("emptyGraph")}
          </CardContent>
        </Card>
      ) : null}

      {repoId && summary && summary.edgeCount > 0 ? (
        <>
          <Card>
            <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-3 pt-6">
              <div>
                <div className="text-muted-foreground text-xs">
                  {t("statsNodes")}
                </div>
                <div className="text-foreground mt-0.5 text-xl font-semibold">
                  {summary.nodeCount}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground text-xs">
                  {t("statsEdges")}
                </div>
                <div className="text-foreground mt-0.5 text-xl font-semibold">
                  {summary.edgeCount}
                </div>
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-muted-foreground mb-1.5 text-xs">
                  {t("relationDistribution")}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(summary.relationCounts).map(
                    ([relation, count]) => (
                      <span
                        key={relation}
                        className="border-input bg-background inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs"
                      >
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{
                            backgroundColor:
                              RELATION_COLORS[relation] ??
                              FALLBACK_RELATION_COLOR,
                          }}
                        />
                        {relationLabel(relation)}
                        <Badge variant="secondary">{count}</Badge>
                      </span>
                    ),
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
            <Card className="min-w-0">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">{t("pickerTitle")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("searchNodes")}
                  className="h-9"
                />
                <div className="max-h-[440px] space-y-1 overflow-y-auto pr-1">
                  {filteredNodes.map((node) => {
                    const key = keyOf(node.type, node.id);
                    const active = key === centerKey;
                    const style = NODE_STYLES[node.type] ?? FALLBACK_NODE_STYLE;
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() =>
                          setSelected({ type: node.type, id: node.id })
                        }
                        className={`hover:bg-muted/60 flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs transition ${
                          active
                            ? "border-foreground/30 bg-muted font-medium"
                            : "border-transparent"
                        }`}
                      >
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: style.stroke }}
                        />
                        <span className="text-foreground min-w-0 flex-1 truncate">
                          {node.label}
                        </span>
                        <span className="text-muted-foreground shrink-0">
                          {nodeTypeLabel(node.type)}
                        </span>
                      </button>
                    );
                  })}
                  {filteredNodes.length === 0 ? (
                    <p className="text-muted-foreground py-6 text-center text-xs">
                      {t("noNodes")}
                    </p>
                  ) : null}
                </div>
              </CardContent>
            </Card>

            <Card className="min-w-0">
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
                <CardTitle className="text-sm">{t("selectNodeHint")}</CardTitle>
                <div className="flex items-center gap-1.5">
                  <span className="text-muted-foreground text-xs">
                    {t("depth")}
                  </span>
                  {DEPTHS.map((d) => (
                    <Button
                      key={d}
                      size="sm"
                      variant={depth === d ? "default" : "outline"}
                      className="h-7 w-7 p-0"
                      onClick={() => setDepth(d)}
                    >
                      {d}
                    </Button>
                  ))}
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {subLoading && !subgraph ? (
                  <Skeleton className="h-[420px] w-full" />
                ) : null}
                {!selected ? (
                  <p className="text-muted-foreground py-20 text-center text-sm">
                    {t("selectNodeHint")}
                  </p>
                ) : null}
                {subgraph && selected ? (
                  <>
                    <div className="bg-muted/40 overflow-x-auto rounded-md">
                      <svg
                        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
                        className="h-[420px] w-full min-w-[640px]"
                        role="img"
                        aria-label={t("title")}
                      >
                        {subgraph.edges.map((edge) => {
                          const from = positions.get(
                            keyOf(edge.fromType, edge.fromId),
                          );
                          const to = positions.get(
                            keyOf(edge.toType, edge.toId),
                          );
                          if (!from || !to) return null;
                          const color =
                            RELATION_COLORS[edge.relation] ??
                            FALLBACK_RELATION_COLOR;
                          return (
                            <g key={edge.id}>
                              <line
                                x1={from.x}
                                y1={from.y}
                                x2={to.x}
                                y2={to.y}
                                stroke={color}
                                strokeWidth={1.6}
                                strokeOpacity={0.58}
                              />
                              {showEdgeLabels ? (
                                <text
                                  x={(from.x + to.x) / 2}
                                  y={(from.y + to.y) / 2 - 5}
                                  textAnchor="middle"
                                  fontSize={10}
                                  fontWeight={700}
                                  fill={color}
                                >
                                  {relationLabel(edge.relation)}
                                </text>
                              ) : null}
                            </g>
                          );
                        })}
                        {subgraph.nodes.map((node) => {
                          const key = keyOf(node.type, node.id);
                          const pos = positions.get(key);
                          if (!pos) return null;
                          const isCenter = key === centerKey;
                          const style =
                            NODE_STYLES[node.type] ?? FALLBACK_NODE_STYLE;
                          return (
                            <g
                              key={key}
                              role="button"
                              tabIndex={0}
                              className="cursor-pointer"
                              onClick={() =>
                                setSelected({ type: node.type, id: node.id })
                              }
                              onKeyDown={(event) => {
                                if (
                                  event.key === "Enter" ||
                                  event.key === " "
                                ) {
                                  setSelected({
                                    type: node.type,
                                    id: node.id,
                                  });
                                }
                              }}
                            >
                              <circle
                                cx={pos.x}
                                cy={pos.y}
                                r={isCenter ? 19 : 14}
                                fill={style.fill}
                                stroke={isCenter ? "#111827" : style.stroke}
                                strokeWidth={isCenter ? 2.6 : 1.6}
                              />
                              <text
                                x={pos.x}
                                y={pos.y + 33}
                                textAnchor="middle"
                                fontSize={11}
                                fontWeight={isCenter ? 700 : 600}
                                fill="#334155"
                              >
                                {clipLabel(node.label, 18)}
                              </text>
                              <text
                                x={pos.x}
                                y={pos.y + 46}
                                textAnchor="middle"
                                fontSize={9}
                                fill="#64748b"
                              >
                                {nodeTypeLabel(node.type)}
                              </text>
                            </g>
                          );
                        })}
                      </svg>
                    </div>

                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                      {legendRelations.map((relation) => (
                        <span
                          key={relation}
                          className="text-muted-foreground inline-flex items-center gap-1.5 text-xs"
                        >
                          <span
                            className="h-0.5 w-5 rounded-full"
                            style={{
                              backgroundColor:
                                RELATION_COLORS[relation] ??
                                FALLBACK_RELATION_COLOR,
                            }}
                          />
                          {relationLabel(relation)}
                        </span>
                      ))}
                      {subgraph.truncated ? (
                        <span className="text-muted-foreground text-xs">
                          {t("truncatedNotice")}
                        </span>
                      ) : null}
                    </div>

                    <div className="space-y-1.5">
                      <h4 className="text-foreground text-xs font-medium">
                        {t("adjacency")}
                      </h4>
                      {adjacencyRows.length === 0 ? (
                        <p className="text-muted-foreground text-xs">
                          {t("noAdjacency")}
                        </p>
                      ) : null}
                      <div className="max-h-44 space-y-1 overflow-y-auto pr-1">
                        {adjacencyRows.map((edge) => {
                          const outgoing =
                            keyOf(edge.fromType, edge.fromId) === centerKey;
                          const otherType = outgoing
                            ? edge.toType
                            : edge.fromType;
                          const otherId = outgoing ? edge.toId : edge.fromId;
                          return (
                            <div
                              key={edge.id}
                              className="bg-muted/50 flex items-center gap-2 rounded-md px-2 py-1 text-xs"
                            >
                              <span className="text-foreground shrink-0 font-medium">
                                {outgoing ? "→" : "←"}{" "}
                                {relationLabel(edge.relation)}
                              </span>
                              <button
                                type="button"
                                className="text-foreground/80 hover:text-foreground min-w-0 flex-1 truncate text-left hover:underline"
                                onClick={() =>
                                  setSelected({
                                    type: otherType,
                                    id: otherId,
                                  })
                                }
                              >
                                {labelByKey.get(keyOf(otherType, otherId)) ??
                                  otherId}
                              </button>
                              <span className="text-muted-foreground shrink-0">
                                {edge.confidence.toFixed(2)}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </>
                ) : null}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">{t("recentEdges")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              {summary.recentEdges.length === 0 ? (
                <p className="text-muted-foreground text-xs">
                  {t("noRecentEdges")}
                </p>
              ) : null}
              {summary.recentEdges.map((edge) => (
                <div
                  key={edge.id}
                  className="border-input flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b py-1.5 text-xs last:border-b-0"
                >
                  <span className="text-foreground max-w-[220px] truncate font-medium">
                    {labelByKey.get(keyOf(edge.fromType, edge.fromId)) ??
                      edge.fromId}
                  </span>
                  <span
                    className="inline-flex shrink-0 items-center gap-1"
                    style={{
                      color:
                        RELATION_COLORS[edge.relation] ??
                        FALLBACK_RELATION_COLOR,
                    }}
                  >
                    —{relationLabel(edge.relation)}→
                  </span>
                  <span className="text-foreground max-w-[220px] truncate">
                    {labelByKey.get(keyOf(edge.toType, edge.toId)) ?? edge.toId}
                  </span>
                  <span className="text-muted-foreground ml-auto shrink-0">
                    {edge.confidence.toFixed(2)} ·{" "}
                    {format.dateTime(new Date(edge.createdAt), "short")}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
