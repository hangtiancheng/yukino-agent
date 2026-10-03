"use client";

// Agent Chat: streaming tool-calling chat scoped to the selected repository.
// Conversations are persisted server-side (Category C): a per-repo sidebar lets
// you list/create/delete/switch conversations, the transcript loads from the DB,
// and every assistant answer can be rated helpful/unhelpful. The SSE protocol
// matches /api/devflow/chat (connected/message/tool/done/error).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  MessageSquare,
  Plus,
  Send,
  Sparkles,
  Square,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  User,
  Wrench,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { notify } from "@/components/devflow/notify";
import { cn } from "@/lib/utils";
import PageHeader from "@/components/devflow/page-header";
import DevflowMarkdown from "@/components/devflow/markdown";
import {
  dfDelete,
  dfGet,
  dfPost,
  useDevflow,
} from "@/components/devflow/provider";
import type {
  ChatMessageView,
  ConversationSummary,
  FeedbackReason,
  FeedbackView,
} from "@/lib/devflow/types";

interface ToolTrace {
  name: string;
  state: "running" | "done";
}

interface ChatTurn {
  id?: string;
  role: "user" | "assistant";
  content: string;
  tools?: ToolTrace[];
  streaming?: boolean;
  error?: boolean;
  feedback?: { rating: string; reviewStatus: string } | null;
}

const SAMPLES = [
  "Why did the latest CI run fail?",
  "Summarize the risks of the newest open PR",
  "Which open issues look like duplicates?",
  "What does the knowledge base say about deployment?",
  "Draft a triage comment for the oldest open issue",
];

const REASON_OPTIONS: Array<{ value: FeedbackReason; label: string }> = [
  { value: "inaccurate", label: "Inaccurate content" },
  { value: "not_relevant", label: "Did not solve the problem" },
  { value: "missing_context", label: "Missing key context" },
  { value: "unreliable_citation", label: "Unreliable citation / evidence" },
  { value: "tool_error", label: "Tool execution error" },
  { value: "other", label: "Other" },
];

function toTurn(message: ChatMessageView): ChatTurn {
  return {
    id: message.id,
    role: message.role === "assistant" ? "assistant" : "user",
    content: message.content,
    tools: (message.toolCalls ?? []).map((t) => ({ name: t.name, state: "done" })),
    feedback: message.feedback,
    streaming: false,
  };
}

