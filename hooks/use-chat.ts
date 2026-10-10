"use client";
import { useState, useCallback, useEffect, useMemo } from "react";
import { z } from "zod/v4";
import type { A2uiClientAction } from "@a2ui/web_core/v0_9";
import {
  a2uiActionResponseSchema,
  chatReferenceSchema,
  chatResponseSchema,
  aiOpsResponseSchema,
  uploadResponseSchema,
} from "@/lib/schemas";
import type { KnowledgeType } from "@/lib/ai/pipelines/knowledge-index";
import { toast } from "@/components/ui/toast";
import { useTranslations } from "next-intl";

export type Mode = "quick" | "stream";

export interface ChatReference {
  title: string;
  source: string;
  score: number;
  excerpt: string;
  knowledgeType?: KnowledgeType;
}

export interface ChatToolCall {
  id: string;
  name: string;
  state: "call" | "result" | "error";
}

export interface ChatMessage {
  type: "user" | "assistant";
  content: string;
  detail?: string[];
  a2ui?: unknown[];
  references?: ChatReference[];
  reasoning?: string;
  toolCalls?: ChatToolCall[];
  pending?: boolean;
}

export interface ChatHistory {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface AIOpsResult {
  result: string;
  detail: string[];
  a2ui?: unknown[];
}

export type NotificationType = "info" | "success" | "warning" | "error";

interface OverlayState {
  show: boolean;
  text: string;
  subtext: string;
}

const MAX_HISTORIES = 50;
const STORAGE_KEY = "yukino-agent-chat-histories";

const chatMessageSchema = z.object({
  type: z.enum(["user", "assistant"]),
  content: z.string(),
  detail: z.array(z.string()).optional(),
  a2ui: z.array(z.unknown()).optional(),
  references: z.array(chatReferenceSchema).optional(),
  reasoning: z.string().optional(),
  toolCalls: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        state: z.enum(["call", "result", "error"]),
      }),
    )
    .optional(),
});

