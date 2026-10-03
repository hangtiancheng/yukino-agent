// Chat feedback (thumbs up / down on assistant answers) with metrics, a human
// review workflow, and an optional Feishu/Lark notification for negative
// feedback. Port of the Python feedback route + feedback_notifications service,
// re-anchored on the assistant ChatMessage id (no AgentRun exists in this
// stack — the workflow-orchestrator models were not migrated).
import { config } from "@/lib/config";
import { prisma } from "@/lib/db";
import { ensureDemoUser } from "./permissions";
import type { ChatFeedback, ChatMessage, Repository } from "@/generated/prisma/client";

export type FeedbackRating = "helpful" | "unhelpful";
export type FeedbackReason =
  | "inaccurate"
  | "not_relevant"
  | "missing_context"
  | "unreliable_citation"
  | "tool_error"
  | "other";
export type ReviewStatus = "open" | "in_review" | "resolved" | "dismissed";

export const REASON_LABELS: Record<FeedbackReason, string> = {
  inaccurate: "Inaccurate content",
  not_relevant: "Did not solve the problem",
  missing_context: "Missing key context",
  unreliable_citation: "Unreliable citation / evidence",
  tool_error: "Tool execution error",
  other: "Other",
};

export const REVIEW_STATUSES: ReviewStatus[] = [
  "open",
  "in_review",
  "resolved",
  "dismissed",
];

export function toFeedbackView(f: ChatFeedback) {
  return {
    id: f.id,
    repoId: f.repoId,
    conversationId: f.conversationId,
    assistantMessageId: f.assistantMessageId,
    rating: f.rating,
    reason: f.reason,
    comment: f.comment,
    reviewStatus: f.reviewStatus,
    reviewNote: f.reviewNote,
    notificationStatus: f.notificationStatus,
    notificationError: f.notificationError,
    notifiedAt: f.notifiedAt ? f.notifiedAt.toISOString() : null,
    reviewedAt: f.reviewedAt ? f.reviewedAt.toISOString() : null,
    createdAt: f.createdAt.toISOString(),
    updatedAt: f.updatedAt.toISOString(),
  };
}

function clip(value: string | null | undefined, limit: number): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}

function traceUrl(messageId: string): string {
  const path = `/api/devflow/feedback/trace/${messageId}`;
  const base = (config.devflow.feedback.traceBaseUrl || "").replace(/\/+$/, "");
  return base ? `${base}${path}` : path;
}

export interface FeedbackNotificationContext {
  repo: Repository;
  message: ChatMessage;
  userQuestion: string | null;
  reporterName: string | null;
}

