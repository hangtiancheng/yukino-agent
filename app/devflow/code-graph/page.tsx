"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import {
  FileCode2,
  GitBranch,
  Network,
  RefreshCw,
  Search,
  Share2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { notify } from "@/components/devflow/notify";
import PageHeader from "@/components/devflow/page-header";
import { dfGet, dfPost, useDevflow } from "@/components/devflow/provider";
import type { WorkspaceStatus } from "@/lib/devflow/types";

interface SymbolRow {
  id: string;
  path: string;
  name: string;
  kind: string;
  language: string;
  startLine: number | null;
  endLine: number | null;
  branch: string | null;
  commitSha: string | null;
}

interface RelationRow {
  id: string;
  sourceName: string | null;
  targetName: string;
  type: string;
  path: string | null;
  line: number | null;
}

interface ExcerptRow {
  path: string;
  symbol: string;
  startLine: number;
  endLine: number;
  snippet: string;
}

interface SymbolSearchResponse {
  query: string;
  count: number;
  symbols: SymbolRow[];
  relations: RelationRow[];
  documents: ExcerptRow[];
}

interface RebuildSummary {
  branch: string;
  commitSha: string | null;
  filesScanned: number;
  symbolCount: number;
  relationCount: number;
  truncated: boolean;
}

interface ImpactDependent {
  path: string | null;
  sourceName: string | null;
  targetName: string;
  type: string;
  line: number | null;
  sameFile: boolean;
}

interface ImpactReport {
  files: string[];
  symbols: SymbolRow[];
  dependents: ImpactDependent[];
}

interface CommittedFilters {
  query: string;
  kind: string;
  language: string;
}

function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 8) : "—";
}

function linesLabel(row: SymbolRow): string {
  return `${row.startLine ?? "?"}-${row.endLine ?? "?"}`;
}

