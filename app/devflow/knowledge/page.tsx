"use client";

// Knowledge Base: per-repository RAG workspace — upload documents, run
// retrieval tests and ask evidence-grounded questions with citations.
import { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  FileUp,
  MessageCircleQuestion,
  Search,
  Sparkles,
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { notify } from "@/components/devflow/notify";
import PageHeader from "@/components/devflow/page-header";
import DevflowMarkdown from "@/components/devflow/markdown";
import { DocStatusBadge } from "@/components/devflow/badges";
import {
  dfDelete,
  dfGet,
  dfPost,
  dfUpload,
  useDevflow,
} from "@/components/devflow/provider";
import type {
  KnowledgeCitation,
  KnowledgeDoc,
  KnowledgeHit,
} from "@/lib/devflow/types";

export default function DevflowKnowledgePage() {
  const { repoId, repo } = useDevflow();
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeDoc | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Retrieval test state
  const [testQuery, setTestQuery] = useState("");
  const [testTopK, setTestTopK] = useState(5);
  const [testHits, setTestHits] = useState<KnowledgeHit[] | null>(null);
  const [testDuration, setTestDuration] = useState<number | null>(null);
  const [testing, setTesting] = useState(false);

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
      setTestHits(null);
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
            `"${result.existingName ?? file.name}" was already uploaded (identical content) — skipped.`,
          );
        } else {
          notify.success(`Indexed ${file.name} (${result.chunkCount} chunks)`);
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
      notify.success(`Deleted ${deleteTarget.name}`);
      setDeleteTarget(null);
      await loadDocsAfterChange();
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    }
  };

  const runTest = async () => {
    if (!repoId || !testQuery.trim()) return;
    setTesting(true);
    try {
      const result = await dfPost<{
        durationMs: number;
        hits: KnowledgeHit[];
      }>("/knowledge/search", {
        repoId,
        query: testQuery.trim(),
        topK: testTopK,
      });
      setTestHits(result.hits);
      setTestDuration(result.durationMs);
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
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

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <PageHeader
        title="Knowledge Base"
        description={
          repo
            ? `Documents, retrieval tests and evidence-grounded QA for ${repo.fullName}. Vectors live in Milvus (dense + BM25 hybrid).`
            : "Select a repository to manage its knowledge base"
        }
      />

      {!repoId ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-2 py-16 text-center">
            <BookOpen className="text-muted-foreground size-8" />
            <p className="text-muted-foreground text-sm">
              Connect and select a repository first.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Tabs defaultValue="documents">
          <TabsList>
            <TabsTrigger value="documents">
              <Upload className="size-3.5" />
              Documents
            </TabsTrigger>
            <TabsTrigger value="retrieval">
              <Search className="size-3.5" />
              Retrieval test
            </TabsTrigger>
            <TabsTrigger value="qa">
              <MessageCircleQuestion className="size-3.5" />
              Q&A studio
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
                    Drop files here or browse to upload
                  </p>
                  <p className="text-muted-foreground mt-1 text-xs">
                    Markdown, text, JSON, CSV, logs and source files up to 5 MB.
                    Duplicate content is skipped by SHA-256.
                  </p>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => void handleUpload(e.target.files)}
                />
                <Button
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                >
                  <Upload />
                  {uploading ? "Indexing…" : "Upload documents"}
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="py-3">
                <CardTitle className="text-sm">
                  Documents{" "}
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
                    No documents yet — weekly reports also land here
                    automatically.
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
                            {doc.sourceType.replaceAll("_", " ")} ·{" "}
                            {doc.charCount.toLocaleString()} chars ·{" "}
                            {doc.chunkCount} chunks ·{" "}
                            {new Date(doc.createdAt).toLocaleDateString()}
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
                    <Label htmlFor="retrieval-query">Query</Label>
                    <Input
                      id="retrieval-query"
                      placeholder="What should retrieval find?"
                      value={testQuery}
                      onChange={(e) => setTestQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void runTest();
                      }}
                    />
                  </div>
                  <div className="w-24 space-y-1.5">
                    <Label htmlFor="retrieval-topk">Top K</Label>
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
                    {testing ? "Searching…" : "Run test"}
                  </Button>
                </div>
                {testDuration !== null && testHits ? (
                  <p className="text-muted-foreground text-xs">
                    {testHits.length} hits in {testDuration} ms — scores are RRF
                    fusion values (higher is better, relative ordering matters).
                  </p>
                ) : null}
              </CardContent>
            </Card>

            {testHits ? (
              <div className="space-y-3">
                {testHits.length === 0 ? (
                  <Card className="border-dashed">
                    <CardContent className="text-muted-foreground py-10 text-center text-sm">
                      No hits — try a different query or upload more documents.
                    </CardContent>
                  </Card>
                ) : (
                  testHits.map((hit, i) => (
                    <Card key={i}>
                      <CardContent className="space-y-2 pt-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="secondary">#{i + 1}</Badge>
                          <span className="text-foreground text-sm font-medium">
                            {hit.docName}
                          </span>
                          <span className="text-muted-foreground text-xs">
                            chunk {hit.chunkIndex}
                          </span>
                          <Badge
                            variant="outline"
                            className="ml-auto font-mono"
                          >
                            {hit.score.toFixed(4)}
                          </Badge>
                        </div>
                        <p className="text-muted-foreground line-clamp-4 text-xs leading-relaxed whitespace-pre-wrap">
                          {hit.content}
                        </p>
                      </CardContent>
                    </Card>
                  ))
                )}
              </div>
            ) : null}
          </TabsContent>

          <TabsContent value="qa" className="mt-4 space-y-4">
            <Card>
              <CardContent className="space-y-3 pt-5">
                <div className="space-y-1.5">
                  <Label htmlFor="qa-question">Question</Label>
                  <Textarea
                    id="qa-question"
                    rows={3}
                    placeholder="Ask anything about this repository's knowledge base…"
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
                  {asking ? "Thinking…" : "Ask"}
                </Button>
              </CardContent>
            </Card>

            {answer ? (
              <Card>
                <CardHeader className="py-3">
                  <CardTitle className="text-sm">Answer</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <DevflowMarkdown content={answer} />
                  {citations.length > 0 ? (
                    <div className="space-y-2">
                      <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                        Sources
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
            <AlertDialogTitle>Delete {deleteTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The document and all of its vector chunks will be removed from the
              knowledge base.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void removeDoc()}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
