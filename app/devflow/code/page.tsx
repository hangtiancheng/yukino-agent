"use client";

// Code workspace (Category B): clone/refresh a repository's source checkout,
// browse + lexically search the code, and build a semantic project-doc index.
// Backed by /api/devflow/repos/:id/workspace* and /project-index.
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import {
  ChevronRight,
  Database,
  FileCode2,
  Folder,
  FolderGit2,
  GitBranch,
  RefreshCw,
  Search,
  X,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { notify } from "@/components/devflow/notify";
import PageHeader from "@/components/devflow/page-header";
import { dfGet, dfPost, useDevflow } from "@/components/devflow/provider";
import type {
  CodeSearchHit,
  FileContent,
  FileEntry,
  ProjectIndexState,
  WorkspaceStatus,
} from "@/lib/devflow/types";

function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 8) : "—";
}

// Typed value→key map for the API's free-form index status string, so the
// badges template literal stays compile-time checked; the guard rejects
// unknown values, which fall back to the raw string.
const INDEX_STATUS_KEYS = {
  idle: "idle",
  building: "building",
  ready: "ready",
  failed: "failed",
} as const;

function isIndexStatusKey(
  value: string,
): value is keyof typeof INDEX_STATUS_KEYS {
  return value in INDEX_STATUS_KEYS;
}

function parentPath(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "." : path.slice(0, idx);
}

