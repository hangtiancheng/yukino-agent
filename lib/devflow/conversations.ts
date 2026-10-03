// Server-side chat conversation persistence. Port of the Python
// services/conversations.py, trimmed to the models that exist in this stack
// (Conversation + ChatMessage). The B-only cascade targets (ChatSession,
// AgentRun, ConversationMemory, EvidenceItem, MemoryCandidate, RecallEvent,
// AgentWorkflowRun, AgentTaskRun) are absent, so delete only clears messages
// and feedback, then soft-deletes the conversation row.
import { prisma } from "@/lib/db";
import {
  Prisma,
  type ChatFeedback,
  type ChatMessage,
  type Conversation,
} from "@/generated/prisma/client";

export type MessageWithFeedback = ChatMessage & {
  feedback: ChatFeedback | null;
};

// Prisma's InputJsonValue rejects `unknown` leaves; the persisted payloads are
// already JSON-serializable, so assert once at the boundary.
const asJson = (value: unknown): Prisma.InputJsonValue =>
  value as Prisma.InputJsonValue;

const DEFAULT_TITLE = "Default conversation";
const NEW_TITLE_PREFIX = "New conversation";

export interface ConversationSummary {
  id: string;
  repoId: string;
  title: string;
  status: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export function toConversationSummary(c: Conversation): ConversationSummary {
  return {
    id: c.id,
    repoId: c.repoId,
    title: c.title,
    status: c.status,
    messageCount: c.messageCount,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

export interface MessageView {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  toolCalls: unknown;
  meta: unknown;
  createdAt: string;
}

export function toMessageView(m: ChatMessage): MessageView {
  return {
    id: m.id,
    conversationId: m.conversationId,
    role: m.role,
    content: m.content,
    toolCalls: m.toolCalls ?? [],
    meta: m.meta ?? {},
    createdAt: m.createdAt.toISOString(),
  };
}

// The oldest active conversation for a repo, creating "Default conversation"
// when none exists. Mirrors ensure_default_conversation.
export async function ensureDefaultConversation(
  repoId: string,
): Promise<Conversation> {
  const existing = await prisma.conversation.findFirst({
    where: { repoId, status: "active" },
    orderBy: { createdAt: "asc" },
  });
  if (existing) return existing;
  return prisma.conversation.create({
    data: { repoId, title: DEFAULT_TITLE, status: "active" },
  });
}

// Resolve a specific active conversation, falling back to the default.
export async function ensureConversation(
  repoId: string,
  conversationId?: string | null,
): Promise<Conversation> {
  if (conversationId) {
    const found = await prisma.conversation.findFirst({
      where: { id: conversationId, repoId, status: "active" },
    });
    if (found) return found;
  }
  return ensureDefaultConversation(repoId);
}

export async function listConversations(
  repoId: string,
): Promise<Conversation[]> {
  await ensureDefaultConversation(repoId);
  return prisma.conversation.findMany({
    where: { repoId, status: "active" },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "asc" }],
  });
}

async function nextTitle(repoId: string): Promise<string> {
  const count = await prisma.conversation.count({ where: { repoId } });
  return count === 0 ? DEFAULT_TITLE : `${NEW_TITLE_PREFIX} ${count + 1}`;
}

export async function createConversation(
  repoId: string,
  title?: string | null,
): Promise<Conversation> {
  const trimmed = (title ?? "").trim();
  return prisma.conversation.create({
    data: { repoId, title: trimmed || (await nextTitle(repoId)) },
  });
}

export async function getConversation(
  repoId: string,
  conversationId: string,
): Promise<Conversation | null> {
  return prisma.conversation.findFirst({
    where: { id: conversationId, repoId, status: "active" },
  });
}

// Soft-delete a conversation and hard-delete its messages + feedback. Returns
// the replacement active conversation (most recently updated, else a fresh
// default) so the client always has something selected.
export async function deleteConversation(
  repoId: string,
  conversationId: string,
): Promise<Conversation> {
  const target = await prisma.conversation.findFirst({
    where: { id: conversationId, repoId, status: "active" },
  });
  if (!target) return ensureDefaultConversation(repoId);

  await prisma.$transaction([
    prisma.chatFeedback.deleteMany({ where: { conversationId: target.id } }),
    prisma.chatMessage.deleteMany({ where: { conversationId: target.id } }),
    prisma.conversation.update({
      where: { id: target.id },
      data: { status: "deleted" },
    }),
  ]);

  const replacement = await prisma.conversation.findFirst({
    where: { repoId, status: "active" },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "asc" }],
  });
  return replacement ?? createConversation(repoId, DEFAULT_TITLE);
}

// Promote the title from the first user message while it is still a default,
// bump the message count and refresh updated_at. Mirrors touch_conversation.
async function touchConversation(
  conversationId: string,
  opts: { userMessage?: string | null; increment?: number } = {},
): Promise<void> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
  });
  if (!conversation) return;
  const data: { title?: string; messageCount?: number } = {};
  if (
    opts.userMessage &&
    conversation.messageCount === 0 &&
    (conversation.title.startsWith(DEFAULT_TITLE) ||
      conversation.title.startsWith(NEW_TITLE_PREFIX))
  ) {
    const derived = opts.userMessage.trim().replace(/\s+/g, " ");
    if (derived) data.title = derived.slice(0, 40);
  }
  if (opts.increment) {
    data.messageCount = conversation.messageCount + opts.increment;
  }
  await prisma.conversation.update({ where: { id: conversationId }, data });
}

export interface AppendMessageInput {
  conversationId: string;
  repoId: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: unknown[];
  meta?: Record<string, unknown>;
}

// Persist one chat message and touch its conversation.
export async function appendMessage(
  input: AppendMessageInput,
): Promise<ChatMessage> {
  const message = await prisma.chatMessage.create({
    data: {
      conversationId: input.conversationId,
      repoId: input.repoId,
      role: input.role,
      content: input.content,
      ...(input.toolCalls ? { toolCalls: asJson(input.toolCalls) } : {}),
      ...(input.meta ? { meta: asJson(input.meta) } : {}),
    },
  });
  await touchConversation(input.conversationId, {
    userMessage: input.role === "user" ? input.content : null,
    increment: 1,
  });
  return message;
}

// The most recent `limit` messages of a conversation, in chronological order,
// each with its feedback record (if any) for rendering rating state.
export async function listMessages(
  conversationId: string,
  limit = 200,
): Promise<MessageWithFeedback[]> {
  const take = Math.max(1, Math.min(limit, 500));
  const rows = await prisma.chatMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take,
    include: { feedback: true },
  });
  return rows.reverse();
}
