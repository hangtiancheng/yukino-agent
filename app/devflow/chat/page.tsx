"use client";

// Agent Chat: streaming tool-calling chat scoped to the selected repository.
// The SSE protocol matches /api/devflow/chat (connected/message/tool/done/error).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Eraser,
  Send,
  Sparkles,
  Square,
  User,
  Wrench,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { notify } from "@/components/devflow/notify";
import { cn } from "@/lib/utils";
import PageHeader from "@/components/devflow/page-header";
import DevflowMarkdown from "@/components/devflow/markdown";
import { useDevflow } from "@/components/devflow/provider";

interface ToolTrace {
  name: string;
  state: "running" | "done";
}

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  tools?: ToolTrace[];
  streaming?: boolean;
  error?: boolean;
}

const SAMPLES = [
  "Why did the latest CI run fail?",
  "Summarize the risks of the newest open PR",
  "Which open issues look like duplicates?",
  "What does the knowledge base say about deployment?",
  "Draft a triage comment for the oldest open issue",
];

export default function DevflowChatPage() {
  const { repoId, repo } = useDevflow();
  // Transcripts are kept per repository, so switching repos in the header
  // preserves each conversation (no reset effect needed).
  const [turnsByRepo, setTurnsByRepo] = useState<Record<string, ChatTurn[]>>(
    {},
  );
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const turns = useMemo(
    () => (repoId ? (turnsByRepo[repoId] ?? []) : []),
    [repoId, turnsByRepo],
  );

  const setTurns = useCallback(
    (updater: (current: ChatTurn[]) => ChatTurn[]) => {
      if (!repoId) return;
      setTurnsByRepo((prev) => ({
        ...prev,
        [repoId]: updater(prev[repoId] ?? []),
      }));
    },
    [repoId],
  );

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [turns]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
    setTurns((current) =>
      current.map((turn) =>
        turn.streaming ? { ...turn, streaming: false } : turn,
      ),
    );
  }, [setTurns]);

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || !repoId || streaming) return;

      // History sent to the agent: previous turns + this message.
      const history = [
        ...turns
          .filter((t) => !t.error)
          .map((t) => ({ role: t.role, content: t.content })),
        { role: "user" as const, content: message },
      ];

      setInput("");
      setStreaming(true);
      setTurns((current) => [
        ...current,
        { role: "user", content: message },
        { role: "assistant", content: "", tools: [], streaming: true },
      ]);

      const controller = new AbortController();
      abortRef.current = controller;

      const patchLast = (patch: (turn: ChatTurn) => ChatTurn) => {
        setTurns((current) => {
          const next = [...current];
          for (let i = next.length - 1; i >= 0; i--) {
            if (next[i].role === "assistant") {
              next[i] = patch(next[i]);
              break;
            }
          }
          return next;
        });
      };

      try {
        const response = await fetch("/api/devflow/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repoId, messages: history }),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          const payload = await response.json().catch(() => null);
          throw new Error(
            (payload as { message?: string } | null)?.message ??
              `Chat request failed (${response.status})`,
          );
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() ?? "";
          for (const rawEvent of events) {
            const lines = rawEvent.split("\n");
            const event =
              lines.find((l) => l.startsWith("event: "))?.slice(7) ?? "message";
            const dataText = lines
              .filter((l) => l.startsWith("data: "))
              .map((l) => l.slice(6))
              .join("\n");
            if (!dataText) continue;
            if (event === "message") {
              patchLast((turn) => ({
                ...turn,
                content: turn.content + dataText,
              }));
            } else if (event === "tool") {
              const payload = JSON.parse(dataText) as {
                name: string;
                state: "call" | "result";
              };
              patchLast((turn) => {
                const tools = [...(turn.tools ?? [])];
                if (payload.state === "call") {
                  tools.push({ name: payload.name, state: "running" });
                } else {
                  const index = tools.findLastIndex(
                    (t) => t.state === "running",
                  );
                  if (index >= 0)
                    tools[index] = { ...tools[index], state: "done" };
                }
                return { ...turn, tools };
              });
            } else if (event === "error") {
              throw new Error(dataText);
            }
          }
        }
        patchLast((turn) => ({ ...turn, streaming: false }));
      } catch (e) {
        if ((e as Error).name === "AbortError") {
          patchLast((turn) => ({ ...turn, streaming: false }));
        } else {
          const message = e instanceof Error ? e.message : String(e);
          notify.error(message);
          patchLast((turn) => ({
            ...turn,
            streaming: false,
            error: true,
            content: turn.content || `Request failed: ${message}`,
          }));
        }
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [repoId, streaming, turns, setTurns],
  );

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-4xl flex-col gap-4 p-6">
      <PageHeader
        title="Agent Chat"
        description={
          repo
            ? `Tool-calling agent over ${repo.fullName}: issues, PRs, CI runs, knowledge base and safe action drafts.`
            : "Select a repository to chat with its data"
        }
        actions={
          turns.length > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setTurns(() => [])}
              disabled={streaming}
            >
              <Eraser />
              Clear
            </Button>
          ) : undefined
        }
      />

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1"
      >
        {turns.length === 0 ? (
          <Card className="border-dashed">
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <div className="bg-primary/10 text-primary flex size-12 items-center justify-center rounded-xl">
                <Bot className="size-6" />
              </div>
              <div>
                <p className="text-foreground text-sm font-medium">
                  Ask anything about this repository
                </p>
                <p className="text-muted-foreground mt-1 max-w-md text-xs">
                  The agent grounds every answer in synced data via tools, and
                  proposes GitHub writes only as confirmable drafts.
                </p>
              </div>
              <div className="flex max-w-xl flex-wrap justify-center gap-1.5">
                {SAMPLES.map((sample) => (
                  <button
                    key={sample}
                    onClick={() => void send(sample)}
                    disabled={!repoId}
                    className="border-border bg-background hover:bg-accent/60 hover:border-primary/40 rounded-full border px-3 py-1.5 text-xs transition-colors disabled:opacity-50"
                  >
                    {sample}
                  </button>
                ))}
              </div>
            </div>
          </Card>
        ) : (
          turns.map((turn, i) => (
            <div
              key={i}
              className={cn(
                "flex gap-3",
                turn.role === "user" ? "justify-end" : "justify-start",
              )}
            >
              {turn.role === "assistant" ? (
                <div className="bg-primary/10 text-primary mt-1 flex size-7 shrink-0 items-center justify-center rounded-lg">
                  <Sparkles className="size-4" />
                </div>
              ) : null}
              <div
                className={cn(
                  "max-w-[85%] min-w-0 rounded-2xl px-4 py-3",
                  turn.role === "user"
                    ? "bg-primary text-primary-foreground rounded-br-sm"
                    : turn.error
                      ? "border-destructive/40 bg-destructive/5 rounded-bl-sm border"
                      : "bg-card border-border rounded-bl-sm border",
                )}
              >
                {turn.role === "assistant" && (turn.tools ?? []).length > 0 ? (
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {(turn.tools ?? []).map((toolCall, j) => (
                      <Badge
                        key={j}
                        variant="outline"
                        className="text-muted-foreground gap-1 font-mono text-[10px]"
                      >
                        {toolCall.state === "running" ? (
                          <Spinner className="size-2.5" />
                        ) : (
                          <Wrench className="size-2.5" />
                        )}
                        {toolCall.name}
                      </Badge>
                    ))}
                  </div>
                ) : null}
                {turn.role === "user" ? (
                  <p className="text-sm leading-relaxed whitespace-pre-wrap">
                    {turn.content}
                  </p>
                ) : turn.content ? (
                  <DevflowMarkdown
                    content={turn.content}
                    streaming={turn.streaming}
                  />
                ) : turn.streaming ? (
                  <Spinner className="size-4" />
                ) : null}
              </div>
              {turn.role === "user" ? (
                <div className="bg-muted text-muted-foreground mt-1 flex size-7 shrink-0 items-center justify-center rounded-lg">
                  <User className="size-4" />
                </div>
              ) : null}
            </div>
          ))
        )}
      </div>

      <div className="flex shrink-0 items-end gap-2">
        <Textarea
          rows={2}
          placeholder={
            repoId
              ? "Ask the agent… (Enter to send, Shift+Enter for a new line)"
              : "Select a repository first"
          }
          value={input}
          disabled={!repoId}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
          className="min-h-16 flex-1 resize-none"
        />
        {streaming ? (
          <Button variant="outline" size="lg" onClick={stop}>
            <Square />
            Stop
          </Button>
        ) : (
          <Button
            size="lg"
            onClick={() => void send(input)}
            disabled={!repoId || !input.trim()}
          >
            <Send />
            Send
          </Button>
        )}
      </div>
    </div>
  );
}
