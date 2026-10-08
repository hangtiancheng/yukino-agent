"use client";

// OnCall knowledge-base management page (port of the legacy agent_py
// knowledge documents workspace: list / chunk preview / re-index / delete /
// upload). Reads are public; mutations send the admin token entered here
// (ONCALL_ADMIN_TOKEN) as an x-admin-token header and fail closed without it.
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations, useFormatter } from "next-intl";
import { z } from "zod/v4";
import { BookOpen, Eye, RefreshCw, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { notify } from "@/components/devflow/notify";
import Dock from "@/components/dock";

const listSchema = z.object({
  message: z.string(),
  data: z
    .object({
      items: z.array(
        z.object({
          name: z.string(),
          bytes: z.number(),
          updatedAt: z.string().nullable(),
          knowledgeType: z.string(),
          chunks: z.number().nullable(),
        }),
      ),
    })
    .nullish(),
});
type DocItem = NonNullable<z.infer<typeof listSchema>["data"]>["items"][number];

const previewSchema = z.object({
  message: z.string(),
  data: z
    .object({
      name: z.string(),
      total: z.number(),
      chunks: z.array(z.object({ content: z.string(), title: z.string() })),
    })
    .nullish(),
});

const TYPE_LABEL_KEYS = {
  sop: "sop",
  document: "document",
  "diagnostic-case": "diagnosticCase",
} as const;

function isTypeKey(value: string): value is keyof typeof TYPE_LABEL_KEYS {
  return value in TYPE_LABEL_KEYS;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function KnowledgePage() {
  const t = useTranslations("knowledge");
  const tc = useTranslations("common");
  const format = useFormatter();
  const [docs, setDocs] = useState<DocItem[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [adminToken, setAdminToken] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const [previewName, setPreviewName] = useState<string | null>(null);
  const [preview, setPreview] =
    useState<z.infer<typeof previewSchema>["data"]>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<DocItem | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const resp = await fetch("/api/knowledge_docs");
        const parsed = listSchema.safeParse(await resp.json());
        if (!cancelled)
          setDocs(parsed.success ? (parsed.data.data?.items ?? []) : []);
      } catch {
        if (!cancelled) setDocs([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const adminHeaders = useCallback(
    () => ({ "x-admin-token": adminToken.trim() }),
    [adminToken],
  );

  const openPreview = useCallback(async (name: string) => {
    setPreviewName(name);
    setPreview(null);
    setPreviewLoading(true);
    try {
      const resp = await fetch(
        `/api/knowledge_docs/${encodeURIComponent(name)}`,
      );
      const parsed = previewSchema.safeParse(await resp.json());
      setPreview(parsed.success ? (parsed.data.data ?? null) : null);
    } catch {
      setPreview(null);
    } finally {
      setPreviewLoading(false);
    }
  }, []);

  const reindex = useCallback(
    async (name: string) => {
      setBusy(name);
      try {
        const resp = await fetch(
          `/api/knowledge_docs/${encodeURIComponent(name)}`,
          { method: "POST", headers: adminHeaders() },
        );
        const parsed = z
          .object({
            message: z.string(),
            data: z.object({ chunks: z.number() }).nullish(),
          })
          .safeParse(await resp.json());
        if (resp.ok && parsed.success) {
          notify.success(
            t("reindexed", { name, chunks: parsed.data.data?.chunks ?? 0 }),
          );
          setReloadKey((k) => k + 1);
        } else {
          notify.error(
            parsed.success ? parsed.data.message : String(resp.status),
          );
        }
      } catch (e) {
        notify.error(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [adminHeaders, t],
  );

  const removeDoc = useCallback(
    async (item: DocItem) => {
      setBusy(item.name);
      try {
        const resp = await fetch(
          `/api/knowledge_docs/${encodeURIComponent(item.name)}`,
          { method: "DELETE", headers: adminHeaders() },
        );
        const parsed = z
          .object({ message: z.string() })
          .safeParse(await resp.json());
        if (resp.ok) {
          notify.success(t("deleted", { name: item.name }));
          setReloadKey((k) => k + 1);
        } else {
          notify.error(
            parsed.success ? parsed.data.message : String(resp.status),
          );
        }
      } catch (e) {
        notify.error(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
        setDeleteTarget(null);
      }
    },
    [adminHeaders, t],
  );

  const upload = useCallback(
    async (file: File) => {
      setBusy(file.name);
      try {
        const form = new FormData();
        form.append("file", file);
        const resp = await fetch("/api/upload", { method: "POST", body: form });
        const parsed = z
          .object({
            message: z.string(),
            data: z.object({ name: z.string() }).nullish(),
          })
          .safeParse(await resp.json());
        if (resp.ok && parsed.success) {
          notify.success(
            t("uploaded", { name: parsed.data.data?.name ?? file.name }),
          );
          setReloadKey((k) => k + 1);
        } else {
          notify.error(
            parsed.success ? parsed.data.message : String(resp.status),
          );
        }
      } catch (e) {
        notify.error(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [t],
  );

  return (
    <div className="bg-background text-foreground min-h-svh pb-28">
      <main className="mx-auto w-full max-w-4xl px-4 py-8">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              <BookOpen className="text-primary size-5" />
              {t("title")}
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">
              {t("subtitle")}
            </p>
          </div>
          <div className="shrink-0">
            <input
              ref={fileInputRef}
              type="file"
              accept=".md,.markdown,.txt,.pdf,.docx"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void upload(file);
                e.target.value = "";
              }}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
            >
              <span className="flex items-center gap-1.5">
                <Upload className="size-3.5" />
                {t("upload")}
              </span>
            </Button>
          </div>
        </div>

        <Card className="mb-4">
          <CardContent className="flex items-center gap-3 py-3">
            <div className="min-w-0 flex-1">
              <label className="text-muted-foreground mb-1 block text-xs">
                {t("adminToken")}
              </label>
              <Input
                type="password"
                value={adminToken}
                onChange={(e) => setAdminToken(e.target.value)}
                placeholder="••••••••"
                autoComplete="off"
              />
            </div>
          </CardContent>
        </Card>
        <p className="text-muted-foreground mb-4 text-xs">
          {t("adminTokenHint")}
        </p>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t("title")}</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex justify-center py-8">
                <Spinner className="size-5" />
              </div>
            ) : docs.length === 0 ? (
              <p className="text-muted-foreground py-8 text-center text-sm">
                {t("empty")}
              </p>
            ) : (
              <div className="divide-y">
                {docs.map((doc) => (
                  <div
                    key={doc.name}
                    className="flex items-center gap-3 py-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">
                        {doc.name}
                      </div>
                      <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-2 text-xs">
                        <Badge variant="outline" className="text-[10px]">
                          {isTypeKey(doc.knowledgeType)
                            ? t(
                                `typeLabels.${TYPE_LABEL_KEYS[doc.knowledgeType]}`,
                              )
                            : doc.knowledgeType}
                        </Badge>
                        <span>{formatBytes(doc.bytes)}</span>
                        {doc.updatedAt && (
                          <span>
                            {format.dateTime(new Date(doc.updatedAt), "short")}
                          </span>
                        )}
                        <span>
                          {doc.chunks === null
                            ? t("chunkCountUnknown")
                            : `${t("chunks")}: ${doc.chunks}`}
                        </span>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-7"
                        title={t("preview")}
                        onClick={() => void openPreview(doc.name)}
                      >
                        <Eye className="size-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-7"
                        title={t("reindex")}
                        disabled={busy !== null}
                        onClick={() => void reindex(doc.name)}
                      >
                        {busy === doc.name ? (
                          <RefreshCw className="size-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="size-3.5" />
                        )}
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="text-destructive size-7"
                        title={t("delete")}
                        disabled={busy !== null}
                        onClick={() => setDeleteTarget(doc)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </main>

      <Dialog
        open={previewName !== null}
        onOpenChange={(open) => {
          if (!open) setPreviewName(null);
        }}
      >
        <DialogContent className="max-h-[80svh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="truncate text-sm">
              {previewName}
            </DialogTitle>
          </DialogHeader>
          {previewLoading ? (
            <div className="flex justify-center py-8">
              <Spinner className="size-5" />
            </div>
          ) : preview == null ? (
            <p className="text-muted-foreground py-6 text-center text-sm">
              {t("empty")}
            </p>
          ) : (
            <div className="space-y-3">
              <p className="text-muted-foreground text-xs">
                {t("totalChunks", { total: preview.total })}
              </p>
              {preview.chunks.map((chunk, i) => (
                <div key={i} className="rounded-lg border p-3">
                  {chunk.title !== "" && (
                    <div className="text-foreground mb-1 text-xs font-medium">
                      {chunk.title}
                    </div>
                  )}
                  <pre className="text-muted-foreground max-h-40 overflow-y-auto text-xs whitespace-pre-wrap">
                    {chunk.content}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("delete")}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget
                ? t("deleteConfirm", { name: deleteTarget.name })
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tc("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteTarget) void removeDoc(deleteTarget);
              }}
            >
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dock />
    </div>
  );
}