const chatHistorySchema = z.object({
  id: z.string(),
  title: z.string(),
  messages: z.array(chatMessageSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const chatHistoriesSchema = z.array(chatHistorySchema);

const chatReferenceExtSchema = chatReferenceSchema.extend({
  knowledgeType: z.enum(["sop", "document", "diagnostic-case"]).optional(),
});
const chatResponseExtSchema = chatResponseSchema.extend({
  data: chatResponseSchema.shape.data
    .unwrap()
    .extend({
      reasoning: z.string().optional(),
      references: z.array(chatReferenceExtSchema).optional(),
    })
    .optional(),
});

const toolEventSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.enum(["call", "result", "error"]),
});

function generateSessionId(): string {
  return "session_" + crypto.randomUUID();
}

function loadHistories(): ChatHistory[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];
    const parsed = chatHistoriesSchema.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

function deriveTitle(messages: ChatMessage[], fallbackTitle: string): string {
  const firstUser = messages.find((m) => m.type === "user");
  if (!firstUser) return fallbackTitle;
  const c = firstUser.content;
  return c.slice(0, 30) + (c.length > 30 ? "..." : "");
}

export function useChat() {
  const t = useTranslations("chat");
  const tCommon = useTranslations("common");
  const [mode, setMode] = useState<Mode>("quick");
  const [sessionId, setSessionId] = useState<string>("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [histories, setHistories] = useState<ChatHistory[]>([]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount-once init for client-only state after hydration
    setSessionId(generateSessionId());
    setHistories(loadHistories());
  }, []);

  const [streamController, setStreamController] =
    useState<AbortController | null>(null);
  useEffect(() => {
    if (!streamController) return;
    return () => streamController.abort();
  }, [streamController]);

  const [overlay, setOverlay] = useState<OverlayState>({
    show: false,
    text: "",
    subtext: "",
  });

  const showNotification = useCallback(
    (message: string, type: NotificationType = "info") => {
      toast.add({ title: message, type, timeout: 3000 });
    },
    [],
  );

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(histories));
    } catch {}
  }, [histories]);

  const upsertHistory = useCallback(
    (sid: string, msgs: ChatMessage[]) => {
      if (msgs.length === 0) return;
      setHistories((prev) => {
        const title = deriveTitle(msgs, t("newChat"));
        const now = new Date().toISOString();
        const idx = prev.findIndex((h) => h.id === sid);
        if (idx !== -1) {
          const updated = [...prev];
          updated[idx] = {
            ...updated[idx],
            messages: msgs,
            title,
            updatedAt: now,
          };
          return updated;
        }
        return [
          { id: sid, title, messages: msgs, createdAt: now, updatedAt: now },
          ...prev,
        ].slice(0, MAX_HISTORIES);
      });
    },
    [t],
  );

  const newChat = useCallback(() => {
    if (isStreaming) {
      showNotification(t("notifications.waitForChat"), "warning");
      return;
    }
    setMessages([]);
    setSessionId(generateSessionId());
  }, [isStreaming, showNotification, t]);

  const loadChatHistory = useCallback(
    (id: string) => {
      const h = histories.find((x) => x.id === id);
      if (!h) return;
      setSessionId(h.id);
      setMessages(h.messages);
    },
    [histories],
  );

  const deleteChatHistory = useCallback(
    (id: string) => {
      setHistories((prev) => prev.filter((h) => h.id !== id));
      if (sessionId === id) {
        setMessages([]);
        setSessionId(generateSessionId());
      }
    },
    [sessionId],
  );

  const sendMessage = useCallback(
    async (text: string) => {
      if (!text || isStreaming) return;

      let currentMsgs: ChatMessage[] = [
        ...messages,
        { type: "user", content: text },
      ];
      setMessages(currentMsgs);
      setIsStreaming(true);

      const controller = new AbortController();
      setStreamController(controller);

      try {
        if (mode === "quick") {
          currentMsgs = [
            ...currentMsgs,
            { type: "assistant", content: "", pending: true },
          ];
          setMessages(currentMsgs);
          const resp = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: sessionId, question: text }),
            signal: controller.signal,
          });
          const parsed = chatResponseExtSchema.safeParse(await resp.json());
          if (!parsed.success) throw new Error(t("errors.invalidChatResponse"));
          const answer = parsed.data.data?.answer;
          const a2ui = parsed.data.data?.a2ui;
          const references = parsed.data.data?.references;
          const reasoning = parsed.data.data?.reasoning;
          if (parsed.data.message === "OK" && answer) {
            currentMsgs = [
              ...currentMsgs.slice(0, -1),
              {
                type: "assistant",
                content: answer,
                ...(a2ui && a2ui.length > 0 ? { a2ui } : {}),
                ...(references && references.length > 0 ? { references } : {}),
                ...(reasoning ? { reasoning } : {}),
              },
            ];
            setMessages(currentMsgs);
          } else {
            throw new Error(parsed.data.message || tCommon("unknownError"));
          }
        } else {
          const resp = await fetch("/api/chat_stream", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: sessionId, question: text }),
            signal: controller.signal,
          });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const reader = resp.body?.getReader();
          if (!reader) throw new Error(t("errors.noStreamBody"));
          const decoder = new TextDecoder();
          let buffer = "";
          let full = "";
          let currentEvent = "";
          let dataLines: string[] = [];
          currentMsgs = [
            ...currentMsgs,
            { type: "assistant", content: "", pending: true },
          ];
          setMessages(currentMsgs);

          const dispatchEvent = () => {
            if (dataLines.length === 0) {
              currentEvent = "";
              return;
            }
            const payload = dataLines.join("\n");
            dataLines = [];
            const event = currentEvent;
            currentEvent = "";
            if (event === "message") {
              full += payload;
              const last = currentMsgs.at(-1);
              currentMsgs = [
                ...currentMsgs.slice(0, -1),
                {
                  type: "assistant" as const,
                  content: full,
                  ...(last?.a2ui ? { a2ui: last.a2ui } : {}),
                  ...(last?.references ? { references: last.references } : {}),
                  ...(last?.reasoning ? { reasoning: last.reasoning } : {}),
                  ...(last?.toolCalls ? { toolCalls: last.toolCalls } : {}),
                },
              ];
              setMessages(currentMsgs);
            } else if (event === "reasoning") {
              const last = currentMsgs.at(-1);
              currentMsgs = [
                ...currentMsgs.slice(0, -1),
                {
                  type: "assistant" as const,
                  content: last?.content ?? "",
                  ...(last?.pending ? { pending: true } : {}),
                  ...(last?.a2ui ? { a2ui: last.a2ui } : {}),
                  ...(last?.references ? { references: last.references } : {}),
                  reasoning: (last?.reasoning ?? "") + payload,
                  ...(last?.toolCalls ? { toolCalls: last.toolCalls } : {}),
                },
              ];
              setMessages(currentMsgs);
            } else if (event === "tool") {
              try {
                const parsedTool = toolEventSchema.safeParse(
                  JSON.parse(payload),
                );
                if (!parsedTool.success)
                  throw new Error("payload is not a tool event");
                const last = currentMsgs.at(-1);
                const tools = [...(last?.toolCalls ?? [])];
                const idx = tools.findIndex(
                  (tc) => tc.id === parsedTool.data.id,
                );
                if (idx === -1) {
                  tools.push(parsedTool.data);
                } else {
                  tools[idx] = { ...tools[idx], state: parsedTool.data.state };
                }
                currentMsgs = [
                  ...currentMsgs.slice(0, -1),
                  {
                    type: "assistant" as const,
                    content: last?.content ?? "",
                    ...(last?.pending ? { pending: true } : {}),
                    ...(last?.a2ui ? { a2ui: last.a2ui } : {}),
                    ...(last?.references
                      ? { references: last.references }
                      : {}),
                    ...(last?.reasoning ? { reasoning: last.reasoning } : {}),
                    toolCalls: tools,
                  },
                ];
                setMessages(currentMsgs);
              } catch (err) {
                console.error("invalid tool event payload:", err);
              }
            } else if (event === "references") {
              try {
                const parsedRefs = z
                  .array(chatReferenceExtSchema)
                  .safeParse(JSON.parse(payload));
                if (!parsedRefs.success)
                  throw new Error("payload is not a references array");
                const last = currentMsgs.at(-1);
                currentMsgs = [
                  ...currentMsgs.slice(0, -1),
                  {
                    type: "assistant" as const,
                    content: last?.content ?? "",
                    ...(last?.pending ? { pending: true } : {}),
                    ...(last?.a2ui ? { a2ui: last.a2ui } : {}),
                    references: parsedRefs.data,
                    ...(last?.reasoning ? { reasoning: last.reasoning } : {}),
                    ...(last?.toolCalls ? { toolCalls: last.toolCalls } : {}),
                  },
                ];
                setMessages(currentMsgs);
              } catch (err) {
                console.error("invalid references event payload:", err);
              }
            } else if (event === "a2ui") {
              try {
                const messages = z
                  .array(z.unknown())
                  .min(1)
                  .safeParse(JSON.parse(payload));
                if (!messages.success)
                  throw new Error("payload is not a non-empty array");
                const last = currentMsgs.at(-1);
                currentMsgs = [
                  ...currentMsgs.slice(0, -1),
                  {
                    type: "assistant" as const,
                    content: full,
                    a2ui: [...(last?.a2ui ?? []), ...messages.data],
                    ...(last?.references
                      ? { references: last.references }
                      : {}),
                    ...(last?.reasoning ? { reasoning: last.reasoning } : {}),
                    ...(last?.toolCalls ? { toolCalls: last.toolCalls } : {}),
                  },
                ];
                setMessages(currentMsgs);
              } catch (err) {
                console.error("invalid a2ui event payload:", err);
              }
            } else if (event === "error") {
              throw new Error(payload || t("streamError"));
            }
          };

          while (true) {
            if (controller.signal.aborted) break;
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const rawLine of lines) {
              const line = rawLine.endsWith("\r")
                ? rawLine.slice(0, -1)
                : rawLine;
              if (line === "") {
                dispatchEvent();
                continue;
              }
              if (line.startsWith("id: ")) continue;
              if (line.startsWith("event: ")) {
                currentEvent = line.slice(7);
                continue;
              }
              if (line.startsWith("data: ")) {
                dataLines.push(line.slice(6));
              } else if (line === "data:") {
                dataLines.push("");
              }
            }
          }
        }
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        const msg = e instanceof Error ? e.message : String(e);
        const errorMsg: ChatMessage = {
          type: "assistant",
          content: t("errorPrefix", { message: msg }),
        };
        currentMsgs = currentMsgs.at(-1)?.pending
          ? [...currentMsgs.slice(0, -1), errorMsg]
          : [...currentMsgs, errorMsg];
        setMessages(currentMsgs);
      } finally {
        setStreamController(null);
        setIsStreaming(false);
        if (currentMsgs.at(-1)?.pending) {
          currentMsgs = currentMsgs.slice(0, -1);
          setMessages(currentMsgs);
        }
        if (!controller.signal.aborted && currentMsgs.length > 0) {
          upsertHistory(sessionId, currentMsgs);
        }
      }
    },
    [isStreaming, messages, mode, sessionId, t, tCommon, upsertHistory],
  );

  const triggerAIOps = useCallback(async (): Promise<AIOpsResult | null> => {
    setIsStreaming(true);
    setOverlay({
      show: true,
      text: t("overlay.aiOpsText"),
      subtext: t("overlay.aiOpsSubtext"),
    });
    try {
      const resp = await fetch("/api/ai_ops", { method: "POST" });
      const parsed = aiOpsResponseSchema.safeParse(await resp.json());
      if (!parsed.success) throw new Error(t("errors.invalidAiOpsResponse"));
      const result = parsed.data.data?.result;
      if (parsed.data.message === "OK" && result) {
        const a2ui = parsed.data.data?.a2ui;
        return {
          result,
          detail: parsed.data.data?.detail ?? [],
          ...(a2ui && a2ui.length > 0 ? { a2ui } : {}),
        };
      }
      throw new Error(parsed.data.message || tCommon("unknownError"));
    } catch (e) {
      showNotification(
        t("notifications.aiOpsFailed", {
          error: e instanceof Error ? e.message : String(e),
        }),
        "error",
      );
      return null;
    } finally {
      setIsStreaming(false);
      setOverlay({ show: false, text: "", subtext: "" });
    }
  }, [showNotification, t, tCommon]);

  const sendA2uiAction = useCallback(
    async (messageIndex: number, action: A2uiClientAction) => {
      if (isStreaming) {
        showNotification(t("notifications.waitForOperation"), "warning");
        return;
      }
      const target = messages[messageIndex];
      if (!target?.a2ui || target.a2ui.length === 0) return;
      setIsStreaming(true);
      try {
        const resp = await fetch("/api/a2ui_action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: {
              name: action.name,
              surfaceId: action.surfaceId,
              sourceComponentId: action.sourceComponentId,
              context: action.context,
            },
            a2ui: target.a2ui,
          }),
        });
        const parsed = a2uiActionResponseSchema.safeParse(await resp.json());
        if (!parsed.success)
          throw new Error(t("errors.invalidA2uiActionResponse"));
        const patch = parsed.data.data?.a2ui;
        if (parsed.data.message !== "OK" || !patch) {
          throw new Error(parsed.data.message || tCommon("unknownError"));
        }
        const nextMsgs = messages.map((m, i) =>
          i === messageIndex
            ? { ...m, a2ui: [...(m.a2ui ?? []), ...patch] }
            : m,
        );
        setMessages(nextMsgs);
        upsertHistory(sessionId, nextMsgs);
      } catch (e) {
        showNotification(
          t("notifications.actionFailed", {
            error: e instanceof Error ? e.message : String(e),
          }),
          "error",
        );
      } finally {
        setIsStreaming(false);
      }
    },
    [
      isStreaming,
      messages,
      sessionId,
      showNotification,
      t,
      tCommon,
      upsertHistory,
    ],
  );

  const uploadFile = useCallback(
    async (file: File): Promise<string | null> => {
      const allowed = [".txt", ".md", ".markdown", ".pdf", ".docx"];
      const name = file.name.toLowerCase();
      if (!allowed.some((ext) => name.endsWith(ext))) {
        showNotification(t("notifications.fileTypeUnsupported"), "error");
        return null;
      }
      if (file.size > 50 * 1024 * 1024) {
        showNotification(t("notifications.fileTooLarge"), "error");
        return null;
      }
      setIsStreaming(true);
      setOverlay({
        show: true,
        text: t("overlay.uploadText"),
        subtext: file.name,
      });
      try {
        const fd = new FormData();
        fd.append("file", file);
        const resp = await fetch("/api/upload", { method: "POST", body: fd });
        const parsed = uploadResponseSchema.safeParse(await resp.json());
        if (!parsed.success) throw new Error(t("errors.invalidUploadResponse"));
        if (parsed.data.message === "OK" && parsed.data.data !== undefined) {
          return t("uploadedToKnowledgeBase", { name: file.name });
        }
        throw new Error(parsed.data.message || t("errors.uploadFailed"));
      } catch (e) {
        showNotification(
          t("notifications.uploadFailed", {
            error: e instanceof Error ? e.message : String(e),
          }),
          "error",
        );
        return null;
      } finally {
        setIsStreaming(false);
        setOverlay({ show: false, text: "", subtext: "" });
      }
    },
    [showNotification, t],
  );

  const addMessage = useCallback(
    (msg: ChatMessage) => setMessages((prev) => [...prev, msg]),
    [],
  );

  return useMemo(
    () => ({
      mode,
      setMode,
      sessionId,
      isStreaming,
      messages,
      addMessage,
      histories,
      overlay,
      showNotification,
      newChat,
      loadChatHistory,
      deleteChatHistory,
      sendMessage,
      sendA2uiAction,
      triggerAIOps,
      uploadFile,
    }),
    [
      mode,
      sessionId,
      isStreaming,
      messages,
      addMessage,
      histories,
      overlay,
      showNotification,
      newChat,
      loadChatHistory,
      deleteChatHistory,
      sendMessage,
      sendA2uiAction,
      triggerAIOps,
      uploadFile,
    ],
  );
}