export default function DevflowCodePage() {
  const { repoId, repo } = useDevflow();
  const t = useTranslations("devflow.code");
  const tb = useTranslations("devflow.badges");

  const [workspace, setWorkspace] = useState<WorkspaceStatus | null>(null);
  const [indexState, setIndexState] = useState<ProjectIndexState | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [cloning, setCloning] = useState(false);
  const [indexing, setIndexing] = useState(false);

  const [tab, setTab] = useState<"search" | "browse">("search");
  const [browsePath, setBrowsePath] = useState(".");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [entriesLoading, setEntriesLoading] = useState(false);

  const [file, setFile] = useState<FileContent | null>(null);
  const [fileLoading, setFileLoading] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<CodeSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Load workspace + project-index status for the selected repo.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!repoId) {
        setWorkspace(null);
        setIndexState(null);
        setStatusLoading(false);
        return;
      }
      setStatusLoading(true);
      setBrowsePath(".");
      setFile(null);
      setSearchResults([]);
      try {
        const [ws, idx] = await Promise.all([
          dfGet<WorkspaceStatus>(`/repos/${repoId}/workspace`),
          dfGet<ProjectIndexState>(`/repos/${repoId}/project-index`),
        ]);
        if (cancelled) return;
        setWorkspace(ws);
        setIndexState(idx);
      } catch {
        if (!cancelled) {
          setWorkspace(null);
          setIndexState(null);
        }
      } finally {
        if (!cancelled) setStatusLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoId]);

  // Load directory entries for the current browse path.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!repoId || !workspace?.cloned) {
        setEntries([]);
        return;
      }
      setEntriesLoading(true);
      try {
        const result = await dfGet<{
          path: string;
          count: number;
          entries: FileEntry[];
        }>(
          `/repos/${repoId}/workspace/files?path=${encodeURIComponent(browsePath)}&limit=300`,
        );
        if (!cancelled) setEntries(result.entries);
      } catch {
        if (!cancelled) setEntries([]);
      } finally {
        if (!cancelled) setEntriesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoId, browsePath, workspace?.cloned]);

  const openFile = useCallback(
    async (path: string, line?: number) => {
      if (!repoId) return;
      setFileLoading(true);
      setFile(null);
      try {
        const content = await dfGet<FileContent>(
          `/repos/${repoId}/workspace/file?path=${encodeURIComponent(path)}` +
            (line ? `&startLine=${Math.max(1, line - 5)}&lineCount=60` : ""),
        );
        setFile(content);
      } catch (e) {
        notify.error(e instanceof Error ? e.message : String(e));
      } finally {
        setFileLoading(false);
      }
    },
    [repoId],
  );

  const handleClone = async () => {
    if (!repoId) return;
    setCloning(true);
    try {
      const ws = await dfPost<WorkspaceStatus>(
        `/repos/${repoId}/workspace`,
        {},
      );
      setWorkspace(ws);
      notify.success(
        t("codeReady", {
          branch: ws.branch ?? "default",
          sha: shortSha(ws.commitSha),
        }),
      );
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setCloning(false);
    }
  };

  const handleIndex = async () => {
    if (!repoId) return;
    setIndexing(true);
    try {
      const result = await dfPost<{
        fileCount: number;
        chunkCount: number;
        fingerprint: string;
      }>(`/repos/${repoId}/project-index`, {});
      notify.success(
        t("indexedDocs", {
          files: result.fileCount,
          chunks: result.chunkCount,
        }),
      );
      const idx = await dfGet<ProjectIndexState>(
        `/repos/${repoId}/project-index`,
      );
      setIndexState(idx);
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
      const idx = await dfGet<ProjectIndexState>(
        `/repos/${repoId}/project-index`,
      ).catch(() => null);
      if (idx) setIndexState(idx);
    } finally {
      setIndexing(false);
    }
  };

  const handleSnooze = async () => {
    if (!repoId) return;
    try {
      await dfPost<unknown>(`/repos/${repoId}/project-index`, {
        action: "snooze",
        days: 7,
      });
      const idx = await dfGet<ProjectIndexState>(
        `/repos/${repoId}/project-index`,
      );
      setIndexState(idx);
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    }
  };

  const handleSearch = async () => {
    const query = searchQuery.trim();
    if (!query || !repoId) return;
    setSearching(true);
    setSearchError(null);
    try {
      const result = await dfPost<{
        query: string;
        count: number;
        hits: CodeSearchHit[];
      }>(`/repos/${repoId}/workspace/search`, { query, limit: 20 });
      setSearchResults(result.hits);
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : String(e));
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  };

  const cloned = workspace?.cloned ?? false;
  const indexStatusValue = indexState?.status ?? "idle";

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
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-32 rounded-xl" />
          <Skeleton className="h-32 rounded-xl" />
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader className="py-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <FolderGit2 className="size-4" />
                {t("workspaceCheckout")}
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
                  <span className="font-mono break-all opacity-70">
                    {workspace?.path.split("/").slice(-2).join("/")}
                  </span>
                </div>
              ) : (
                <p className="text-muted-foreground text-xs">
                  {t("notCloned")}
                </p>
              )}
              <Button
                onClick={() => void handleClone()}
                disabled={cloning || !repoId}
                size="sm"
                variant={cloned ? "outline" : "default"}
              >
                {cloning ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <RefreshCw className="size-3.5" />
                )}
                {cloned ? t("refreshCheckout") : t("cloneCode")}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="py-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Database className="size-4" />
                {t("projectDocIndex")}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
                <Badge
                  variant={
                    indexState?.status === "ready"
                      ? "secondary"
                      : indexState?.status === "building"
                        ? "default"
                        : indexState?.status === "failed"
                          ? "destructive"
                          : "outline"
                  }
                >
                  {isIndexStatusKey(indexStatusValue)
                    ? tb(`indexStatus.${INDEX_STATUS_KEYS[indexStatusValue]}`)
                    : indexStatusValue}
                </Badge>
                <span>
                  {t("docsChunks", {
                    files: indexState?.fileCount ?? 0,
                    chunks: indexState?.chunkCount ?? 0,
                  })}
                </span>
                {indexState?.stale ? (
                  <>
                    <Badge variant="outline">{tb("stale")}</Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 text-xs"
                      onClick={handleSnooze}
                    >
                      {t("snooze")}
                    </Button>
                  </>
                ) : null}
                {indexState?.snoozed ? (
                  <Badge variant="outline" className="text-[10px]">
                    {t("snoozedUntil", {
                      until: indexState.snoozedUntil
                        ? String(indexState.snoozedUntil).slice(0, 10)
                        : "",
                    })}
                  </Badge>
                ) : null}
              </div>
              {indexState?.summary?.techStack &&
              indexState.summary.techStack.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {indexState.summary.techStack.map((tech) => (
                    <Badge key={tech} variant="outline" className="text-[10px]">
                      {tech}
                    </Badge>
                  ))}
                </div>
              ) : null}
              {indexState?.status === "failed" && indexState.errorMessage ? (
                <p className="text-destructive text-xs break-words">
                  {indexState.errorMessage.slice(0, 160)}
                </p>
              ) : null}
              <Button
                onClick={() => void handleIndex()}
                disabled={indexing || !repoId}
                size="sm"
                variant="outline"
              >
                {indexing ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <Database className="size-3.5" />
                )}
                {indexState?.status === "ready"
                  ? t("reindexDocs")
                  : t("indexDocs")}
              </Button>
            </CardContent>
          </Card>
        </div>
      )}

      {!cloned ? (
        <Empty className="border-border rounded-xl border border-dashed py-16">
          <EmptyMedia variant="icon">
            <FolderGit2 />
          </EmptyMedia>
          <EmptyTitle>{t("noCheckoutTitle")}</EmptyTitle>
          <EmptyDescription>{t("noCheckoutDescription")}</EmptyDescription>
        </Empty>
      ) : (
        <>
          <Tabs
            value={tab}
            onValueChange={(v) => setTab(v as "search" | "browse")}
          >
            <TabsList>
              <TabsTrigger value="search">{t("tabSearch")}</TabsTrigger>
              <TabsTrigger value="browse">{t("tabBrowse")}</TabsTrigger>
            </TabsList>

            <TabsContent value="search" className="space-y-4">
              <div className="flex gap-2">
                <Input
                  placeholder={t("searchPlaceholder")}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleSearch();
                  }}
                  className="flex-1"
                />
                <Button
                  onClick={() => void handleSearch()}
                  disabled={searching || !searchQuery.trim()}
                >
                  {searching ? (
                    <Spinner className="size-4" />
                  ) : (
                    <Search className="size-4" />
                  )}
                  {t("search")}
                </Button>
              </div>

              {searchError ? (
                <p className="text-destructive text-sm">{searchError}</p>
              ) : null}

              {searching ? (
                <div className="flex justify-center py-10">
                  <Spinner className="size-5" />
                </div>
              ) : searchResults.length > 0 ? (
                <div className="space-y-2">
                  {searchResults.map((hit, i) => (
                    <button
                      key={`${hit.path}:${hit.line}:${i}`}
                      onClick={() => void openFile(hit.path, hit.line)}
                      className="border-border bg-card hover:bg-accent/50 block w-full rounded-lg border p-3 text-left transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <Badge
                          variant="outline"
                          className="font-mono text-[10px]"
                        >
                          {hit.path}:{hit.line}
                        </Badge>
                        <span className="text-muted-foreground text-[10px] tabular-nums">
                          {t("score", { score: hit.score.toFixed(2) })}
                        </span>
                      </div>
                      <pre className="text-foreground mt-2 overflow-x-auto font-mono text-xs whitespace-pre">
                        {hit.snippet}
                      </pre>
                    </button>
                  ))}
                </div>
              ) : searchQuery && !searching ? (
                <p className="text-muted-foreground py-6 text-center text-sm">
                  {t("noMatches")}
                </p>
              ) : null}
            </TabsContent>

            <TabsContent value="browse" className="space-y-3">
              <div className="text-muted-foreground flex items-center gap-1 font-mono text-xs">
                <button
                  onClick={() => setBrowsePath(".")}
                  className="hover:text-foreground"
                >
                  {repo?.name}
                </button>
                {browsePath !== "." ? (
                  <>
                    <ChevronRight className="size-3" />
                    <span className="text-foreground break-all">
                      {browsePath}
                    </span>
                  </>
                ) : null}
                {browsePath !== "." ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-2 h-6 px-2 text-xs"
                    onClick={() => setBrowsePath(parentPath(browsePath))}
                  >
                    {t("up")}
                  </Button>
                ) : null}
              </div>

              {entriesLoading ? (
                <div className="flex justify-center py-10">
                  <Spinner className="size-5" />
                </div>
              ) : (
                <div className="border-border bg-card divide-border divide-y overflow-hidden rounded-lg border">
                  {entries.length === 0 ? (
                    <p className="text-muted-foreground px-3 py-6 text-center text-sm">
                      {t("emptyDirectory")}
                    </p>
                  ) : (
                    entries.map((entry) => (
                      <button
                        key={entry.path}
                        onClick={() =>
                          entry.type === "dir"
                            ? setBrowsePath(entry.path)
                            : void openFile(entry.path)
                        }
                        className="hover:bg-accent/50 flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors"
                      >
                        {entry.type === "dir" ? (
                          <Folder className="text-primary/70 size-4 shrink-0" />
                        ) : (
                          <FileCode2 className="text-muted-foreground size-4 shrink-0" />
                        )}
                        <span className="min-w-0 flex-1 truncate">
                          {entry.path.split("/").pop()}
                        </span>
                        {entry.type === "file" && entry.size !== null ? (
                          <span className="text-muted-foreground shrink-0 text-[10px] tabular-nums">
                            {entry.size > 1024
                              ? `${(entry.size / 1024).toFixed(1)} KB`
                              : `${entry.size} B`}
                          </span>
                        ) : null}
                      </button>
                    ))
                  )}
                </div>
              )}
            </TabsContent>
          </Tabs>

          {(file || fileLoading) && (
            <Card>
              <CardHeader className="py-3">
                <CardTitle className="flex items-center justify-between gap-2 text-sm">
                  <span className="flex min-w-0 items-center gap-2">
                    <FileCode2 className="text-muted-foreground size-4 shrink-0" />
                    <span className="truncate font-mono">
                      {file?.path ?? "…"}
                    </span>
                    {file ? (
                      <span className="text-muted-foreground shrink-0 text-xs font-normal">
                        {t("linesRange", {
                          start: file.startLine,
                          end: file.endLine,
                          total: file.totalLines,
                        })}
                      </span>
                    ) : null}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setFile(null)}
                  >
                    <X className="size-4" />
                  </Button>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {fileLoading ? (
                  <div className="flex justify-center py-10">
                    <Spinner className="size-5" />
                  </div>
                ) : file ? (
                  <pre className="bg-muted/40 max-h-[60vh] overflow-auto rounded-lg p-3 font-mono text-xs leading-relaxed whitespace-pre">
                    {file.content}
                  </pre>
                ) : null}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