// Fire-and-await the Feishu notification. A notification failure never loses
// the persisted feedback — the caller records the returned status/error.
export async function sendNegativeFeedbackNotification(
  feedback: ChatFeedback,
  ctx: FeedbackNotificationContext,
): Promise<[status: string, error: string | null]> {
  const webhookUrl = (config.devflow.feedback.feishuWebhookUrl || "").trim();
  if (!webhookUrl) return ["not_configured", null];

  const lines = [
    "DevFlow received negative chat feedback",
    `Repository: ${ctx.repo.fullName}`,
    `Reporter: ${ctx.reporterName ?? "internal user"}`,
    `message_id: ${feedback.assistantMessageId}`,
    `Reason: ${REASON_LABELS[(feedback.reason as FeedbackReason) ?? "other"] ?? "Not provided"}`,
  ];
  if (feedback.comment) lines.push(`Comment: ${clip(feedback.comment, 300)}`);
  if (ctx.userQuestion) lines.push(`Question: ${clip(ctx.userQuestion, 300)}`);
  lines.push(`Answer: ${clip(ctx.message.content, 500)}`);
  lines.push(`Trace: ${traceUrl(feedback.assistantMessageId)}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msg_type: "text", content: { text: lines.join("\n") } }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`webhook responded ${response.status}`);
    const payload: unknown = await response.json().catch(() => null);
    if (payload && typeof payload === "object") {
      const dict = payload as Record<string, unknown>;
      const code = dict.StatusCode ?? dict.code ?? 0;
      if (code !== 0 && code !== "0") {
        throw new Error(String(dict.StatusMessage ?? dict.msg ?? "webhook rejected"));
      }
    }
    return ["sent", null];
  } catch (e) {
    return ["failed", clip(e instanceof Error ? e.message : String(e), 1000)];
  } finally {
    clearTimeout(timer);
  }
}

export interface CreateFeedbackInput {
  repoId: string;
  conversationId: string;
  assistantMessageId: string;
  rating: FeedbackRating;
  reason?: FeedbackReason | null;
  comment?: string | null;
}

export class FeedbackNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedbackNotFoundError";
  }
}

async function previousUserMessage(
  conversationId: string,
  assistantCreatedAt: Date,
): Promise<ChatMessage | null> {
  return prisma.chatMessage.findFirst({
    where: {
      conversationId,
      role: "user",
      createdAt: { lte: assistantCreatedAt },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function createFeedback(
  input: CreateFeedbackInput,
): Promise<ChatFeedback> {
  const repo = await prisma.repository.findUnique({
    where: { id: input.repoId },
  });
  const conversation = await prisma.conversation.findUnique({
    where: { id: input.conversationId },
  });
  if (!repo || !conversation || conversation.repoId !== repo.id) {
    throw new FeedbackNotFoundError("Project conversation not found");
  }
  const message = await prisma.chatMessage.findFirst({
    where: {
      id: input.assistantMessageId,
      repoId: input.repoId,
      conversationId: input.conversationId,
      role: "assistant",
    },
  });
  if (!message) throw new FeedbackNotFoundError("Assistant answer not found");

  const reporter = await ensureDemoUser();
  const existing = await prisma.chatFeedback.findUnique({
    where: { assistantMessageId: message.id },
  });

  const notify =
    input.rating === "unhelpful" &&
    (!existing || existing.rating !== "unhelpful" || existing.notifiedAt === null);

  const baseData = {
    rating: input.rating,
    reason: input.rating === "unhelpful" ? (input.reason ?? null) : null,
    comment: (input.comment ?? "").trim() || null,
    userId: reporter.id,
  };

  let feedback: ChatFeedback;
  const previousRating = existing?.rating;
  if (!existing) {
    feedback = await prisma.chatFeedback.create({
      data: {
        repoId: repo.id,
        conversationId: conversation.id,
        assistantMessageId: message.id,
        ...baseData,
        // Sensible initial state; corrected just below for unhelpful ratings.
        reviewStatus: input.rating === "unhelpful" ? "open" : "resolved",
        ...(input.rating === "helpful"
          ? { reviewedAt: new Date(), notificationStatus: "not_applicable" }
          : {}),
      },
    });
  } else {
    const data: Record<string, unknown> = { ...baseData };
    if (input.rating === "unhelpful") {
      if (previousRating !== "unhelpful") {
        data.reviewStatus = "open";
        data.reviewNote = null;
        data.reviewedAt = null;
      }
      if (notify) {
        data.notificationStatus = "pending";
        data.notificationError = null;
      }
    } else {
      data.reviewStatus = "resolved";
      data.reviewNote = null;
      data.reviewedAt = new Date();
      data.notificationStatus = "not_applicable";
      data.notificationError = null;
    }
    feedback = await prisma.chatFeedback.update({
      where: { id: existing.id },
      data,
    });
  }

  if (notify) {
    const userMessage = await previousUserMessage(conversation.id, message.createdAt);
    const [status, error] = await sendNegativeFeedbackNotification(feedback, {
      repo,
      message,
      userQuestion: userMessage?.content ?? null,
      reporterName: reporter.name,
    });
    feedback = await prisma.chatFeedback.update({
      where: { id: feedback.id },
      data: {
        notificationStatus: status,
        notificationError: error,
        notifiedAt: status === "sent" ? new Date() : null,
      },
    });
  }

  return feedback;
}

export interface ReviewFeedbackInput {
  reviewStatus: ReviewStatus;
  reviewNote?: string | null;
}

export async function reviewFeedback(
  feedbackId: string,
  input: ReviewFeedbackInput,
): Promise<ChatFeedback> {
  const feedback = await prisma.chatFeedback.findUnique({
    where: { id: feedbackId },
  });
  if (!feedback) throw new FeedbackNotFoundError("Feedback record not found");
  const resolved =
    input.reviewStatus === "resolved" || input.reviewStatus === "dismissed";
  return prisma.chatFeedback.update({
    where: { id: feedbackId },
    data: {
      reviewStatus: input.reviewStatus,
      reviewNote: (input.reviewNote ?? "").trim() || null,
      reviewedAt: resolved ? new Date() : null,
    },
  });
}

export async function listFeedback(
  repoId: string,
  conversationId?: string | null,
  limit = 200,
): Promise<ChatFeedback[]> {
  return prisma.chatFeedback.findMany({
    where: { repoId, ...(conversationId ? { conversationId } : {}) },
    orderBy: { createdAt: "desc" },
    take: Math.max(1, Math.min(limit, 500)),
  });
}

export interface FeedbackMetrics {
  repoId: string;
  assistantMessages: number;
  ratedMessages: number;
  feedbackCoverage: number;
  helpful: number;
  unhelpful: number;
  helpfulRate: number;
  unhelpfulRate: number;
  negativeFeedbackRate: number;
  openReviews: number;
  reasonCounts: Record<string, number>;
}

export async function feedbackMetrics(repoId: string): Promise<FeedbackMetrics> {
  const [rows, assistantMessages] = await Promise.all([
    prisma.chatFeedback.findMany({ where: { repoId } }),
    prisma.chatMessage.count({ where: { repoId, role: "assistant" } }),
  ]);
  const rated = rows.length;
  const helpful = rows.filter((r) => r.rating === "helpful").length;
  const unhelpful = rows.filter((r) => r.rating === "unhelpful").length;
  const reasonCounts: Record<string, number> = {};
  for (const row of rows) {
    if (row.reason) reasonCounts[row.reason] = (reasonCounts[row.reason] ?? 0) + 1;
  }
  const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
  return {
    repoId,
    assistantMessages,
    ratedMessages: rated,
    feedbackCoverage: assistantMessages ? round4(rated / assistantMessages) : 0,
    helpful,
    unhelpful,
    helpfulRate: rated ? round4(helpful / rated) : 0,
    unhelpfulRate: rated ? round4(unhelpful / rated) : 0,
    negativeFeedbackRate: assistantMessages
      ? round4(unhelpful / assistantMessages)
      : 0,
    openReviews: rows.filter(
      (r) =>
        r.rating === "unhelpful" &&
        (r.reviewStatus === "open" || r.reviewStatus === "in_review"),
    ).length,
    reasonCounts,
  };
}

export interface FeedbackTrace {
  traceId: string;
  repository: { id: string; fullName: string } | null;
  conversation: { id: string; title: string } | null;
  feedback: ChatFeedback | null;
  messages: {
    user: { id: string; role: string; content: string; createdAt: string } | null;
    assistant: {
      id: string;
      role: string;
      content: string;
      toolCalls: unknown;
      createdAt: string;
    } | null;
  };
}

// Evidence for one rated answer: the assistant message, the question that
// produced it, the surrounding conversation/repo, and the feedback record.
export async function feedbackTrace(
  assistantMessageId: string,
): Promise<FeedbackTrace> {
  const message = await prisma.chatMessage.findUnique({
    where: { id: assistantMessageId },
  });
  const feedback = await prisma.chatFeedback.findUnique({
    where: { assistantMessageId },
  });
  if (!message && !feedback) {
    throw new FeedbackNotFoundError("Trace not found");
  }
  const assistantMessage =
    message ??
    (feedback
      ? await prisma.chatMessage.findUnique({
          where: { id: feedback.assistantMessageId },
        })
      : null);
  if (!assistantMessage) throw new FeedbackNotFoundError("Trace not found");

  const conversation = await prisma.conversation.findUnique({
    where: { id: assistantMessage.conversationId },
  });
  const repo = conversation
    ? await prisma.repository.findUnique({ where: { id: conversation.repoId } })
    : null;
  const userMessage = await previousUserMessage(
    assistantMessage.conversationId,
    assistantMessage.createdAt,
  );

  return {
    traceId: assistantMessage.id,
    repository: repo ? { id: repo.id, fullName: repo.fullName } : null,
    conversation: conversation
      ? { id: conversation.id, title: conversation.title }
      : null,
    feedback,
    messages: {
      user: userMessage
        ? {
            id: userMessage.id,
            role: userMessage.role,
            content: userMessage.content,
            createdAt: userMessage.createdAt.toISOString(),
          }
        : null,
      assistant: {
        id: assistantMessage.id,
        role: assistantMessage.role,
        content: assistantMessage.content,
        toolCalls: assistantMessage.toolCalls ?? [],
        createdAt: assistantMessage.createdAt.toISOString(),
      },
    },
  };
}