export default function DevflowCodeGraphPage() {
  const { repoId, repo } = useDevflow();
  const t = useTranslations("devflow.codeGraph");
  const tCode = useTranslations("devflow.code");

  const [workspace, setWorkspace] = useState<WorkspaceStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [rebuilding, setRebuilding] = useState(false);
  const [summary, setSummary] = useState<RebuildSummary | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("");
  const [language, setLanguage] = useState("");
  const [committed, setCommitted] = useState<CommittedFilters | null>(null);
  const [symbols, setSymbols] = useState<SymbolRow[]>([]);
  const [relations, setRelations] = useState<RelationRow[]>([]);
  const [documents, setDocuments] = useState<ExcerptRow[]>([]);
  const [symbolsLoading, setSymbolsLoading] = useState(false);

  const [impactInput, setImpactInput] = useState("");
  const [impact, setImpact] = useState<ImpactReport | null>(null);
  const [impactLoading, setImpactLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!repoId) {
        setWorkspace(null);
        setStatusLoading(false);
        return;
      }
      setStatusLoading(true);
      setSummary(null);
      setCommitted(null);
      setSymbols([]);
      setRelations([]);
      setDocuments([]);
      setImpact(null);
      try {
        const ws = await dfGet<WorkspaceStatus>(`/repos/${repoId}/workspace`);
        if (!cancelled) setWorkspace(ws);
      } catch {
        if (!cancelled) setWorkspace(null);
      } finally {
        if (!cancelled) setStatusLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!repoId) {
        setSymbols([]);
        setRelations([]);
        setDocuments([]);
        return;
      }
      setSymbolsLoading(true);
      try {
        const params = new URLSearchParams();
        if (committed?.query) params.set("query", committed.query);
        if (committed?.kind) params.set("kind", committed.kind);
        if (committed?.language) params.set("language", committed.language);
        params.set("limit", "100");
        const result = await dfGet<SymbolSearchResponse>(
          `/repos/${repoId}/code-graph?${params.toString()}`,
        );
        if (!cancelled) {
          setSymbols(result.symbols);
          setRelations(result.relations ?? []);
          setDocuments(result.documents ?? []);
        }
      } catch (e) {
        if (!cancelled) {
          setSymbols([]);
          setRelations([]);
          setDocuments([]);
          notify.error(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setSymbolsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoId, committed, reloadKey]);

  const handleSearch = () => {
    setCommitted({
      query: query.trim(),
      kind: kind.trim(),
      language: language.trim(),
    });
  };

  const handleRebuild = async () => {
    if (!repoId) return;
    setRebuilding(true);
    try {
      const result = await dfPost<RebuildSummary>(
        `/repos/${repoId}/code-graph`,
        { action: "rebuild" },
      );
      setSummary(result);
      notify.success(
        t("rebuilt", {
          files: result.filesScanned,
          symbols: result.symbolCount,
          relations: result.relationCount,
          truncated: result.truncated ? t("truncatedNote") : "",
        }),
      );
      setReloadKey((key) => key + 1);
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setRebuilding(false);
    }
  };

  const handleImpact = async () => {
    const files = impactInput.trim();
    if (!repoId || !files) return;
    setImpactLoading(true);
    setImpact(null);
    try {
      const result = await dfGet<ImpactReport>(
        `/repos/${repoId}/code-graph/impact?files=${encodeURIComponent(files)}`,
      );
      setImpact(result);
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setImpactLoading(false);
    }
  };

  const cloned = workspace?.cloned ?? false;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <PageHeader
        title={t("title")}
        description={
          repo
            ? t("descriptionRepo", { repo: repo.fullName })
            : t("descriptionNone")
        }
      />

      {statusLoading ? (
        <Skeleton className="h-28 rounded-xl" />
      ) : (
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Network className="size-4" />
              {t("title")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {cloned ? (
              <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
                <Badge variant="secondary" className="gap-1">
                  <GitBranch className="size-3" />
                  {workspace?.branch ?? "—"}
                </Badge>
                <Badge variant="outline" className="font-mono">
                  {shortSha(workspace?.commitSha ?? null)}
                </Badge>
                {summary ? (
                  <span>
                    {t("graphStats", {
                      files: summary.filesScanned,
                      symbols: summary.symbolCount,
                      relations: summary.relationCount,
                    })}
                  </span>
                ) : null}
              </div>
            ) : (
              <p className="text-muted-foreground text-xs">
                {tCode("notCloned")}
              </p>
            )}
            <Button
              onClick={() => void handleRebuild()}
              disabled={rebuilding || !repoId || !cloned}
              size="sm"
            >
              {rebuilding ? (
                <Spinner className="size-3.5" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              {rebuilding ? t("rebuilding") : t("rebuild")}
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Input
            placeholder={t("searchPlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSearch();
            }}
            className="min-w-56 flex-1"
          />
          <Input
            placeholder={t("kindPlaceholder")}
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSearch();
            }}
            className="w-44"
          />
          <Input
            placeholder={t("languagePlaceholder")}
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSearch();
            }}
            className="w-40"
          />
          <Button onClick={handleSearch} disabled={symbolsLoading}>
            {symbolsLoading ? (
              <Spinner className="size-4" />
            ) : (
              <Search className="size-4" />
            )}
            {t("search")}
          </Button>
        </div>

        {symbolsLoading ? (
          <div className="flex justify-center py-10">
            <Spinner className="size-5" />
          </div>
        ) : symbols.length > 0 ? (
          <div className="border-border bg-card overflow-hidden rounded-lg border">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted-foreground border-border border-b text-left text-xs">
                  <th className="px-3 py-2 font-medium">{t("colName")}</th>
                  <th className="px-3 py-2 font-medium">{t("colKind")}</th>
                  <th className="px-3 py-2 font-medium">{t("colLanguage")}</th>
                  <th className="px-3 py-2 font-medium">{t("colPath")}</th>
                  <th className="px-3 py-2 font-medium">{t("colLines")}</th>
                </tr>
              </thead>
              <tbody className="divide-border divide-y">
                {symbols.map((symbol) => (
                  <tr key={symbol.id} className="hover:bg-accent/40">
                    <td className="px-3 py-1.5 font-mono text-xs">
                      {symbol.name}
                    </td>
                    <td className="px-3 py-1.5">
                      <Badge variant="outline" className="text-[10px]">
                        {symbol.kind}
                      </Badge>
                    </td>
                    <td className="text-muted-foreground px-3 py-1.5 text-xs">
                      {symbol.language}
                    </td>
                    <td className="max-w-72 truncate px-3 py-1.5 font-mono text-xs">
                      {symbol.path}
                    </td>
                    <td className="text-muted-foreground px-3 py-1.5 text-xs tabular-nums">
                      {linesLabel(symbol)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : committed ? (
          <p className="text-muted-foreground py-6 text-center text-sm">
            {t("noSymbols")}
          </p>
        ) : (
          <Empty className="border-border rounded-xl border border-dashed py-16">
            <EmptyMedia variant="icon">
              <Network />
            </EmptyMedia>
            <EmptyTitle>{t("emptyTitle")}</EmptyTitle>
            <EmptyDescription>{t("emptyDescription")}</EmptyDescription>
          </Empty>
        )}

        {relations.length > 0 ? (
          <div className="mt-5 space-y-2">
            <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              {t("relationsTitle", { count: relations.length })}
            </p>
            <div className="border-border bg-card overflow-hidden rounded-lg border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-muted-foreground border-border border-b text-left text-xs">
                    <th className="px-3 py-2 font-medium">{t("colSource")}</th>
                    <th className="px-3 py-2 font-medium">
                      {t("colRelation")}
                    </th>
                    <th className="px-3 py-2 font-medium">{t("colTarget")}</th>
                    <th className="px-3 py-2 font-medium">
                      {t("colLocation")}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-border divide-y">
                  {relations.map((relation) => (
                    <tr key={relation.id} className="hover:bg-accent/40">
                      <td className="px-3 py-1.5 font-mono text-xs">
                        {relation.sourceName ?? "—"}
                      </td>
                      <td className="px-3 py-1.5">
                        <Badge variant="outline" className="text-[10px]">
                          {relation.type}
                        </Badge>
                      </td>
                      <td className="px-3 py-1.5 font-mono text-xs">
                        {relation.targetName}
                      </td>
                      <td className="text-muted-foreground max-w-72 truncate px-3 py-1.5 font-mono text-xs">
                        {relation.path ?? "—"}
                        {relation.line !== null ? `:${relation.line}` : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        {documents.length > 0 ? (
          <div className="mt-5 space-y-2">
            <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              {t("documentsTitle", { count: documents.length })}
            </p>
            <div className="space-y-2">
              {documents.map((doc) => (
                <div
                  key={`${doc.path}:${doc.startLine}`}
                  className="border-border bg-card overflow-hidden rounded-lg border"
                >
                  <div className="border-border bg-muted/40 text-muted-foreground flex items-center gap-2 border-b px-3 py-1.5 font-mono text-xs">
                    <FileCode2 className="size-3.5 shrink-0" />
                    <span className="truncate">
                      {doc.path}:{doc.startLine}-{doc.endLine}
                    </span>
                    <Badge variant="secondary" className="ml-auto text-[10px]">
                      {doc.symbol}
                    </Badge>
                  </div>
                  <pre className="text-foreground/90 max-h-56 overflow-auto px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre">
                    {doc.snippet}
                  </pre>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <Card>
        <CardHeader className="py-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Share2 className="size-4" />
            {t("impactTitle")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-muted-foreground text-xs">
            {t("impactDescription")}
          </p>
          <div className="flex gap-2">
            <Input
              placeholder={t("impactPlaceholder")}
              value={impactInput}
              onChange={(e) => setImpactInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleImpact();
              }}
              className="flex-1 font-mono text-xs"
            />
            <Button
              onClick={() => void handleImpact()}
              disabled={impactLoading || !impactInput.trim() || !repoId}
              variant="outline"
            >
              {impactLoading ? (
                <Spinner className="size-4" />
              ) : (
                <Share2 className="size-4" />
              )}
              {t("impactRun")}
            </Button>
          </div>

          {impact ? (
            impact.symbols.length === 0 && impact.dependents.length === 0 ? (
              <p className="text-muted-foreground py-2 text-center text-sm">
                {t("impactNone")}
              </p>
            ) : (
              <div className="space-y-4">
                <div className="space-y-1">
                  <p className="text-muted-foreground text-xs">
                    {t("changedSymbols", { count: impact.symbols.length })}
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {impact.symbols.map((symbol) => (
                      <Badge
                        key={symbol.id}
                        variant="secondary"
                        className="gap-1 font-mono text-[10px]"
                      >
                        {symbol.name}
                        <span className="text-muted-foreground font-normal">
                          {symbol.path}:{symbol.startLine ?? "?"}
                        </span>
                      </Badge>
                    ))}
                  </div>
                </div>
                <div className="space-y-1">
                  <p className="text-muted-foreground text-xs">
                    {t("dependents", { count: impact.dependents.length })}
                  </p>
                  {impact.dependents.length === 0 ? (
                    <p className="text-muted-foreground py-1 text-xs">
                      {t("impactNone")}
                    </p>
                  ) : (
                    <div className="border-border bg-card divide-border divide-y overflow-hidden rounded-lg border">
                      {impact.dependents.map((dependent, index) => (
                        <div
                          key={`${dependent.type}:${dependent.path}:${dependent.sourceName}:${dependent.targetName}:${index}`}
                          className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-xs"
                        >
                          <Badge variant="outline" className="text-[10px]">
                            {dependent.type}
                          </Badge>
                          <span className="font-mono">
                            {dependent.sourceName ?? dependent.path ?? "?"}
                          </span>
                          <span className="text-muted-foreground">→</span>
                          <span className="font-mono">
                            {dependent.targetName}
                          </span>
                          {dependent.path ? (
                            <span className="text-muted-foreground ml-auto truncate font-mono text-[10px]">
                              {dependent.path}
                              {dependent.line ? `:${dependent.line}` : ""}
                            </span>
                          ) : null}
                          {dependent.sameFile ? (
                            <Badge variant="outline" className="text-[10px]">
                              {t("sameFile")}
                            </Badge>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
