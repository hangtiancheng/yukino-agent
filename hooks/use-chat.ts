"use client";
import { useState, useCallback, useEffect, useMemo } from "react";
import { z } from "zod/v4";
import type { A2uiClientAction } from "@a2ui/web_core/v0_9";
import {
  a2uiActionResponseSchema,
  chatResponseSchema,
  aiOpsResponseSchema,
  uploadResponseSchema,
} from "@/lib/schemas";
import { toast } from "@/components/ui/toast";

export type Mode = "quick" | "stream";

export interface ChatMessage {
  type: "user" | "assistant";
  content: string;
  /** Optional step details for AI Ops results. */
  detail?: string[];
  /** A2UI protocol messages attached to an assistant reply (unknown[] at this boundary; validated per-message by the web_core schema at render time). */
  a2ui?: unknown[];
  /** Transient: reply not yet arrived — render a thinking placeholder. */
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

// Zod schemas for validating the localStorage-persisted chat history shape,
// so JSON.parse results are checked instead of type-asserted.
const chatMessageSchema = z.object({
  type: z.enum(["user", "assistant"]),
  content: z.string(),
  detail: z.array(z.string()).optional(),
  a2ui: z.array(z.unknown()).optional(),
});

const chatHistorySchema = z.object({
  id: z.string(),
  title: z.string(),
  messages: z.array(chatMessageSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const chatHistoriesSchema = z.array(chatHistorySchema);

// P3-14 fix: use crypto.randomUUID() for cryptographically random session IDs
// (browser-native, available in all modern browsers + Node.js 19+).
function generateSessionId(): string {
  return "session_" + crypto.randomUUID();
}

// Read persisted chat histories from localStorage.
// The `typeof localStorage` guard is a secondary server-safety check — if this
// function is ever called during SSR (it shouldn't be, thanks to the hydration
// guard above), it returns [] instead of throwing a ReferenceError.
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

function deriveTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.type === "user");
  if (!firstUser) return "New chat";
  const c = firstUser.content;
  return c.slice(0, 30) + (c.length > 30 ? "..." : "");
}

export function useChat() {
  const [mode, setMode] = useState<Mode>("quick");
  const [sessionId, setSessionId] = useState<string>("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [histories, setHistories] = useState<ChatHistory[]>([]);

  // Initialize client-only state (random session ID, localStorage histories)
  // AFTER hydration completes. useEffect fires after React confirms the
  // server HTML matches the client's first render, so the initial empty
  // values (sessionId="", histories=[]) are consistent on both sides and
  // no hydration mismatch occurs. The subsequent setState triggers a
  // client-only re-render with the real values.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount-once init for client-only state after hydration
    setSessionId(generateSessionId());
    setHistories(loadHistories());
  }, []);

  // AbortController state — when set, the effect cleans it up on unmount or
  // when replaced (P1-1 fix).
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

  // Notifications render through the base-ui toast system; keep the same
  // (message, type) call signature so call sites stay untouched.
  const showNotification = useCallback(
    (message: string, type: NotificationType = "info") => {
      toast.add({ title: message, type, timeout: 3000 });
    },
    [],
  );

  // Persist histories to localStorage whenever they change.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(histories));
    } catch {
      // ignore quota errors
    }
  }, [histories]);

  // Upsert the current conversation into histories (called after a turn).
  const upsertHistory = useCallback((sid: string, msgs: ChatMessage[]) => {
    if (msgs.length === 0) return;
    setHistories((prev) => {
      const title = deriveTitle(msgs);
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
  }, []);

  const newChat = useCallback(() => {
    if (isStreaming) {
      showNotification(
        "Please wait for the current chat to finish before starting a new one",
        "warning",
      );
      return;
    }
    setMessages([]);
    setSessionId(generateSessionId());
  }, [isStreaming, showNotification]);

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

      // Track messages in a local variable so we can call upsertHistory in
      // the finally block WITHOUT placing a side effect inside a state
      // updater function (P1-2 fix).
      let currentMsgs: ChatMessage[] = [
        ...messages,
        { type: "user", content: text },
      ];
      setMessages(currentMsgs);
      setIsStreaming(true);

      // AbortController for cancelling the stream on unmount (P1-1 fix).
      const controller = new AbortController();
      setStreamController(controller);

      try {
        if (mode === "quick") {
          // Show a thinking placeholder until the reply arrives.
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
          const parsed = chatResponseSchema.safeParse(await resp.json());
          if (!parsed.success) throw new Error("invalid chat response");
          const answer = parsed.data.data?.answer;
          const a2ui = parsed.data.data?.a2ui;
          if (parsed.data.message === "OK" && answer) {
            currentMsgs = [
              ...currentMsgs.slice(0, -1),
              {
                type: "assistant",
                content: answer,
                ...(a2ui && a2ui.length > 0 ? { a2ui } : {}),
              },
            ];
            setMessages(currentMsgs);
          } else {
            throw new Error(parsed.data.message || "Unknown error");
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
          if (!reader) throw new Error("no stream body");
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

          // Dispatch one complete SSE event: per spec, multiple `data:` lines
          // belong to the same event and are joined with "\n" — this is how
          // newlines inside streamed chunks survive the transport.
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
                },
              ];
              setMessages(currentMsgs);
            } else if (event === "a2ui") {
              // Payload is a JSON array of A2UI protocol messages; contents
              // are validated per-message by the web_core schema at render
              // time, so treat them as unknown[] here.
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
                  },
                ];
                setMessages(currentMsgs);
              } catch (err) {
                console.error("invalid a2ui event payload:", err);
              }
            } else if (event === "error") {
              // P1-3 fix: surface server-side error events instead of
              // silently ignoring them.
              throw new Error(payload || "Stream error");
            }
            // "done" event: clean termination — the reader will return
            // done=true on the next read and the loop will break.
          };

          while (true) {
            // Check abort before each read so unmount cancels promptly (P1-1 fix).
            if (controller.signal.aborted) break;
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const rawLine of lines) {
              // Strip trailing \r for SSE spec compliance (\r\n line endings).
              const line = rawLine.endsWith("\r")
                ? rawLine.slice(0, -1)
                : rawLine;
              // Blank line terminates the current event.
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
        // AbortError: user navigated away — suppress the error message.
        if (e instanceof DOMException && e.name === "AbortError") return;
        const msg = e instanceof Error ? e.message : String(e);
        const errorMsg: ChatMessage = {
          type: "assistant",
          content: "Error: " + msg,
        };
        // Replace a trailing thinking placeholder instead of appending after it.
        currentMsgs = currentMsgs.at(-1)?.pending
          ? [...currentMsgs.slice(0, -1), errorMsg]
          : [...currentMsgs, errorMsg];
        setMessages(currentMsgs);
      } finally {
        setStreamController(null);
        setIsStreaming(false);
        // Clear a leftover thinking placeholder (e.g. stream ended empty).
        if (currentMsgs.at(-1)?.pending) {
          currentMsgs = currentMsgs.slice(0, -1);
          setMessages(currentMsgs);
        }
        // P1-2 fix: upsertHistory is called with the local messages array,
        // NOT inside a setMessages state updater.
        if (!controller.signal.aborted && currentMsgs.length > 0) {
          upsertHistory(sessionId, currentMsgs);
        }
      }
    },
    [isStreaming, messages, mode, sessionId, upsertHistory],
  );

  const triggerAIOps = useCallback(async (): Promise<AIOpsResult | null> => {
    setIsStreaming(true);
    setOverlay({
      show: true,
      text: "AI Ops analyzing...",
      subtext: "Backend processing, please wait",
    });
    try {
      const resp = await fetch("/api/ai_ops", { method: "POST" });
      const parsed = aiOpsResponseSchema.safeParse(await resp.json());
      if (!parsed.success) throw new Error("invalid ai ops response");
      const result = parsed.data.data?.result;
      if (parsed.data.message === "OK" && result) {
        const a2ui = parsed.data.data?.a2ui;
        return {
          result,
          detail: parsed.data.data?.detail ?? [],
          ...(a2ui && a2ui.length > 0 ? { a2ui } : {}),
        };
      }
      throw new Error(parsed.data.message || "Unknown error");
    } catch (e) {
      showNotification(
        "AI Ops failed: " + (e instanceof Error ? e.message : String(e)),
        "error",
      );
      return null;
    } finally {
      setIsStreaming(false);
      setOverlay({ show: false, text: "", subtext: "" });
    }
  }, [showNotification]);

  // In-place surface action: POST the action + the owning message's current
  // a2ui array; the reply is a batch of updateComponents/updateDataModel
  // messages for the same surface, appended to that message so the A2uiView
  // applies them in place (no user chat message involved).
  const sendA2uiAction = useCallback(
    async (messageIndex: number, action: A2uiClientAction) => {
      if (isStreaming) {
        showNotification(
          "Please wait for the current operation to finish",
          "warning",
        );
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
        if (!parsed.success) throw new Error("invalid a2ui action response");
        const patch = parsed.data.data?.a2ui;
        if (parsed.data.message !== "OK" || !patch) {
          throw new Error(parsed.data.message || "Unknown error");
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
          "Action failed: " + (e instanceof Error ? e.message : String(e)),
          "error",
        );
      } finally {
        setIsStreaming(false);
      }
    },
    [isStreaming, messages, sessionId, showNotification, upsertHistory],
  );

  const uploadFile = useCallback(
    async (file: File): Promise<string | null> => {
      const allowed = [".txt", ".md", ".markdown"];
      const name = file.name.toLowerCase();
      if (!allowed.some((ext) => name.endsWith(ext))) {
        showNotification(
          "Only TXT or Markdown (.md) files are supported",
          "error",
        );
        return null;
      }
      if (file.size > 50 * 1024 * 1024) {
        showNotification("File size must not exceed 50MB", "error");
        return null;
      }
      setIsStreaming(true);
      setOverlay({ show: true, text: "Uploading file...", subtext: file.name });
      try {
        const fd = new FormData();
        fd.append("file", file);
        const resp = await fetch("/api/upload", { method: "POST", body: fd });
        const parsed = uploadResponseSchema.safeParse(await resp.json());
        if (!parsed.success) throw new Error("invalid upload response");
        if (parsed.data.message === "OK" && parsed.data.data !== undefined) {
          return `${file.name} uploaded to knowledge base`;
        }
        throw new Error(parsed.data.message || "Upload failed");
      } catch (e) {
        showNotification(
          "Upload failed: " + (e instanceof Error ? e.message : String(e)),
          "error",
        );
        return null;
      } finally {
        setIsStreaming(false);
        setOverlay({ show: false, text: "", subtext: "" });
      }
    },
    [showNotification],
  );

  // P1-6 fix: stabilize addMessage with useCallback so its reference is stable.
  const addMessage = useCallback(
    (msg: ChatMessage) => setMessages((prev) => [...prev, msg]),
    [],
  );

  // P1-6 fix: wrap the return object in useMemo so callers that depend on
  // individual fields (via destructuring) get stable references and their
  // useCallback dependencies don't invalidate on every render.
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
