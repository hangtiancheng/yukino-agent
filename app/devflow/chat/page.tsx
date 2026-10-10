"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronUp,
  FileText,
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
  X,
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
  dfPatch,
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

interface CitationView {
  docName: string;
  score: number;
  source?: string;
}

interface MemoryStatePanel {
  summary: string;
  facts: string[];
  decisions: string[];
  sessionsIncorporated: number;
  updatedAt: string;
}

interface ConversationMemoryPanel extends MemoryStatePanel {
  conversationId: string;
  conversationTitle: string | null;
}

interface RepoMemoryPanel {
  thread: MemoryStatePanel | null;
  conversations: ConversationMemoryPanel[];
}

interface MemoryCandidatePanel {
  id: string;
  repoId: string;
  conversationId: string | null;
  kind: string;
  title: string;
  content: string;
  status: string;
  createdAt: string;
}

function parseCitations(value: unknown): CitationView[] {
  if (!Array.isArray(value)) return [];
  const citations: CitationView[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as {
      docName?: unknown;
      score?: unknown;
      source?: unknown;
    };
    if (
      typeof candidate.docName === "string" &&
      typeof candidate.score === "number"
    ) {
      citations.push({
        docName: candidate.docName,
        score: candidate.score,
        ...(typeof candidate.source === "string"
          ? { source: candidate.source }
          : {}),
      });
    }
  }
  return citations;
}

const CANDIDATE_KIND_KEYS: Record<
  string,
  "decision" | "fact" | "task" | "preference" | "repoContext"
> = {
  decision: "decision",
  fact: "fact",
  task: "task",
  preference: "preference",
  repo_context: "repoContext",
};

interface ChatTurn {
  id?: string;
  role: "user" | "assistant";
  content: string;
  tools?: ToolTrace[];
  streaming?: boolean;
  error?: boolean;
  citations?: CitationView[];
  feedback?: { rating: string; reviewStatus: string } | null;
}

const REASON_VALUES: readonly FeedbackReason[] = [
  "inaccurate",
  "not_relevant",
  "missing_context",
  "unreliable_citation",
  "tool_error",
  "other",
];

const REASON_KEYS = {
  inaccurate: "inaccurate",
  not_relevant: "notRelevant",
  missing_context: "missingContext",
  unreliable_citation: "unreliableCitation",
  tool_error: "toolError",
  other: "other",
} as const;

function toTurn(message: ChatMessageView): ChatTurn {
  return {
    id: message.id,
    role: message.role === "assistant" ? "assistant" : "user",
    content: message.content,
    tools: (message.toolCalls ?? []).map((t) => ({
      name: t.name,
      state: "done",
    })),
    feedback: message.feedback,
    citations: parseCitations(message.meta.citations),
    error: message.meta.error === true,
    streaming: false,
  };
}

function parseErrorFrame(dataText: string): {
  message: string;
  assistantMessageId?: string;
  persisted: boolean;
} {
  try {
    const parsed: unknown = JSON.parse(dataText);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as { message?: unknown }).message === "string"
    ) {
      const body = parsed as { message: string; assistantMessageId?: unknown };
      return {
        message: body.message,
        ...(typeof body.assistantMessageId === "string"
          ? { assistantMessageId: body.assistantMessageId }
          : {}),
        persisted: true,
      };
    }
  } catch {}
  return { message: dataText, persisted: false };
}

