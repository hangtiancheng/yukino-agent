"use client";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import {
  Blocks,
  BookMarked,
  Pencil,
  Plug,
  Settings2,
  Trash2,
  Upload,
} from "lucide-react";
import { z } from "zod/v4";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

const TOKEN_STORAGE_KEY = "yukino_oncall_admin_token";

const promptSchema = z.object({
  id: z.string(),
  name: z.string(),
  content: z.string(),
  enabled: z.boolean(),
});
const promptsResponseSchema = z.object({
  message: z.string(),
  data: z.object({ items: z.array(promptSchema) }).nullish(),
});

const skillSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  enabled: z.boolean(),
});
const skillsResponseSchema = z.object({
  message: z.string(),
  data: z.object({ items: z.array(skillSchema) }).nullish(),
});

const mcpConnectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  transport: z.string(),
  url: z.string(),
  enabled: z.boolean(),
  lastCheckStatus: z.string(),
  lastCheckMessage: z.string().nullish(),
  lastToolNames: z.array(z.string()).default([]),
});
const mcpResponseSchema = z.object({
  message: z.string(),
  data: z.array(mcpConnectionSchema).nullish(),
});

type Prompt = z.infer<typeof promptSchema>;
type Skill = z.infer<typeof skillSchema>;
type McpConnection = z.infer<typeof mcpConnectionSchema>;