export default function DevflowChatPage() {
  const { repoId, repo } = useDevflow();

  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(
    null,
  );
  const [convReloadKey, setConvReloadKey] = useState(0);

  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Feedback dialog state.
  const [ratingTarget, setRatingTarget] = useState<ChatTurn | null>(null);
  const [reason, setReason] = useState<FeedbackReason>("inaccurate");
  const [comment, setComment] = useState("");
  const [submittingFeedback, setSubmittingFeedback] = useState(false);

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeConversationId) ?? null,
    [conversations, activeConversationId],
  );

  // Load the repo's conversations. Fetch lives in an inline async IIFE (see the
  // note in provider.tsx re: react-hooks/set-state-in-effect).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!repoId) {
        setConversations([]);
        setActiveConversationId(null);
        return;
      }
      setConversationsLoading(true);
      try {
        const items = await dfGet<ConversationSummary[]>(
          `/repos/${repoId}/conversations`,
        );
        if (cancelled) return;
        setConversations(items);
        setActiveConversationId((prev) =>
          prev && items.some((c) => c.id === prev) ? prev : (items[0]?.id ?? null),
        );
      } catch {
        if (!cancelled) setConversations([]);
      } finally {
        if (!cancelled) setConversationsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoId, convReloadKey]);

  // Load the transcript of the selected conversation.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!activeConversationId) {
        setTurns([]);
        return;
      }
      setMessagesLoading(true);
      try {
        const messages = await dfGet<ChatMessageView[]>(
          `/conversations/${activeConversationId}/messages`,
        );
        if (cancelled) return;
        setTurns(messages.map(toTurn));
      } catch {
        if (!cancelled) setTurns([]);
      } finally {
        if (!cancelled) setMessagesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeConversationId]);

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
  }, []);

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || !repoId || streaming) return;

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
          body: JSON.stringify({
            repoId,
            ...(activeConversationId
              ? { conversationId: activeConversationId }
              : {}),
            message,
          }),
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
            } else if (event === "done") {
              const ids = JSON.parse(dataText) as {
                conversationId: string;
                userMessageId: string;
                assistantMessageId: string;
              };
              setActiveConversationId(ids.conversationId);
              setTurns((current) => {
                const next = [...current];
                for (let i = next.length - 1; i >= 0; i--) {
                  if (next[i].role === "assistant" && !next[i].id) {
                    next[i] = { ...next[i], id: ids.assistantMessageId };
                    break;
                  }
                }
                for (let i = next.length - 1; i >= 0; i--) {
                  if (next[i].role === "user" && !next[i].id) {
                    next[i] = { ...next[i], id: ids.userMessageId };
                    break;
                  }
                }
                return next;
              });
              // The server may have renamed the conversation from the first
              // user message; refresh the sidebar list.
              setConvReloadKey((k) => k + 1);
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
    [repoId, streaming, activeConversationId],
  );

  const handleNewConversation = async () => {
    if (!repoId) return;
    try {
      const conversation = await dfPost<ConversationSummary>(
        `/repos/${repoId}/conversations`,
        {},
      );
      setConversations((prev) => [conversation, ...prev]);
      setActiveConversationId(conversation.id);
      setTurns([]);
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    }
  };

  const handleDeleteConversation = async (conversationId: string) => {
    try {
      const result = await dfDelete<{
        deleted: string;
        activeConversationId: string;
        conversations: ConversationSummary[];
      }>(`/conversations/${conversationId}`);
      setConversations(result.conversations);
      setActiveConversationId(result.activeConversationId);
      notify.info("Conversation deleted");
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    }
  };

  const submitRating = async (
    target: ChatTurn,
    rating: "helpful" | "unhelpful",
    opts: { reason?: FeedbackReason; comment?: string } = {},
  ) => {
    if (!repoId || !activeConversationId || !target.id) return;
    try {
      const saved = await dfPost<FeedbackView>("/feedback", {
        repoId,
        conversationId: activeConversationId,
        assistantMessageId: target.id,
        rating,
        ...(opts.reason ? { reason: opts.reason } : {}),
        ...(opts.comment ? { comment: opts.comment } : {}),
      });
      setTurns((current) =>
        current.map((turn) =>
          turn.id === target.id
            ? {
                ...turn,
                feedback: {
                  rating: saved.rating,
                  reviewStatus: saved.reviewStatus,
                },
              }
            : turn,
        ),
      );
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    }
  };

  const handleHelpful = (target: ChatTurn) => void submitRating(target, "helpful");

  const handleUnhelpfulSubmit = async () => {
    if (!ratingTarget) return;
    setSubmittingFeedback(true);
    await submitRating(ratingTarget, "unhelpful", {
      reason,
      ...(comment.trim() ? { comment: comment.trim() } : {}),
    });
    setSubmittingFeedback(false);
    setRatingTarget(null);
    setComment("");
  };

  const feedbackControls = (turn: ChatTurn) => {
    if (turn.streaming || !turn.id) return null;
    const rating = turn.feedback?.rating;
    return (
      <div className="mt-2 flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "h-7 px-2 text-xs",
            rating === "helpful" && "text-primary",
          )}
          onClick={() => handleHelpful(turn)}
          disabled={streaming}
        >
          <ThumbsUp className="size-3.5" />
          {rating === "helpful" ? "Helpful" : ""}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "h-7 px-2 text-xs",
            rating === "unhelpful" && "text-destructive",
          )}
          onClick={() => {
            setReason("inaccurate");
            setComment("");
            setRatingTarget(turn);
          }}
          disabled={streaming}
        >
          <ThumbsDown className="size-3.5" />
          {rating === "unhelpful" ? "Unhelpful" : ""}
        </Button>
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 w-full">
      {/* Conversation sidebar */}
      <aside className="border-border bg-card/40 hidden w-64 shrink-0 flex-col border-r md:flex">
        <div className="flex items-center justify-between gap-2 border-b p-3">
          <span className="text-sm font-medium">Conversations</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleNewConversation()}
            disabled={!repoId}
          >
            <Plus className="size-3.5" />
            New
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {conversationsLoading ? (
            <div className="flex justify-center py-8">
              <Spinner className="size-4" />
            </div>
          ) : conversations.length === 0 ? (
            <p className="text-muted-foreground px-2 py-4 text-xs italic">
              No conversations yet.
            </p>
          ) : (
            conversations.map((conversation) => {
              const active = conversation.id === activeConversationId;
              return (
                <div
                  key={conversation.id}
                  className={cn(
                    "group flex items-center gap-1.5 rounded-md px-2 py-1.5",
                    active ? "bg-accent" : "hover:bg-accent/50",
                  )}
                >
                  <button
                    onClick={() => setActiveConversationId(conversation.id)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="flex items-center gap-1.5">
                      <MessageSquare className="text-muted-foreground size-3.5 shrink-0" />
                      <span className="truncate text-sm">
                        {conversation.title}
                      </span>
                    </div>
                    <div className="text-muted-foreground mt-0.5 pl-5 text-[10px]">
                      {conversation.messageCount} messages
                    </div>
                  </button>
                  <button
                    onClick={() => void handleDeleteConversation(conversation.id)}
                    className="text-muted-foreground hover:text-destructive opacity-0 transition-opacity group-hover:opacity-100"
                    aria-label="Delete conversation"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </aside>

      {/* Chat column */}
      <div className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col gap-4 p-6">
        <PageHeader
          title="Agent Chat"
          description={
            repo
              ? `Tool-calling agent over ${repo.fullName}: issues, PRs, CI runs, knowledge base and safe action drafts.`
              : "Select a repository to chat with its data"
          }
          actions={
            activeConversation ? (
              <Badge variant="outline" className="max-w-56 truncate font-normal">
                {activeConversation.title}
              </Badge>
            ) : undefined
          }
        />

        <div
          ref={scrollRef}
          className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1"
        >
          {messagesLoading ? (
            <div className="flex justify-center py-12">
              <Spinner className="size-5" />
            </div>
          ) : turns.length === 0 ? (
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
                key={turn.id ?? i}
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
                  {turn.role === "assistant" ? feedbackControls(turn) : null}
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

      {/* Unhelpful-feedback dialog */}
      <Dialog
        open={ratingTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRatingTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>What went wrong?</DialogTitle>
            <DialogDescription>
              Your feedback helps improve the agent. Negative feedback opens a
              review and can notify the team.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <Select
              value={reason}
              onValueChange={(value) => setReason(value as FeedbackReason)}
            >
              <SelectTrigger aria-label="Reason">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REASON_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Textarea
              rows={3}
              placeholder="Optional details…"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setRatingTarget(null)}
              disabled={submittingFeedback}
            >
              Cancel
            </Button>
            <Button onClick={() => void handleUnhelpfulSubmit()} disabled={submittingFeedback}>
              {submittingFeedback ? <Spinner className="size-4" /> : null}
              Submit feedback
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
