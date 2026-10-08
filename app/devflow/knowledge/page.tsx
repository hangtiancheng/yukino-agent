"use client";

// Knowledge Base: per-repository RAG workspace — upload documents, tune the
// per-repo retrieval settings, run persisted retrieval tests, rebuild the
// GitHub content index and ask evidence-grounded questions with citations.
import { useEffect, useRef, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import {
  BookOpen,
  Database,
  Eye,
  FileUp,
  History,
  MessageCircleQuestion,
  RefreshCw,
  RotateCw,
  Save,
  Search,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  StickyNote,
  Trash2,
  Upload,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { notify } from "@/components/devflow/notify";
import PageHeader from "@/components/devflow/page-header";
import DevflowMarkdown from "@/components/devflow/markdown";
import { DocStatusBadge } from "@/components/devflow/badges";
import {
  DevflowApiError,
  dfDelete,
  dfGet,
  dfPost,
  dfUpload,
  useDevflow,
} from "@/components/devflow/provider";
import type { KnowledgeCitation, KnowledgeDoc } from "@/lib/devflow/types";

// Client-side mirrors of the server shapes (the lib modules own runtime
// imports of prisma/milvus, so only types are mirrored here, kept in sync
// with lib/devflow/rag.ts + lib/devflow/content-index.ts).
type KbRetrievalMethod = "hybrid" | "dense" | "bm25";

interface KnowledgeConfig {
  retrievalMethod: KbRetrievalMethod;
  rerankEnabled: boolean;
  topK: number;
  chunkSize: number;
  chunkOverlap: number;
}

interface RetrievalTestResult {
  docId: string;
  docName: string;
  chunkIndex: number;
  sourceType?: string;
  sectionTitle?: string;
  rankReason?: string;
  score: number;
  excerpt: string;
}

interface RetrievalTestRun {
  id: string;
  query: string;
  resultCount: number;
  durationMs: number;
  createdAt: string;
}

interface RetrievalTestRunDetail extends RetrievalTestRun {
  results: RetrievalTestResult[];
}

// Client mirror of lib/devflow/rag.ts KnowledgeChunkView (chunk preview).
interface KnowledgeChunkPreview {
  id: string;
  position: number;
  title: string;
  content: string;
  characterCount: number;
}

type ContentSourceType = "issue" | "pull_request" | "workflow_run";

interface ContentIndexResult {
  repoId: string;
  itemCount: number;
  chunkCount: number;
  byType: Record<ContentSourceType, { items: number; chunks: number }>;
  durationMs: number;
}

// Typed value→key map for the API's free-form sourceType string, so the
// badges template literal stays compile-time checked; the guard rejects
// unknown values, which fall back to the raw string.
const SOURCE_TYPE_KEYS = {
  upload: "upload",
  weekly_report: "weeklyReport",
} as const;

function isSourceTypeKey(
  value: string,
): value is keyof typeof SOURCE_TYPE_KEYS {
  return value in SOURCE_TYPE_KEYS;
}

const RETRIEVAL_METHODS: KbRetrievalMethod[] = ["hybrid", "dense", "bm25"];

const METHOD_KEYS: Record<KbRetrievalMethod, "hybrid" | "dense" | "bm25"> = {
  hybrid: "hybrid",
  dense: "dense",
  bm25: "bm25",
};

const CONTENT_TYPE_ORDER: ContentSourceType[] = [
  "issue",
  "pull_request",
  "workflow_run",
];

const CONTENT_TYPE_KEYS: Record<
  ContentSourceType,
  "issue" | "pullRequest" | "workflowRun"
> = {
  issue: "issue",
  pull_request: "pullRequest",
  workflow_run: "workflowRun",
};

// provider.tsx has no PUT helper and stays import-only for this page, so the
// {message,data} unwrap is replicated locally with the shared error class.
async function dfPut<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`/api/devflow${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => null)) as {
    message?: string;
    data?: T;
  } | null;
  if (!response.ok) {
    throw new DevflowApiError(
      payload?.message || `${response.status} ${response.statusText}`,
      response.status,
    );
  }
  return payload?.data as T;
}

export default function DevflowKnowledgePage() {
  const { repoId, repo } = useDevflow();
  const t = useTranslations("devflow.knowledge");
  const tb = useTranslations("devflow.badges");
  const tc = useTranslations("common");
  const format = useFormatter();
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeDoc | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Chunk preview (GET /knowledge/:docId/chunks) + retry (POST .../retry) +
  // memory note (POST /knowledge/notes) — the RAG-studio document surfaces.
  const [previewDoc, setPreviewDoc] = useState<KnowledgeDoc | null>(null);
  const [previewChunks, setPreviewChunks] = useState<KnowledgeChunkPreview[]>(
    [],
  );
  const [previewLoading, setPreviewLoading] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteTitle, setNoteTitle] = useState("");
  const [noteContent, setNoteContent] = useState("");
  const [noteSaving, setNoteSaving] = useState(false);

  // Retrieval test state (persisted runs via /knowledge/retrieval-tests)
  const [testQuery, setTestQuery] = useState("");
  const [testTopK, setTestTopK] = useState(5);
  const [testResults, setTestResults] = useState<RetrievalTestResult[] | null>(
    null,
  );
  const [testDuration, setTestDuration] = useState<number | null>(null);
  const [testHistory, setTestHistory] = useState<RetrievalTestRun[]>([]);
  const [testing, setTesting] = useState(false);

  // Retrieval settings state (GET/PUT /knowledge/config)
  const [config, setConfig] = useState<KnowledgeConfig | null>(null);
  const [configStored, setConfigStored] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);

  // GitHub content index state (GET/POST /content-index)
  const [indexCounts, setIndexCounts] = useState<Record<
    ContentSourceType,
    number
  > | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [indexResult, setIndexResult] = useState<ContentIndexResult | null>(
    null,
  );
  const [indexing, setIndexing] = useState(false);

  // QA state
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [citations, setCitations] = useState<KnowledgeCitation[]>([]);
  const [asking, setAsking] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // Fetch lives in an inline async IIFE — see the note in provider.tsx
  // (react-hooks/set-state-in-effect). Switching repos also resets the
  // retrieval-test and QA panels.
  useEffect(() => {
    if (!repoId) {
      return;
    }
    let cancelled = false;
    (async () => {
      setDocsLoading(true);
      setTestResults(null);
      setTestDuration(null);
      setAnswer(null);
      setCitations([]);
      try {
        const items = await dfGet<KnowledgeDoc[]>(
          `/knowledge?repoId=${repoId}`,
        );
        if (!cancelled) setDocs(items);
      } catch (e) {
        if (!cancelled)
          notify.error(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setDocsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoId, reloadKey]);

  // Settings + retrieval-test history + content-index counts in one inline
  // async IIFE; the three fetches are independent so a down vector backend
  // (503 on /content-index) never blanks the other panels — the server's
  // already-localized error message is surfaced instead of fabricated counts.
  useEffect(() => {
    if (!repoId) {
      return;
    }
    let cancelled = false;
    (async () => {
      setConfig(null);
      setConfigStored(false);
      setIndexResult(null);
      const [configRes, historyRes, indexRes] = await Promise.allSettled([
        dfGet<{ config: KnowledgeConfig; stored: boolean }>(
          `/knowledge/config?repoId=${repoId}`,
        ),
        dfGet<RetrievalTestRun[]>(
          `/knowledge/retrieval-tests?repoId=${repoId}&limit=20`,
        ),
        dfGet<{ chunksByType: Record<ContentSourceType, number> }>(
          `/content-index?repoId=${repoId}`,
        ),
      ]);
      if (cancelled) return;
      if (configRes.status === "fulfilled") {
        setConfig(configRes.value.config);
        setConfigStored(configRes.value.stored);
      }
      setTestHistory(historyRes.status === "fulfilled" ? historyRes.value : []);
      if (indexRes.status === "fulfilled") {
        setIndexCounts(indexRes.value.chunksByType);
        setIndexError(null);
      } else {
        setIndexCounts(null);
        setIndexError(
          indexRes.reason instanceof Error
            ? indexRes.reason.message
            : String(indexRes.reason),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoId]);

  // Event-handler reloads just bump the key; the effect above refetches.
  const loadDocsAfterChange = async () => {
    setReloadKey((k) => k + 1);
  };

  const handleUpload = async (files: FileList | null) => {
    if (!files || files.length === 0 || !repoId) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.set("repoId", repoId);
        form.set("file", file);
        const result = await dfUpload<{
          status: string;
          chunkCount: number;
          existingName?: string;
        }>("/knowledge", form);
        if (result.status === "skipped") {
          notify.error(
            t("alreadyUploaded", { name: result.existingName ?? file.name }),
          );
        } else {
          notify.success(
            t("indexed", { name: file.name, chunks: result.chunkCount }),
          );
        }
      }
      await loadDocsAfterChange();
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const removeDoc = async () => {
    if (!deleteTarget) return;
    try {
      await dfDelete(`/knowledge/${deleteTarget.id}`);
      notify.success(t("deleted", { name: deleteTarget.name }));
      setDeleteTarget(null);
      await loadDocsAfterChange();
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    }
  };

  // Retry a failed document (POST /knowledge/:docId/retry).
  const retryDoc = async (doc: KnowledgeDoc) => {
    setRetryingId(doc.id);
    try {
      const result = await dfPost<{ status: string; chunkCount: number }>(
        `/knowledge/${doc.id}/retry`,
        {},
      );
      notify.success(
        t("retried", { name: doc.name, chunks: result.chunkCount }),
      );
      await loadDocsAfterChange();
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setRetryingId(null);
    }
  };

  // Open the chunk-preview dialog for a document.
  const openChunkPreview = async (doc: KnowledgeDoc) => {
    setPreviewDoc(doc);
    setPreviewChunks([]);
    setPreviewLoading(true);
    try {
      const res = await dfGet<{
        chunks: KnowledgeChunkPreview[];
      }>(`/knowledge/${doc.id}/chunks`);
      setPreviewChunks(res.chunks);
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
      setPreviewDoc(null);
    } finally {
      setPreviewLoading(false);
    }
  };

  // Create a memory note directly in the KB (POST /knowledge/notes).
  const createNote = async () => {
    if (!repoId) return;
    if (!noteTitle.trim() && !noteContent.trim()) {
      notify.error(t("noteNeedsContent"));
      return;
    }
    setNoteSaving(true);
    try {
      const result = await dfPost<{ status: string; chunkCount: number }>(
        "/knowledge/notes",
        { repoId, title: noteTitle.trim(), content: noteContent.trim() },
      );
      notify.success(t("noteCreated", { chunks: result.chunkCount }));
      setNoteOpen(false);
      setNoteTitle("");
      setNoteContent("");
      await loadDocsAfterChange();
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setNoteSaving(false);
    }
  };

  const runTest = async () => {
    if (!repoId || !testQuery.trim()) return;
    setTesting(true);
    try {
      const run = await dfPost<RetrievalTestRunDetail>(
        "/knowledge/retrieval-tests",
        {
          repoId,
          query: testQuery.trim(),
          topK: testTopK,
        },
      );
      setTestResults(run.results);
      setTestDuration(run.durationMs);
      setTestHistory((current) =>
        [
          {
            id: run.id,
            query: run.query,
            resultCount: run.resultCount,
            durationMs: run.durationMs,
            createdAt: run.createdAt,
          },
          ...current,
        ].slice(0, 20),
      );
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  };

  const saveConfig = async () => {
    if (!repoId || !config) return;
    // Legacy _validate_chunking: overlap must be strictly smaller.
    if (config.chunkOverlap >= config.chunkSize) return;
    setConfigSaving(true);
    try {
      const result = await dfPut<{
        config: KnowledgeConfig;
        stored: boolean;
      }>("/knowledge/config", { repoId, ...config });
      setConfig(result.config);
      setConfigStored(result.stored);
      notify.success(t("config.saved"));
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setConfigSaving(false);
    }
  };

  const rebuildIndex = async () => {
    if (!repoId) return;
    setIndexing(true);
    try {
      const result = await dfPost<ContentIndexResult>("/content-index", {
        repoId,
      });
      setIndexResult(result);
      setIndexCounts({
        issue: result.byType.issue.chunks,
        pull_request: result.byType.pull_request.chunks,
        workflow_run: result.byType.workflow_run.chunks,
      });
      setIndexError(null);
      notify.success(
        t("contentIndex.result", {
          items: result.itemCount,
          chunks: result.chunkCount,
          ms: result.durationMs,
        }),
      );
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setIndexing(false);
    }
  };

  const ask = async () => {
    if (!repoId || !question.trim()) return;
    setAsking(true);
    try {
      const result = await dfPost<{
        answer: string;
        citations: KnowledgeCitation[];
      }>("/knowledge/ask", { repoId, question: question.trim(), topK: 5 });
      setAnswer(result.answer);
      setCitations(result.citations);
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setAsking(false);
    }
  };

  const overlapInvalid =
    config !== null && config.chunkOverlap >= config.chunkSize;

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

      {!repoId ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-2 py-16 text-center">
            <BookOpen className="text-muted-foreground size-8" />
            <p className="text-muted-foreground text-sm">{t("connectFirst")}</p>
          </CardContent>
        </Card>
      ) : (
        <Tabs defaultValue="documents">
          <TabsList>
            <TabsTrigger value="documents">
              <Upload className="size-3.5" />
              {t("tabDocuments")}
            </TabsTrigger>
            <TabsTrigger value="retrieval">
              <Search className="size-3.5" />
              {t("tabRetrieval")}
            </TabsTrigger>
            <TabsTrigger value="qa">
              <MessageCircleQuestion className="size-3.5" />
              {t("tabQa")}
            </TabsTrigger>
            <TabsTrigger value="settings">
              <Settings2 className="size-3.5" />
              {t("tabSettings")}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="documents" className="mt-4 space-y-4">
            <Card
              className="border-dashed"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                void handleUpload(e.dataTransfer.files);
              }}
            >
              <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
                <div className="bg-primary/10 text-primary flex size-12 items-center justify-center rounded-xl">
                  <FileUp className="size-6" />
                </div>
                <div>
                  <p className="text-foreground text-sm font-medium">
                    {t("dropTitle")}
                  </p>
                  <p className="text-muted-foreground mt-1 text-xs">
                    {t("dropHint")}
                  </p>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => void handleUpload(e.target.files)}
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                  >
                    <Upload />
                    {uploading ? t("indexing") : t("uploadButton")}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => setNoteOpen(true)}
                    disabled={!repoId}
                  >
                    <StickyNote />
                    {t("createNote")}
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="py-3">
                <CardTitle className="text-sm">
                  {t("documents")}{" "}
                  <Badge variant="secondary" className="ml-1">
                    {docs.length}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {docsLoading ? (
                  <div className="space-y-2">
                    {Array.from({ length: 3 }).map((_, i) => (
                      <Skeleton key={i} className="h-12 rounded-lg" />
                    ))}
                  </div>
                ) : docs.length === 0 ? (
                  <p className="text-muted-foreground py-6 text-center text-sm italic">
                    {t("noDocuments")}
                  </p>
                ) : (
                  <div className="space-y-1">
                    {docs.map((doc) => (
                      <div
                        key={doc.id}
                        className="hover:bg-accent/40 flex items-center gap-3 rounded-lg px-3 py-2"
                      >
                        <BookOpen className="text-muted-foreground size-4 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <p className="text-foreground truncate text-sm font-medium">
                            {doc.name}
                          </p>
                          <p className="text-muted-foreground text-xs">
                            {t("docMeta", {
                              source: isSourceTypeKey(doc.sourceType)
                                ? tb(
                                    `sourceType.${SOURCE_TYPE_KEYS[doc.sourceType]}`,
                                  )
                                : doc.sourceType.replaceAll("_", " "),
                              chars: doc.charCount.toLocaleString(),
                              chunks: doc.chunkCount,
                              date: format.dateTime(
                                new Date(doc.createdAt),
                                "date",
                              ),
                            })}
                          </p>
                          {doc.errorMessage ? (
                            <p className="text-destructive mt-0.5 truncate text-xs">
                              {doc.errorMessage}
                            </p>
                          ) : null}
                        </div>
                        <DocStatusBadge status={doc.status} />
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-muted-foreground shrink-0"
                          title={t("previewChunks")}
                          onClick={() => void openChunkPreview(doc)}
                        >
                          <Eye className="size-4" />
                        </Button>
                        {doc.status === "failed" ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-muted-foreground shrink-0"
                            title={t("retry")}
                            disabled={retryingId === doc.id}
                            onClick={() => void retryDoc(doc)}
                          >
                            <RotateCw
                              className={
                                retryingId === doc.id
                                  ? "size-4 animate-spin"
                                  : "size-4"
                              }
                            />
                          </Button>
                        ) : null}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-muted-foreground hover:text-destructive shrink-0"
                          onClick={() => setDeleteTarget(doc)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="retrieval" className="mt-4 space-y-4">
            <Card>
              <CardContent className="space-y-3 pt-5">
                <div className="flex flex-wrap items-end gap-3">
                  <div className="min-w-52 flex-1 space-y-1.5">
                    <Label htmlFor="retrieval-query">{t("query")}</Label>
                    <Input
                      id="retrieval-query"
                      placeholder={t("queryPlaceholder")}
                      value={testQuery}
                      onChange={(e) => setTestQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void runTest();
                      }}
                    />
                  </div>
                  <div className="w-24 space-y-1.5">
                    <Label htmlFor="retrieval-topk">{t("topK")}</Label>
                    <Input
                      id="retrieval-topk"
                      type="number"
                      min={1}
                      max={20}
                      value={testTopK}
                      onChange={(e) => setTestTopK(Number(e.target.value) || 5)}
                    />
                  </div>
                  <Button onClick={() => void runTest()} disabled={testing}>
                    <Search />
                    {testing ? t("searching") : t("runTest")}
                  </Button>
                </div>
                {testDuration !== null && testResults ? (
                  <p className="text-muted-foreground text-xs">
                    {t("hitsSummary", {
                      count: testResults.length,
                      ms: testDuration,
                    })}
                  </p>
                ) : null}
              </CardContent>
            </Card>

            {testResults ? (
              testResults.length === 0 ? (
                <Card className="border-dashed">
                  <CardContent className="text-muted-foreground py-10 text-center text-sm">
                    {t("noHits")}
                  </CardContent>
                </Card>
              ) : (
                <Card>
                  <CardContent className="pt-5">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t("test.colDoc")}</TableHead>
                          <TableHead>{t("test.colSection")}</TableHead>
                          <TableHead className="text-right">
                            {t("test.colScore")}
                          </TableHead>
                          <TableHead>{t("test.colExcerpt")}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {testResults.map((hit, i) => (
                          <TableRow key={`${hit.docId}-${hit.chunkIndex}-${i}`}>
                            <TableCell className="max-w-44">
                              <span className="text-foreground block truncate text-sm font-medium">
                                {hit.docName}
                              </span>
                            </TableCell>
                            <TableCell className="text-muted-foreground max-w-40">
                              <span className="block truncate text-xs">
                                {hit.sectionTitle ??
                                  t("chunk", { index: hit.chunkIndex })}
                              </span>
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs">
                              {hit.score.toFixed(4)}
                            </TableCell>
                            <TableCell className="text-muted-foreground max-w-96">
                              <p className="line-clamp-2 text-xs whitespace-pre-wrap">
                                {hit.excerpt}
                              </p>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              )
            ) : null}

            <Card>
              <CardHeader className="py-3">
                <CardTitle className="flex items-center gap-1.5 text-sm">
                  <History className="text-muted-foreground size-4" />
                  {t("test.history")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {testHistory.length === 0 ? (
                  <p className="text-muted-foreground py-4 text-center text-sm italic">
                    {t("test.historyEmpty")}
                  </p>
                ) : (
                  <div className="space-y-1">
                    {testHistory.map((run) => (
                      <button
                        key={run.id}
                        type="button"
                        title={t("test.historyFill")}
                        onClick={() => setTestQuery(run.query)}
                        className="hover:bg-accent/40 flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left"
                      >
                        <span className="text-foreground min-w-0 flex-1 truncate text-sm">
                          {run.query}
                        </span>
                        <span className="text-muted-foreground shrink-0 text-xs">
                          {t("test.runMeta", {
                            count: run.resultCount,
                            ms: run.durationMs,
                          })}
                        </span>
                        <span className="text-muted-foreground shrink-0 text-xs">
                          {format.dateTime(new Date(run.createdAt), "short")}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="qa" className="mt-4 space-y-4">
            <Card>
              <CardContent className="space-y-3 pt-5">
                <div className="space-y-1.5">
                  <Label htmlFor="qa-question">{t("question")}</Label>
                  <Textarea
                    id="qa-question"
                    rows={3}
                    placeholder={t("questionPlaceholder")}
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                  />
                </div>
                <Button onClick={() => void ask()} disabled={asking}>
                  {asking ? (
                    <Sparkles className="animate-pulse" />
                  ) : (
                    <MessageCircleQuestion />
                  )}
                  {asking ? t("thinking") : t("ask")}
                </Button>
              </CardContent>
            </Card>

            {answer ? (
              <Card>
                <CardHeader className="py-3">
                  <CardTitle className="text-sm">{t("answer")}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <DevflowMarkdown content={answer} />
                  {citations.length > 0 ? (
                    <div className="space-y-2">
                      <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                        {t("sources")}
                      </p>
                      {citations.map((citation) => (
                        <div
                          key={citation.index}
                          className="border-border rounded-md border px-3 py-2"
                        >
                          <div className="flex items-center gap-2 text-xs">
                            <Badge variant="secondary">
                              [{citation.index}]
                            </Badge>
                            <span className="text-foreground font-medium">
                              {citation.docName}
                            </span>
                            <span className="text-muted-foreground ml-auto font-mono">
                              {citation.score.toFixed(4)}
                            </span>
                          </div>
                          <p className="text-muted-foreground mt-1 line-clamp-2 text-xs">
                            {citation.snippet}
                          </p>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            ) : null}
          </TabsContent>

          <TabsContent value="settings" className="mt-4 space-y-4">
            <Card>
              <CardHeader className="py-3">
                <CardTitle className="flex items-center gap-1.5 text-sm">
                  <SlidersHorizontal className="text-muted-foreground size-4" />
                  {t("config.title")}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {config === null ? (
                  <div className="space-y-2">
                    <Skeleton className="h-16 rounded-lg" />
                    <Skeleton className="h-16 rounded-lg" />
                  </div>
                ) : (
                  <>
                    <p className="text-muted-foreground text-xs">
                      {t("config.description")}
                    </p>
                    {!configStored ? (
                      <p className="text-muted-foreground text-xs italic">
                        {t("config.notStored")}
                      </p>
                    ) : null}
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor="kb-method">
                          {t("config.methodLabel")}
                        </Label>
                        <Select
                          value={config.retrievalMethod}
                          onValueChange={(v) => {
                            const next = RETRIEVAL_METHODS.find((m) => m === v);
                            if (next) {
                              setConfig({ ...config, retrievalMethod: next });
                            }
                          }}
                        >
                          <SelectTrigger id="kb-method">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {RETRIEVAL_METHODS.map((method) => (
                              <SelectItem key={method} value={method}>
                                {t(`config.method.${METHOD_KEYS[method]}`)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="kb-topk">{t("topK")}</Label>
                        <Input
                          id="kb-topk"
                          type="number"
                          min={1}
                          max={20}
                          value={config.topK}
                          onChange={(e) =>
                            setConfig({
                              ...config,
                              topK: Number(e.target.value) || config.topK,
                            })
                          }
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="kb-chunk-size">
                          {t("config.chunkSize")}
                        </Label>
                        <Input
                          id="kb-chunk-size"
                          type="number"
                          min={100}
                          max={8000}
                          value={config.chunkSize}
                          onChange={(e) =>
                            setConfig({
                              ...config,
                              chunkSize:
                                Number(e.target.value) || config.chunkSize,
                            })
                          }
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="kb-chunk-overlap">
                          {t("config.chunkOverlap")}
                        </Label>
                        <Input
                          id="kb-chunk-overlap"
                          type="number"
                          min={0}
                          max={4000}
                          value={config.chunkOverlap}
                          onChange={(e) =>
                            setConfig({
                              ...config,
                              chunkOverlap:
                                Number(e.target.value) || config.chunkOverlap,
                            })
                          }
                        />
                      </div>
                    </div>
                    <div className="border-border flex items-center justify-between gap-4 rounded-lg border p-3">
                      <div>
                        <p className="text-foreground text-sm font-medium">
                          {t("config.rerank")}
                        </p>
                        <p className="text-muted-foreground mt-0.5 text-xs">
                          {t("config.rerankHint")}
                        </p>
                      </div>
                      <Switch
                        checked={config.rerankEnabled}
                        onCheckedChange={(checked) =>
                          setConfig({ ...config, rerankEnabled: checked })
                        }
                      />
                    </div>
                    {overlapInvalid ? (
                      <p className="text-destructive text-xs">
                        {t("config.overlapInvalid")}
                      </p>
                    ) : null}
                    <Button
                      onClick={() => void saveConfig()}
                      disabled={configSaving || overlapInvalid}
                    >
                      {configSaving ? (
                        <RefreshCw className="animate-spin" />
                      ) : (
                        <Save />
                      )}
                      {configSaving ? t("config.saving") : t("config.save")}
                    </Button>
                  </>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="py-3">
                <CardTitle className="flex items-center gap-1.5 text-sm">
                  <Database className="text-muted-foreground size-4" />
                  {t("contentIndex.title")}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-muted-foreground text-xs">
                  {t("contentIndex.description")}
                </p>
                {indexError ? (
                  <p className="text-destructive text-xs">{indexError}</p>
                ) : indexCounts ? (
                  <div className="flex flex-wrap gap-2">
                    {CONTENT_TYPE_ORDER.map((type) => (
                      <Badge
                        key={type}
                        variant="secondary"
                        className="gap-1.5 text-xs"
                      >
                        {t(`contentIndex.type.${CONTENT_TYPE_KEYS[type]}`)}
                        <span className="font-mono">{indexCounts[type]}</span>
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <Skeleton className="h-8 w-64 rounded-lg" />
                )}
                {indexCounts &&
                CONTENT_TYPE_ORDER.every((type) => indexCounts[type] === 0) &&
                !indexError ? (
                  <p className="text-muted-foreground text-xs italic">
                    {t("contentIndex.empty")}
                  </p>
                ) : null}
                {indexResult ? (
                  <p className="text-muted-foreground text-xs">
                    {t("contentIndex.result", {
                      items: indexResult.itemCount,
                      chunks: indexResult.chunkCount,
                      ms: indexResult.durationMs,
                    })}
                  </p>
                ) : null}
                <Button
                  variant="outline"
                  onClick={() => void rebuildIndex()}
                  disabled={indexing}
                >
                  {indexing ? (
                    <RefreshCw className="animate-spin" />
                  ) : (
                    <Database />
                  )}
                  {indexing
                    ? t("contentIndex.rebuilding")
                    : t("contentIndex.rebuild")}
                </Button>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      )}

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("deleteTitle", { name: deleteTarget?.name ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tc("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void removeDoc()}>
              {tc("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={previewDoc !== null}
        onOpenChange={(open) => {
          if (!open) setPreviewDoc(null);
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {t("chunksTitle", { name: previewDoc?.name ?? "" })}
            </DialogTitle>
            <DialogDescription>{t("chunksDescription")}</DialogDescription>
          </DialogHeader>
          {previewLoading ? (
            <div className="space-y-2 py-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-16 rounded-lg" />
              ))}
            </div>
          ) : previewChunks.length === 0 ? (
            <p className="text-muted-foreground py-6 text-center text-sm italic">
              {t("noChunks")}
            </p>
          ) : (
            <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
              {previewChunks.map((chunk) => (
                <div
                  key={chunk.id}
                  className="border-border rounded-md border px-3 py-2"
                >
                  <div className="mb-1 flex items-center gap-2 text-xs">
                    <Badge variant="secondary">#{chunk.position}</Badge>
                    <span className="text-foreground truncate font-medium">
                      {chunk.title}
                    </span>
                    <span className="text-muted-foreground ml-auto shrink-0 font-mono">
                      {t("chunkChars", { chars: chunk.characterCount })}
                    </span>
                  </div>
                  <pre className="text-muted-foreground max-h-40 overflow-y-auto text-xs whitespace-pre-wrap">
                    {chunk.content}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={noteOpen}
        onOpenChange={(open) => {
          if (!open) setNoteOpen(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("createNote")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="note-title">{t("noteTitleLabel")}</Label>
              <Input
                id="note-title"
                placeholder={t("noteTitlePlaceholder")}
                value={noteTitle}
                onChange={(e) => setNoteTitle(e.target.value)}
              />
            </div>
            <Textarea
              placeholder={t("noteContentPlaceholder")}
              rows={6}
              value={noteContent}
              onChange={(e) => setNoteContent(e.target.value)}
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setNoteOpen(false)}>
                {tc("cancel")}
              </Button>
              <Button onClick={() => void createNote()} disabled={noteSaving}>
                <Save />
                {t("createNote")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