export default function DevflowChatPage() {
  const { repoId, repo } = useDevflow();
  const t = useTranslations("devflow.agentChat");
  const tc = useTranslations("common");
  const samples = [
    t("sample1"),
    t("sample2"),
    t("sample3"),
    t("sample4"),
    t("sample5"),
  ];

  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<string[] | null>(null);
  const [suggestionsReloadKey, setSuggestionsReloadKey] = useState(0);
  const [activeConversationId, setActiveConversationId] = useState<
    string | null
  >(null);
  const [convReloadKey, setConvReloadKey] = useState(0);

  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const [ratingTarget, setRatingTarget] = useState<ChatTurn | null>(null);
  const [reason, setReason] = useState<FeedbackReason>("inaccurate");
  const [comment, setComment] = useState("");
  const [submittingFeedback, setSubmittingFeedback] = useState(false);

  const [memoryOpen, setMemoryOpen] = useState(false);
  const [memory, setMemory] = useState<RepoMemoryPanel | null>(null);
  const [candidates, setCandidates] = useState<MemoryCandidatePanel[]>([]);
  const [memoryReloadKey, setMemoryReloadKey] = useState(0);

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeConversationId) ?? null,
    [conversations, activeConversationId],
  );

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
          prev && items.some((c) => c.id === prev)
            ? prev
            : (items[0]?.id ?? null),
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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!repoId) {
        setSuggestions(null);
        return;
      }
      try {
        const result = await dfGet<{ suggestions: string[] }>(
          `/repos/${repoId}/recommendations?limit=5`,
        );
        if (!cancelled) {
          setSuggestions(
            result.suggestions.length > 0 ? result.suggestions : null,
          );
        }
      } catch {
        if (!cancelled) setSuggestions(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoId, suggestionsReloadKey]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!repoId) {
        setMemory(null);
        setCandidates([]);
        return;
      }
      try {
        const [memoryData, candidateData] = await Promise.all([
          dfGet<RepoMemoryPanel>(`/repos/${repoId}/memory`),
          dfGet<MemoryCandidatePanel[]>(
            `/repos/${repoId}/memory-candidates?status=pending`,
          ),
        ]);
        if (cancelled) return;
        setMemory(memoryData);
        setCandidates(candidateData);
      } catch {
        if (!cancelled) {
          setMemory(null);
          setCandidates([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoId, memoryReloadKey]);

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
              t("chatRequestFailed", { status: response.status }),
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
                citations?: unknown;
              };
              setActiveConversationId(ids.conversationId);
              setTurns((current) => {
                const next = [...current];
                const doneCitations = parseCitations(ids.citations);
                for (let i = next.length - 1; i >= 0; i--) {
                  if (next[i].role === "assistant" && !next[i].id) {
                    next[i] = {
                      ...next[i],
                      id: ids.assistantMessageId,
                      ...(doneCitations.length > 0
                        ? { citations: doneCitations }
                        : {}),
                    };
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
              setConvReloadKey((k) => k + 1);
            } else if (event === "error") {
              const frame = parseErrorFrame(dataText);
              if (!frame.persisted) throw new Error(frame.message);
              patchLast((turn) => ({
                ...turn,
                streaming: false,
                error: true,
                content: frame.message,
                id: frame.assistantMessageId ?? turn.id,
              }));
              setConvReloadKey((k) => k + 1);
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
            content: turn.content || t("requestFailed", { message }),
          }));
        }
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [repoId, streaming, activeConversationId, t],
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
      notify.info(t("conversationDeleted"));
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

  const handleHelpful = (target: ChatTurn) =>
    void submitRating(target, "helpful");

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

  const handleCandidateAction = async (
    candidateId: string,
    action: "approve" | "reject",
  ) => {
    if (!repoId) return;
    try {
      const result = await dfPatch<{
        candidate: MemoryCandidatePanel;
        kbStatus: string | null;
      }>(`/repos/${repoId}/memory-candidates/${candidateId}`, { action });
      setCandidates((prev) => prev.filter((c) => c.id !== candidateId));
      if (action === "approve") {
        if (result.kbStatus === "failed") {
          notify.info(t("candidateApprovedKbFailed"));
        } else {
          notify.success(t("candidateApproved"));
        }
        setMemoryReloadKey((k) => k + 1);
      } else {
        notify.info(t("candidateRejected"));
      }
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    }
  };

  const candidateKindLabel = (kind: string): string => {
    const key = CANDIDATE_KIND_KEYS[kind];
    return key ? t(`candidateKind.${key}`) : kind;
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
          {rating === "helpful" ? t("helpful") : ""}
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
          {rating === "unhelpful" ? t("unhelpful") : ""}
        </Button>
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 w-full">
      <aside className="border-border bg-card/40 hidden w-64 shrink-0 flex-col border-r md:flex">
        <div className="flex items-center justify-between gap-2 border-b p-3">
          <span className="text-sm font-medium">{t("conversations")}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleNewConversation()}
            disabled={!repoId}
          >
            <Plus className="size-3.5" />
            {t("new")}
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {conversationsLoading ? (
            <div className="flex justify-center py-8">
              <Spinner className="size-4" />
            </div>
          ) : conversations.length === 0 ? (
            <p className="text-muted-foreground px-2 py-4 text-xs italic">
              {t("noConversations")}
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
                      {t("messagesCount", { count: conversation.messageCount })}
                    </div>
                  </button>
                  <button
                    onClick={() =>
                      void handleDeleteConversation(conversation.id)
                    }
                    className="text-muted-foreground hover:text-destructive opacity-0 transition-opacity group-hover:opacity-100"
                    aria-label={t("deleteConversation")}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </aside>

      <div className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col gap-4 p-6">
        <PageHeader
          title={t("title")}
          description={
            repo
              ? t("descriptionRepo", { repo: repo.fullName })
              : t("descriptionNone")
          }
          actions={
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setMemoryOpen((open) => !open)}
                disabled={!repoId}
              >
                <Brain className="size-3.5" />
                {t("memory")}
                {memoryOpen ? (
                  <ChevronUp className="size-3.5" />
                ) : (
                  <ChevronDown className="size-3.5" />
                )}
              </Button>
              {activeConversation ? (
                <Badge
                  variant="outline"
                  className="max-w-56 truncate font-normal"
                >
                  {activeConversation.title}
                </Badge>
              ) : null}
            </div>
          }
        />

        {memoryOpen ? (
          <Card className="shrink-0">
            <div className="space-y-3 p-4">
              <div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">
                    {t("memoryThreadTitle")}
                  </span>
                  {memory?.thread ? (
                    <span className="text-muted-foreground text-[10px]">
                      {t("memorySessionsCount", {
                        count: memory.thread.sessionsIncorporated,
                      })}
                    </span>
                  ) : null}
                </div>
                {memory?.thread?.summary ? (
                  <p className="text-muted-foreground mt-1.5 text-xs leading-relaxed whitespace-pre-wrap">
                    {memory.thread.summary}
                  </p>
                ) : (
                  <p className="text-muted-foreground mt-1.5 text-xs italic">
                    {t("memorySummaryEmpty")}
                  </p>
                )}
                {memory?.thread && memory.thread.decisions.length > 0 ? (
                  <div className="mt-2">
                    <span className="text-muted-foreground text-[10px] font-medium uppercase">
                      {t("memoryDecisions")}
                    </span>
                    <ul className="mt-1 space-y-0.5">
                      {memory.thread.decisions.slice(0, 6).map((item) => (
                        <li key={item} className="text-foreground/80 text-xs">
                          - {item}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {memory?.thread && memory.thread.facts.length > 0 ? (
                  <div className="mt-2">
                    <span className="text-muted-foreground text-[10px] font-medium uppercase">
                      {t("memoryFacts")}
                    </span>
                    <ul className="mt-1 space-y-0.5">
                      {memory.thread.facts.slice(0, 6).map((item) => (
                        <li key={item} className="text-foreground/80 text-xs">
                          - {item}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
              <div className="border-border border-t pt-3">
                <span className="text-sm font-medium">
                  {t("memoryCandidatesTitle")}
                </span>
                {candidates.length === 0 ? (
                  <p className="text-muted-foreground mt-1.5 text-xs italic">
                    {t("memoryCandidatesEmpty")}
                  </p>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {candidates.map((candidate) => (
                      <li
                        key={candidate.id}
                        className="border-border bg-background rounded-lg border p-2.5"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <Badge
                              variant="outline"
                              className="text-muted-foreground shrink-0 text-[10px] font-normal"
                            >
                              {candidateKindLabel(candidate.kind)}
                            </Badge>
                            <span className="truncate text-xs font-medium">
                              {candidate.title}
                            </span>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 px-1.5 text-[10px]"
                              onClick={() =>
                                void handleCandidateAction(
                                  candidate.id,
                                  "approve",
                                )
                              }
                            >
                              <Check className="size-3" />
                              {t("candidateApprove")}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-muted-foreground hover:text-destructive h-6 px-1.5 text-[10px]"
                              onClick={() =>
                                void handleCandidateAction(
                                  candidate.id,
                                  "reject",
                                )
                              }
                            >
                              <X className="size-3" />
                              {t("candidateReject")}
                            </Button>
                          </div>
                        </div>
                        <p className="text-muted-foreground mt-1 line-clamp-2 text-xs">
                          {candidate.content}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </Card>
        ) : null}

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
                <div className="from-primary/12 to-chart-2/20 text-primary ring-primary/10 flex size-12 items-center justify-center rounded-xl bg-linear-to-br ring-1">
                  <Bot className="size-6" />
                </div>
                <div>
                  <p className="text-foreground text-sm font-medium">
                    {t("askAnything")}
                  </p>
                  <p className="text-muted-foreground mt-1 max-w-md text-xs">
                    {t("askAnythingDescription")}
                  </p>
                </div>
                <div className="flex max-w-xl flex-wrap justify-center gap-1.5">
                  {(suggestions ?? samples).map((sample) => (
                    <button
                      key={sample}
                      onClick={() => {
                        void send(sample);
                        setSuggestionsReloadKey((k) => k + 1);
                      }}
                      disabled={!repoId}
                      className="border-border bg-background text-muted-foreground hover:bg-accent/60 hover:text-foreground hover:border-primary/40 shadow-soft rounded-full border px-3 py-1.5 text-xs transition-colors disabled:opacity-50"
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
                  <div className="from-primary/12 to-chart-2/20 text-primary ring-primary/10 mt-1 flex size-7 shrink-0 items-center justify-center rounded-lg bg-linear-to-br ring-1">
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
                  {turn.role === "assistant" &&
                  (turn.tools ?? []).length > 0 ? (
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
                  {turn.role === "assistant" &&
                  (turn.citations ?? []).length > 0 ? (
                    <div
                      className="mt-2 flex flex-wrap gap-1"
                      aria-label={t("citations")}
                    >
                      {(turn.citations ?? []).map((citation, j) => (
                        <Badge
                          key={`${citation.docName}-${j}`}
                          variant="outline"
                          className="text-muted-foreground max-w-56 gap-1 text-[10px]"
                        >
                          <FileText className="size-2.5 shrink-0" />
                          <span className="truncate">{citation.docName}</span>
                          <span className="text-muted-foreground/70 shrink-0">
                            {citation.score.toFixed(2)}
                          </span>
                        </Badge>
                      ))}
                    </div>
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
            placeholder={repoId ? t("inputPlaceholder") : t("selectRepoFirst")}
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
              {t("stop")}
            </Button>
          ) : (
            <Button
              size="lg"
              onClick={() => void send(input)}
              disabled={!repoId || !input.trim()}
            >
              <Send />
              {t("send")}
            </Button>
          )}
        </div>
      </div>

      <Dialog
        open={ratingTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRatingTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("whatWentWrong")}</DialogTitle>
            <DialogDescription>{t("feedbackDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <Select
              value={reason}
              onValueChange={(value) => setReason(value as FeedbackReason)}
            >
              <SelectTrigger aria-label={t("reasonLabel")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REASON_VALUES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`reason.${REASON_KEYS[value]}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Textarea
              rows={3}
              placeholder={t("optionalDetails")}
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
              {tc("cancel")}
            </Button>
            <Button
              onClick={() => void handleUnhelpfulSubmit()}
              disabled={submittingFeedback}
            >
              {submittingFeedback ? <Spinner className="size-4" /> : null}
              {t("submitFeedback")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