export function OncallSettings() {
  const t = useTranslations("oncallSettings");
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [tab, setTab] = useState<"prompts" | "skills" | "mcp">("prompts");
  const [reloadKey, setReloadKey] = useState(0);

  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [connections, setConnections] = useState<McpConnection[]>([]);
  const [loading, setLoading] = useState(false);

  const [promptName, setPromptName] = useState("");
  const [promptContent, setPromptContent] = useState("");
  const [editingPromptId, setEditingPromptId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [mcpName, setMcpName] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [mcpTransport, setMcpTransport] = useState<"sse" | "http">("sse");
  const [mcpHeaders, setMcpHeaders] = useState("");
  const [checkingId, setCheckingId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const [promptsResp, skillsResp, mcpResp] = await Promise.all([
          fetch("/api/prompts"),
          fetch("/api/skills"),
          fetch("/api/mcp_connections"),
        ]);
        const parsedPrompts = promptsResponseSchema.safeParse(
          await promptsResp.json(),
        );
        const parsedSkills = skillsResponseSchema.safeParse(
          await skillsResp.json(),
        );
        const parsedMcp = mcpResponseSchema.safeParse(await mcpResp.json());
        if (cancelled) return;
        setPrompts(
          parsedPrompts.success ? (parsedPrompts.data.data?.items ?? []) : [],
        );
        setSkills(
          parsedSkills.success ? (parsedSkills.data.data?.items ?? []) : [],
        );
        setConnections(parsedMcp.success ? (parsedMcp.data.data ?? []) : []);
      } catch {
        if (!cancelled) {
          setPrompts([]);
          setSkills([]);
          setConnections([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, reloadKey]);

  const persistToken = useCallback((value: string) => {
    setToken(value);
    try {
      localStorage.setItem(TOKEN_STORAGE_KEY, value);
    } catch {}
  }, []);

  const adminHeaders = useCallback(
    (): HeadersInit => ({
      "Content-Type": "application/json",
      "x-admin-token": token,
    }),
    [token],
  );

  const notifyError = useCallback(async (resp: Response, fallback: string) => {
    let message = fallback;
    try {
      const json = (await resp.json()) as { message?: string };
      if (json.message) message = json.message;
    } catch {}
    toast.add({ title: message, type: "error", timeout: 4000 });
  }, []);

  const submitPrompt = useCallback(async () => {
    if (promptName.trim() === "" || busy) return;
    setBusy(true);
    try {
      const resp =
        editingPromptId === null
          ? await fetch("/api/prompts", {
              method: "POST",
              headers: adminHeaders(),
              body: JSON.stringify({
                name: promptName.trim(),
                content: promptContent,
              }),
            })
          : await fetch(`/api/prompts/${editingPromptId}`, {
              method: "PATCH",
              headers: adminHeaders(),
              body: JSON.stringify({
                name: promptName.trim(),
                content: promptContent,
              }),
            });
      if (!resp.ok) {
        await notifyError(resp, t("saveFailed"));
        return;
      }
      setPromptName("");
      setPromptContent("");
      setEditingPromptId(null);
      setReloadKey((k) => k + 1);
      toast.add({ title: t("saved"), type: "success", timeout: 2500 });
    } finally {
      setBusy(false);
    }
  }, [
    promptName,
    promptContent,
    editingPromptId,
    busy,
    adminHeaders,
    notifyError,
    t,
  ]);

  const togglePrompt = useCallback(
    async (prompt: Prompt, enabled: boolean) => {
      const resp = await fetch(`/api/prompts/${prompt.id}`, {
        method: "PATCH",
        headers: adminHeaders(),
        body: JSON.stringify({ enabled }),
      });
      if (!resp.ok) {
        await notifyError(resp, t("saveFailed"));
        return;
      }
      setReloadKey((k) => k + 1);
    },
    [adminHeaders, notifyError, t],
  );

  const deletePrompt = useCallback(
    async (id: string) => {
      const resp = await fetch(`/api/prompts/${id}`, {
        method: "DELETE",
        headers: adminHeaders(),
      });
      if (!resp.ok) {
        await notifyError(resp, t("deleteFailed"));
        return;
      }
      setReloadKey((k) => k + 1);
    },
    [adminHeaders, notifyError, t],
  );

  const uploadSkill = useCallback(
    async (file: File) => {
      const content = await file.text();
      const resp = await fetch("/api/skills", {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({ fileName: file.name, content }),
      });
      if (!resp.ok) {
        await notifyError(resp, t("saveFailed"));
        return;
      }
      setReloadKey((k) => k + 1);
      toast.add({ title: t("saved"), type: "success", timeout: 2500 });
    },
    [adminHeaders, notifyError, t],
  );

  const toggleSkill = useCallback(
    async (skill: Skill, enabled: boolean) => {
      const resp = await fetch(`/api/skills/${skill.id}`, {
        method: "PATCH",
        headers: adminHeaders(),
        body: JSON.stringify({ enabled }),
      });
      if (!resp.ok) {
        await notifyError(resp, t("saveFailed"));
        return;
      }
      setReloadKey((k) => k + 1);
    },
    [adminHeaders, notifyError, t],
  );

  const deleteSkill = useCallback(
    async (id: string) => {
      const resp = await fetch(`/api/skills/${id}`, {
        method: "DELETE",
        headers: adminHeaders(),
      });
      if (!resp.ok) {
        await notifyError(resp, t("deleteFailed"));
        return;
      }
      setReloadKey((k) => k + 1);
    },
    [adminHeaders, notifyError, t],
  );

  const submitMcp = useCallback(async () => {
    if (mcpName.trim() === "" || mcpUrl.trim() === "" || busy) return;
    const headers: Record<string, string> = {};
    if (mcpHeaders.trim() !== "") {
      try {
        const parsed: unknown = JSON.parse(mcpHeaders);
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          toast.add({
            title: t("mcpHeadersInvalid"),
            type: "error",
            timeout: 4000,
          });
          return;
        }
        for (const [key, value] of Object.entries(
          parsed as Record<string, unknown>,
        )) {
          if (typeof value === "string") headers[key] = value;
        }
      } catch {
        toast.add({
          title: t("mcpHeadersInvalid"),
          type: "error",
          timeout: 4000,
        });
        return;
      }
    }
    setBusy(true);
    try {
      const resp = await fetch("/api/mcp_connections", {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({
          name: mcpName.trim(),
          transport: mcpTransport,
          url: mcpUrl.trim(),
          headers,
        }),
      });
      if (!resp.ok) {
        await notifyError(resp, t("saveFailed"));
        return;
      }
      setMcpName("");
      setMcpUrl("");
      setMcpHeaders("");
      setReloadKey((k) => k + 1);
      toast.add({ title: t("saved"), type: "success", timeout: 2500 });
    } finally {
      setBusy(false);
    }
  }, [
    mcpName,
    mcpUrl,
    mcpTransport,
    mcpHeaders,
    busy,
    adminHeaders,
    notifyError,
    t,
  ]);

  const toggleMcp = useCallback(
    async (connection: McpConnection, enabled: boolean) => {
      const resp = await fetch(`/api/mcp_connections/${connection.id}`, {
        method: "PATCH",
        headers: adminHeaders(),
        body: JSON.stringify({ enabled }),
      });
      if (!resp.ok) {
        await notifyError(resp, t("saveFailed"));
        return;
      }
      setReloadKey((k) => k + 1);
    },
    [adminHeaders, notifyError, t],
  );

  const deleteMcp = useCallback(
    async (id: string) => {
      const resp = await fetch(`/api/mcp_connections/${id}`, {
        method: "DELETE",
        headers: adminHeaders(),
      });
      if (!resp.ok) {
        await notifyError(resp, t("deleteFailed"));
        return;
      }
      setReloadKey((k) => k + 1);
    },
    [adminHeaders, notifyError, t],
  );

  const checkMcp = useCallback(
    async (id: string) => {
      setCheckingId(id);
      try {
        const resp = await fetch(`/api/mcp_connections/${id}/check`, {
          method: "POST",
          headers: adminHeaders(),
        });
        const json = (await resp.json().catch(() => null)) as {
          message?: string;
          data?: { ok?: boolean; message?: string; toolNames?: string[] };
        } | null;
        if (json?.data) {
          const okCheck = json.data.ok === true;
          toast.add({
            title: okCheck
              ? t("mcpCheckOk", { count: json.data.toolNames?.length ?? 0 })
              : t("mcpCheckFailedWith", {
                  error: json.data.message ?? json.message ?? "",
                }),
            type: okCheck ? "success" : "error",
            timeout: 4000,
          });
        } else {
          await notifyError(resp, t("mcpCheckFailed"));
        }
        setReloadKey((k) => k + 1);
      } finally {
        setCheckingId(null);
      }
    },
    [adminHeaders, notifyError, t],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          try {
            setToken(localStorage.getItem(TOKEN_STORAGE_KEY) ?? "");
          } catch {}
        }
      }}
    >
      <DialogTrigger
        render={
          <Button
            size="icon"
            variant="outline"
            className="bg-background/80 shadow-sm backdrop-blur-sm"
            title={t("title")}
          >
            <Settings2 className="size-4" />
          </Button>
        }
      />
      <DialogContent className="max-h-[80svh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-sm">{t("title")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <label
            className="text-muted-foreground text-xs"
            htmlFor="admin-token"
          >
            {t("adminToken")}
          </label>
          <Input
            id="admin-token"
            type="password"
            value={token}
            onChange={(e) => persistToken(e.target.value)}
            placeholder={t("adminTokenPlaceholder")}
            className="h-8 text-xs"
          />
          <p className="text-muted-foreground text-[11px]">
            {t("adminTokenHint")}
          </p>
        </div>
        <Tabs
          value={tab}
          onValueChange={(value) => {
            if (value === "prompts" || value === "skills" || value === "mcp") {
              setTab(value);
            }
          }}
        >
          <TabsList className="w-full">
            <TabsTrigger value="prompts" className="flex-1 gap-1 text-xs">
              <BookMarked className="size-3.5" />
              {t("promptsTab")}
            </TabsTrigger>
            <TabsTrigger value="skills" className="flex-1 gap-1 text-xs">
              <Blocks className="size-3.5" />
              {t("skillsTab")}
            </TabsTrigger>
            <TabsTrigger value="mcp" className="flex-1 gap-1 text-xs">
              <Plug className="size-3.5" />
              {t("mcpTab")}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="prompts" className="flex flex-col gap-2 pt-2">
            <div className="flex flex-col gap-1.5 rounded-lg border p-2">
              <div className="flex items-center gap-1.5">
                <Input
                  value={promptName}
                  onChange={(e) => setPromptName(e.target.value)}
                  placeholder={t("promptNamePlaceholder")}
                  className="h-8 text-xs"
                />
                {editingPromptId !== null && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 shrink-0 text-xs"
                    onClick={() => {
                      setEditingPromptId(null);
                      setPromptName("");
                      setPromptContent("");
                    }}
                  >
                    {t("cancelEdit")}
                  </Button>
                )}
              </div>
              <Textarea
                value={promptContent}
                onChange={(e) => setPromptContent(e.target.value)}
                placeholder={t("promptContentPlaceholder")}
                rows={4}
                className="resize-y text-xs"
              />
              <div className="flex justify-end">
                <Button
                  size="sm"
                  className="h-7 gap-1 text-xs"
                  disabled={busy || promptName.trim() === ""}
                  onClick={() => void submitPrompt()}
                >
                  {editingPromptId === null ? t("create") : t("update")}
                </Button>
              </div>
            </div>
            {loading ? (
              <div className="flex justify-center py-4">
                <Spinner className="size-4" />
              </div>
            ) : prompts.length === 0 ? (
              <p className="text-muted-foreground py-3 text-center text-xs">
                {t("promptsEmpty")}
              </p>
            ) : (
              prompts.map((prompt) => (
                <div
                  key={prompt.id}
                  className="flex items-start justify-between gap-2 rounded-lg border px-2.5 py-2"
                >
                  <div className="min-w-0">
                    <div className="text-foreground truncate text-xs font-medium">
                      {prompt.name}
                    </div>
                    <div className="text-muted-foreground mt-0.5 line-clamp-2 text-[11px]">
                      {prompt.content}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Switch
                      checked={prompt.enabled}
                      onCheckedChange={(checked) =>
                        void togglePrompt(prompt, checked)
                      }
                      className="scale-75"
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-6"
                      title={t("edit")}
                      onClick={() => {
                        setEditingPromptId(prompt.id);
                        setPromptName(prompt.name);
                        setPromptContent(prompt.content);
                      }}
                    >
                      <Pencil className="size-3" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="text-destructive size-6"
                      title={t("delete")}
                      onClick={() => void deletePrompt(prompt.id)}
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  </div>
                </div>
              ))
            )}
          </TabsContent>

          <TabsContent value="skills" className="flex flex-col gap-2 pt-2">
            <label className="flex w-fit cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs">
              <Upload className="size-3.5" />
              {t("uploadSkill")}
              <input
                type="file"
                accept=".md,.markdown"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void uploadSkill(file);
                }}
              />
            </label>
            {loading ? (
              <div className="flex justify-center py-4">
                <Spinner className="size-4" />
              </div>
            ) : skills.length === 0 ? (
              <p className="text-muted-foreground py-3 text-center text-xs">
                {t("skillsEmpty")}
              </p>
            ) : (
              skills.map((skill) => (
                <div
                  key={skill.id}
                  className="flex items-start justify-between gap-2 rounded-lg border px-2.5 py-2"
                >
                  <div className="min-w-0">
                    <div className="text-foreground truncate text-xs font-medium">
                      {skill.name}
                    </div>
                    <div className="text-muted-foreground mt-0.5 line-clamp-2 text-[11px]">
                      {skill.description}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Switch
                      checked={skill.enabled}
                      onCheckedChange={(checked) =>
                        void toggleSkill(skill, checked)
                      }
                      className="scale-75"
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      className="text-destructive size-6"
                      title={t("delete")}
                      onClick={() => void deleteSkill(skill.id)}
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  </div>
                </div>
              ))
            )}
          </TabsContent>

          <TabsContent value="mcp" className="flex flex-col gap-2 pt-2">
            <div className="flex flex-col gap-1.5 rounded-lg border p-2">
              <div className="flex items-center gap-1.5">
                <Input
                  value={mcpName}
                  onChange={(e) => setMcpName(e.target.value)}
                  placeholder={t("mcpNamePlaceholder")}
                  className="h-8 text-xs"
                />
                <select
                  value={mcpTransport}
                  onChange={(e) =>
                    setMcpTransport(e.target.value === "http" ? "http" : "sse")
                  }
                  className={cn(
                    "border-border bg-background text-muted-foreground h-8 shrink-0 rounded-md border px-2 text-xs",
                  )}
                >
                  <option value="sse">SSE</option>
                  <option value="http">Streamable HTTP</option>
                </select>
              </div>
              <Input
                value={mcpUrl}
                onChange={(e) => setMcpUrl(e.target.value)}
                placeholder={t("mcpUrlPlaceholder")}
                className="h-8 text-xs"
              />
              <Input
                value={mcpHeaders}
                onChange={(e) => setMcpHeaders(e.target.value)}
                placeholder={t("mcpHeadersPlaceholder")}
                className="h-8 text-xs"
              />
              <div className="flex justify-end">
                <Button
                  size="sm"
                  className="h-7 text-xs"
                  disabled={
                    busy || mcpName.trim() === "" || mcpUrl.trim() === ""
                  }
                  onClick={() => void submitMcp()}
                >
                  {t("create")}
                </Button>
              </div>
            </div>
            {loading ? (
              <div className="flex justify-center py-4">
                <Spinner className="size-4" />
              </div>
            ) : connections.length === 0 ? (
              <p className="text-muted-foreground py-3 text-center text-xs">
                {t("mcpEmpty")}
              </p>
            ) : (
              connections.map((connection) => (
                <div
                  key={connection.id}
                  className="flex items-start justify-between gap-2 rounded-lg border px-2.5 py-2"
                >
                  <div className="min-w-0">
                    <div className="text-foreground flex items-center gap-1.5 truncate text-xs font-medium">
                      {connection.name}
                      <Badge
                        variant="outline"
                        className="px-1 py-0 text-[10px]"
                      >
                        {connection.transport}
                      </Badge>
                      <Badge
                        variant="outline"
                        className={cn(
                          "px-1 py-0 text-[10px]",
                          connection.lastCheckStatus === "ok"
                            ? "text-emerald-600"
                            : "text-amber-600",
                        )}
                      >
                        {connection.lastCheckStatus}
                      </Badge>
                    </div>
                    <div className="text-muted-foreground mt-0.5 truncate text-[11px]">
                      {connection.url}
                    </div>
                    {connection.lastToolNames.length > 0 && (
                      <div className="text-muted-foreground mt-0.5 truncate text-[11px]">
                        {t("mcpTools")}: {connection.lastToolNames.join(", ")}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Switch
                      checked={connection.enabled}
                      onCheckedChange={(checked) =>
                        void toggleMcp(connection, checked)
                      }
                      className="scale-75"
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-1.5 text-[11px]"
                      disabled={checkingId === connection.id}
                      onClick={() => void checkMcp(connection.id)}
                    >
                      {checkingId === connection.id ? (
                        <Spinner className="size-3" />
                      ) : (
                        t("mcpCheck")
                      )}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="text-destructive size-6"
                      title={t("delete")}
                      onClick={() => void deleteMcp(connection.id)}
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  </div>
                </div>
              ))
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
