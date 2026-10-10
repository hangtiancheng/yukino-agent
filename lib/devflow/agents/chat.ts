import {
  streamText,
  tool,
  isStepCount,
  type Tool,
  type ToolExecutionOptions,
  type ModelMessage,
} from "ai";
import { getTranslations } from "next-intl/server";
import { z } from "zod/v4";
import { prisma } from "@/lib/db";
import { quickModel, providerOptions } from "@/lib/ai/models";
import { searchKnowledge } from "@/lib/devflow/rag";
import {
  listFiles,
  readCodeFile,
  requireCheckout,
  searchCode,
} from "@/lib/devflow/workspace";
import { searchProjectDocs } from "@/lib/devflow/project-index";
import {
  appendMessage,
  ensureConversation,
  listMessages,
} from "@/lib/devflow/conversations";
import {
  buildMemoryContext,
  maybeSealAndMerge,
  proposeMemoryCandidate,
  MEMORY_CANDIDATE_KINDS,
} from "@/lib/devflow/memory";
import { DEVFLOW_CHAT_SYSTEM_PROMPT } from "./prompts";
import { getSkillRegistry, SkillRegistry } from "@/lib/devflow/skills";
import type { Repository } from "@/generated/prisma/client";

export type DevflowChatEvent =
  | { type: "text"; content: string }
  | { type: "tool"; name: string; state: "call" | "result"; input?: unknown }
  | {
      type: "error";
      message: string;
      assistantMessageId?: string;
    }
  | {
      type: "done";
      conversationId: string;
      userMessageId: string;
      assistantMessageId: string;
      citations?: ChatCitation[];
    };

const MAX_TOOL_RESULT_CHARS = 12_000;

function pack(value: unknown): string {
  const json = JSON.stringify(value, (_k, v) =>
    typeof v === "bigint" ? Number(v) : v,
  );
  if (json.length <= MAX_TOOL_RESULT_CHARS) return json;
  return `${json.slice(0, MAX_TOOL_RESULT_CHARS)} …[truncated]`;
}

function clipBody(body: string | null, max = 2000): string | null {
  if (!body) return body;
  return body.length > max ? `${body.slice(0, max)}\n…[truncated]` : body;
}

export interface ChatCitation {
  docName: string;
  score: number;
  source: string;
}

export const MAX_CITATIONS = 12;

export function knowledgeCitations(
  hits: readonly { docName: string; score: number }[],
): ChatCitation[] {
  return hits
    .filter((hit) => hit.docName)
    .map((hit) => ({
      docName: hit.docName,
      score: hit.score,
      source: "knowledge",
    }));
}

export function projectDocCitations(
  hits: readonly { path: string; score: number }[],
): ChatCitation[] {
  return hits
    .filter((hit) => hit.path)
    .map((hit) => ({
      docName: hit.path,
      score: hit.score,
      source: "project_docs",
    }));
}

export function dedupeCitations(
  citations: readonly ChatCitation[],
  max: number = MAX_CITATIONS,
): ChatCitation[] {
  const byKey = new Map<string, ChatCitation>();
  for (const citation of citations) {
    const key = `${citation.source}:${citation.docName}`;
    const existing = byKey.get(key);
    if (!existing || citation.score > existing.score) byKey.set(key, citation);
  }
  return [...byKey.values()].sort((a, b) => b.score - a.score).slice(0, max);
}

export type ToolErrorKind =
  | "unknown_tool"
  | "timeout"
  | "rate_limited"
  | "transient_network"
  | "permission_denied"
  | "data_not_found"
  | "model_output_invalid"
  | "tool_runtime_error";

export const MAX_REPEATED_TOOL_CALLS = 2;
export const TOOL_RETRY_ATTEMPTS = 1;

function errorNameOf(error: unknown): string {
  if (error instanceof Error) return error.name;
  if (typeof error === "object" && error !== null) {
    const name = (error as { name?: unknown }).name;
    return typeof name === "string" ? name : "";
  }
  return "";
}

function errorTextChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (current instanceof Error) {
      parts.push(current.name, current.message);
      current = (current as Error & { cause?: unknown }).cause;
    } else if (typeof current === "object" && current !== null) {
      const message = (current as { message?: unknown }).message;
      parts.push(typeof message === "string" ? message : String(current));
      break;
    } else {
      if (current !== undefined && current !== null)
        parts.push(String(current));
      break;
    }
  }
  return parts.join(" ").toLowerCase();
}

export function classifyToolError(error: unknown): ToolErrorKind {
  const name = errorNameOf(error);
  if (name === "AbortError" || name === "TimeoutError") return "timeout";
  const text = errorTextChain(error);
  const has = (...tokens: string[]) =>
    tokens.some((token) => text.includes(token));
  if (has("timeout", "timed out", "deadline", "abort", "etimedout")) {
    return "timeout";
  }
  if (has("rate limit", "rate_limit", "429", "too many requests")) {
    return "rate_limited";
  }
  if (
    has(
      "fetch failed",
      "econnreset",
      "econnrefused",
      "enotfound",
      "enetunreach",
      "esockettimedout",
      "socket hang up",
      "reset by peer",
      "connection",
      "temporarily unavailable",
      "service unavailable",
      "upstream connect",
      "502",
      "503",
      "504",
    )
  ) {
    return "transient_network";
  }
  if (has("permission", "forbidden", "unauthorized", "401", "403")) {
    return "permission_denied";
  }
  if (has("not found", "missing", "404")) return "data_not_found";
  if (has("validation", "schema", "json", "parse")) {
    return "model_output_invalid";
  }
  return "tool_runtime_error";
}

export function isRetriableToolError(kind: ToolErrorKind): boolean {
  return (
    kind === "timeout" ||
    kind === "rate_limited" ||
    kind === "transient_network"
  );
}

export type ToolRetryOutcome<T> =
  | { ok: true; value: T; attempts: number }
  | {
      ok: false;
      error: unknown;
      errorKind: ToolErrorKind;
      retryable: boolean;
      attempts: number;
    };

export async function executeWithRetry<T>(
  run: () => PromiseLike<T>,
  maxRetries: number = TOOL_RETRY_ATTEMPTS,
): Promise<ToolRetryOutcome<T>> {
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      return { ok: true, value: await run(), attempts };
    } catch (error) {
      const errorKind = classifyToolError(error);
      const retryable = isRetriableToolError(errorKind);
      if (!retryable || attempts > maxRetries) {
        return { ok: false, error, errorKind, retryable, attempts };
      }
    }
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, canonicalize(v)]);
    return Object.fromEntries(entries);
  }
  if (typeof value === "bigint") return Number(value);
  return value;
}

export function toolCallFingerprint(name: string, input: unknown): string {
  return `${name}:${JSON.stringify(canonicalize(input) ?? null)}`;
}

export interface LoopGuardVerdict {
  fingerprint: string;
  repeatCount: number;
  blocked: boolean;
}

export class ToolLoopGuard {
  private readonly counts = new Map<string, number>();
  private readonly maxRepeated: number;

  constructor(maxRepeated: number = MAX_REPEATED_TOOL_CALLS) {
    this.maxRepeated = maxRepeated;
  }

  check(name: string, input: unknown): LoopGuardVerdict {
    const fingerprint = toolCallFingerprint(name, input);
    const repeatCount = (this.counts.get(fingerprint) ?? 0) + 1;
    this.counts.set(fingerprint, repeatCount);
    return {
      fingerprint,
      repeatCount,
      blocked: repeatCount > this.maxRepeated,
    };
  }
}

export function duplicateCallObservation(
  name: string,
  verdict: LoopGuardVerdict,
): Record<string, unknown> {
  return {
    route: "tool_loop_guard",
    blocked: true,
    duplicate: true,
    tool: name,
    repeat_count: verdict.repeatCount,
    fingerprint: verdict.fingerprint,
    answer:
      `Duplicate call blocked: ${name} was already called ` +
      `${verdict.repeatCount - 1} time(s) with identical arguments. ` +
      "Do not repeat this call; answer from the existing results or choose a " +
      "different lookup path.",
  };
}

export function toolErrorObservation(
  name: string,
  outcome: Extract<ToolRetryOutcome<unknown>, { ok: false }>,
): Record<string, unknown> {
  const errorText =
    outcome.error instanceof Error
      ? outcome.error.message
      : String(outcome.error);
  return {
    route: "tool_error",
    error: true,
    tool: name,
    answer: `Tool ${name} failed: ${errorText}`,
    error_kind: outcome.errorKind,
    retryable: outcome.retryable,
    attempts: outcome.attempts,
  };
}

export function buildEmptyAnswerFallback(input: {
  toolNames: readonly string[];
  withToolsTemplate: string;
  noToolsTemplate: string;
}): string {
  const unique: string[] = [];
  for (const name of input.toolNames) {
    if (!unique.includes(name)) unique.push(name);
  }
  if (unique.length === 0) return input.noToolsTemplate;
  return input.withToolsTemplate.replaceAll("{tools}", unique.join(", "));
}

export function isContextOverflowError(error: unknown): boolean {
  const message = errorTextChain(error);
  const markers = [
    "context_length_exceeded",
    "maximum context length",
    "prompt is too long",
    "prompt too long",
    "context window",
    "too many tokens",
    "request too large",
  ];
  return markers.some((marker) => message.includes(marker));
}

function buildTools(
  repo: Repository,
  conversationId: string,
  citations: ChatCitation[],
): Record<string, Tool> {
  const repoId = repo.id;
  return {
    list_issues: tool({
      description:
        "List synced GitHub issues of the repository. Optionally filter by state (open/closed/all).",
      inputSchema: z.object({
        state: z.enum(["open", "closed", "all"]).default("all"),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      execute: async ({ state, limit }) => {
        const issues = await prisma.issue.findMany({
          where: { repoId, ...(state !== "all" ? { state } : {}) },
          orderBy: { githubUpdatedAt: "desc" },
          take: limit,
          select: {
            number: true,
            title: true,
            state: true,
            labels: true,
            author: true,
            assignees: true,
            githubUpdatedAt: true,
          },
        });
        return pack({ count: issues.length, issues });
      },
    }),
    get_issue: tool({
      description:
        "Get one synced GitHub issue by number, including its full body and labels.",
      inputSchema: z.object({ number: z.number().int() }),
      execute: async ({ number }) => {
        const issue = await prisma.issue.findFirst({
          where: { repoId, number },
        });
        if (!issue)
          return pack({
            error: `Issue #${number} not found — sync the repository first.`,
          });
        return pack({
          number: issue.number,
          title: issue.title,
          state: issue.state,
          labels: issue.labels,
          author: issue.author,
          assignees: issue.assignees,
          body: clipBody(issue.body, 6000),
          created_at: issue.githubCreatedAt,
          updated_at: issue.githubUpdatedAt,
        });
      },
    }),
    list_pulls: tool({
      description:
        "List synced pull requests of the repository. Optionally filter by state (open/closed/merged/all).",
      inputSchema: z.object({
        state: z.enum(["open", "closed", "merged", "all"]).default("all"),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      execute: async ({ state, limit }) => {
        const pulls = await prisma.pullRequest.findMany({
          where: { repoId, ...(state !== "all" ? { state } : {}) },
          orderBy: { githubUpdatedAt: "desc" },
          take: limit,
          select: {
            number: true,
            title: true,
            state: true,
            author: true,
            baseBranch: true,
            headBranch: true,
            additions: true,
            deletions: true,
            changedFiles: true,
            githubUpdatedAt: true,
          },
        });
        return pack({ count: pulls.length, pulls });
      },
    }),
    get_pull: tool({
      description:
        "Get one synced pull request by number, including changed files and review comments.",
      inputSchema: z.object({ number: z.number().int() }),
      execute: async ({ number }) => {
        const pr = await prisma.pullRequest.findFirst({
          where: { repoId, number },
          include: { files: true, reviewComments: true },
        });
        if (!pr)
          return pack({
            error: `PR #${number} not found — sync the repository first.`,
          });
        return pack({
          number: pr.number,
          title: pr.title,
          state: pr.state,
          author: pr.author,
          base_branch: pr.baseBranch,
          head_branch: pr.headBranch,
          body: clipBody(pr.body, 4000),
          files: pr.files.slice(0, 60).map((f) => ({
            filename: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            patch: f.patch ? clipBody(f.patch, 1500) : null,
          })),
          review_comments: pr.reviewComments.slice(0, 30).map((c) => ({
            author: c.author,
            path: c.path,
            line: c.line,
            body: clipBody(c.body, 600),
          })),
        });
      },
    }),
    list_ci_runs: tool({
      description:
        "List recent GitHub Actions workflow runs of the repository with status and conclusion.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(30).default(15),
      }),
      execute: async ({ limit }) => {
        const runs = await prisma.workflowRun.findMany({
          where: { repoId },
          orderBy: { githubCreatedAt: "desc" },
          take: limit,
          select: {
            id: true,
            name: true,
            headBranch: true,
            status: true,
            conclusion: true,
            htmlUrl: true,
            githubCreatedAt: true,
          },
        });
        return pack({ count: runs.length, runs });
      },
    }),
    get_ci_run: tool({
      description:
        "Get one workflow run's jobs/steps and failed-job logs. Pass runId from list_ci_runs; when omitted, the most recent FAILED run is used.",
      inputSchema: z.object({ runId: z.string().optional() }),
      execute: async ({ runId }) => {
        const run = runId
          ? await prisma.workflowRun.findFirst({ where: { id: runId, repoId } })
          : await prisma.workflowRun.findFirst({
              where: { repoId, conclusion: "failure" },
              orderBy: { githubCreatedAt: "desc" },
            });
        if (!run) return pack({ error: "No matching workflow run found." });
        return pack({
          name: run.name,
          head_branch: run.headBranch,
          status: run.status,
          conclusion: run.conclusion,
          html_url: run.htmlUrl,
          jobs: run.jobs,
          failed_logs: run.logsText ? clipBody(run.logsText, 20_000) : null,
        });
      },
    }),
    search_knowledge: tool({
      description:
        "Semantic search over the repository's knowledge base (uploaded docs and generated weekly reports).",
      inputSchema: z.object({
        query: z.string().min(1),
        topK: z.number().int().min(1).max(10).default(5),
      }),
      execute: async ({ query, topK }) => {
        const hits = await searchKnowledge(repoId, query, topK);
        citations.push(...knowledgeCitations(hits));
        return pack({
          count: hits.length,
          hits: hits.map((h) => ({
            document: h.docName,
            score: Number(h.score.toFixed(4)),
            content: clipBody(h.content, 1200),
          })),
        });
      },
    }),
    create_action_draft: tool({
      description:
        "Create a GitHub action draft that requires human confirmation before execution. Use for commenting on issues/PRs, creating issues, closing issues, or adding labels. NEVER claims the action was performed.",
      inputSchema: z.object({
        draftType: z.enum([
          "issue_comment",
          "create_issue",
          "close_issue",
          "add_labels",
        ]),
        targetType: z.enum(["issue", "pull_request"]).optional(),
        targetNumber: z.number().int().positive().optional(),
        title: z.string().max(300).optional(),
        content: z.string().max(20000).optional(),
        labels: z.array(z.string()).max(20).optional(),
        riskLevel: z.enum(["low", "medium", "high"]).default("medium"),
      }),
      execute: async (input) => {
        const draft = await prisma.actionDraft.create({
          data: {
            repoId,
            draftType: input.draftType,
            targetType: input.targetType ?? null,
            targetNumber: input.targetNumber ?? null,
            title: input.title ?? "",
            content: input.content ?? "",
            labels: input.labels ?? [],
            riskLevel: input.riskLevel,
            status: "pending_confirmation",
          },
        });
        return pack({
          draft_id: draft.id,
          status: draft.status,
          note: "Draft created. It will only be executed after a human confirms it on the Action Drafts page.",
        });
      },
    }),
    workspace_list_files: tool({
      description:
        "List files and directories in the repository's cloned source checkout. Read-only. Requires the code to be cloned first (Code page). Pass path='.' for the root.",
      inputSchema: z.object({
        path: z.string().default("."),
        limit: z.number().int().min(1).max(500).default(200),
      }),
      execute: async ({ path: relPath, limit }) => {
        try {
          const checkout = await requireCheckout(repo);
          const entries = await listFiles(checkout, relPath, limit);
          return pack({ count: entries.length, entries });
        } catch (e) {
          return pack({ error: e instanceof Error ? e.message : String(e) });
        }
      },
    }),
    workspace_read_file: tool({
      description:
        "Read a text file from the repository's cloned checkout. Read-only; refuses binaries and secret files (.env, .npmrc). Optionally pass startLine + lineCount for an excerpt.",
      inputSchema: z.object({
        path: z.string().min(1),
        startLine: z.number().int().min(1).optional(),
        lineCount: z.number().int().min(1).max(2000).optional(),
      }),
      execute: async ({ path: relPath, startLine, lineCount }) => {
        try {
          const checkout = await requireCheckout(repo);
          const file = await readCodeFile(checkout, relPath, {
            startLine,
            lineCount,
          });
          return pack(file);
        } catch (e) {
          return pack({ error: e instanceof Error ? e.message : String(e) });
        }
      },
    }),
    workspace_search_code: tool({
      description:
        "Lexical (keyword) search over the CURRENT source/docs in the repository's cloned checkout. Read-only. Returns the best matching line per file. Use to find where a symbol, string, or config key is used in the actual code.",
      inputSchema: z.object({
        query: z.string().min(1),
        path: z.string().optional(),
        limit: z.number().int().min(1).max(50).default(12),
      }),
      execute: async ({ query, path: relPath, limit }) => {
        try {
          const checkout = await requireCheckout(repo);
          const hits = await searchCode(checkout, query, relPath, limit);
          return pack({ count: hits.length, hits });
        } catch (e) {
          return pack({ error: e instanceof Error ? e.message : String(e) });
        }
      },
    }),
    search_project_docs: tool({
      description:
        "Semantic search over the repository's indexed project docs (README, manifests, docs/). Requires the project index to be built (Code page). Use for conceptual 'how does this project work / what stack is it' questions.",
      inputSchema: z.object({
        query: z.string().min(1),
        topK: z.number().int().min(1).max(10).default(5),
      }),
      execute: async ({ query, topK }) => {
        try {
          const hits = await searchProjectDocs(repoId, query, topK);
          citations.push(...projectDocCitations(hits));
          return pack({
            count: hits.length,
            hits: hits.map((h) => ({
              path: h.path,
              source_type: h.sourceType,
              score: Number(h.score.toFixed(4)),
              content: h.content.slice(0, 1200),
            })),
          });
        } catch (e) {
          return pack({ error: e instanceof Error ? e.message : String(e) });
        }
      },
    }),
    memory_recall: tool({
      description:
        "Recall persisted memory for this repository: the long-term thread summary plus the current conversation's decisions, open questions and tasks. Use when the user refers to earlier work or the request context is ambiguous.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const context = await buildMemoryContext(repoId, conversationId);
          return (
            context || "No persisted memory exists for this repository yet."
          );
        } catch (e) {
          return pack({ error: e instanceof Error ? e.message : String(e) });
        }
      },
    }),
    memory_propose: tool({
      description:
        "Propose a memory candidate (decision / fact / task / preference / repo_context) for human review. Approved candidates become knowledge-base memory notes. The candidate stays pending until a human approves it on the Chat page; never claim the memory is already saved.",
      inputSchema: z.object({
        kind: z.enum(MEMORY_CANDIDATE_KINDS),
        title: z.string().max(200).optional(),
        content: z.string().min(1).max(4000),
      }),
      execute: async ({ kind, title, content }) => {
        try {
          const result = await proposeMemoryCandidate({
            repoId,
            conversationId,
            kind,
            title,
            content,
            origin: "chat_agent",
          });
          return pack({
            candidate_id: result.candidate.id,
            status: result.candidate.status,
            deduped: result.deduped,
            note: "Candidate is pending human approval; it joins the knowledge base only after approval on the Chat page memory panel.",
          });
        } catch (e) {
          return pack({ error: e instanceof Error ? e.message : String(e) });
        }
      },
    }),
  };
}

const HISTORY_LIMIT = 20;
export const HISTORY_RETRY_LIMIT = 8;

function resilientTools(
  tools: Record<string, Tool>,
  guard: ToolLoopGuard,
): Record<string, Tool> {
  const decorated: Record<string, Tool> = {};
  for (const [name, definition] of Object.entries(tools)) {
    const execute = definition.execute;
    if (!execute) {
      decorated[name] = definition;
      continue;
    }
    decorated[name] = {
      ...definition,
      execute: async (
        input: unknown,
        options: ToolExecutionOptions<unknown>,
      ): Promise<unknown> => {
        const verdict = guard.check(name, input);
        if (verdict.blocked)
          return pack(duplicateCallObservation(name, verdict));
        const outcome = await executeWithRetry(() => execute(input, options));
        if (outcome.ok) return outcome.value;
        return pack(toolErrorObservation(name, outcome));
      },
    };
  }
  return decorated;
}

interface AttemptResult {
  assistantText: string;
  toolTrace: Array<{ name: string; input?: unknown }>;
  citations: ChatCitation[];
  streamError?: unknown;
}

async function* streamAssistantAttempt(params: {
  repo: Repository;
  conversationId: string;
  excludeMessageId: string;
  system: string;
  message: string;
  historyLimit: number;
  guard: ToolLoopGuard;
}): AsyncGenerator<DevflowChatEvent, AttemptResult, void> {
  const prior = await listMessages(params.conversationId, params.historyLimit);
  const history: ModelMessage[] = [
    ...prior
      .filter((m) => m.id !== params.excludeMessageId)
      .map(
        (m) =>
          ({
            role: m.role as "user" | "assistant",
            content: m.content,
          }) satisfies ModelMessage,
      ),
    { role: "user", content: params.message } satisfies ModelMessage,
  ];

  let streamError: unknown;
  const toolTrace: Array<{ name: string; input?: unknown }> = [];
  const citations: ChatCitation[] = [];
  let assistantText = "";
  const result = streamText({
    model: quickModel,
    system: params.system,
    messages: history,
    tools: resilientTools(
      buildTools(params.repo, params.conversationId, citations),
      params.guard,
    ),
    stopWhen: isStepCount(12),
    providerOptions,
    onError: ({ error }) => {
      streamError = error;
    },
  });

  for await (const part of result.fullStream) {
    if (part.type === "text-delta") {
      assistantText += part.text;
      yield { type: "text", content: part.text };
    } else if (part.type === "tool-call") {
      toolTrace.push({ name: part.toolName, input: part.input });
      yield {
        type: "tool",
        name: part.toolName,
        state: "call",
        input: part.input,
      };
    } else if (part.type === "tool-result") {
      yield { type: "tool", name: part.toolName, state: "result" };
    }
  }

  if (streamError !== undefined) {
    return { assistantText, toolTrace, citations, streamError };
  }
  return { assistantText, toolTrace, citations };
}

export async function* devflowChatStream(
  repoId: string,
  input: { conversationId?: string; message: string },
): AsyncGenerator<DevflowChatEvent> {
  const repo = await prisma.repository.findUnique({ where: { id: repoId } });
  if (!repo) throw new Error(`Repository ${repoId} not found`);

  const conversation = await ensureConversation(repoId, input.conversationId);
  const userMessage = await appendMessage({
    conversationId: conversation.id,
    repoId,
    role: "user",
    content: input.message,
  });

  let system = `${DEVFLOW_CHAT_SYSTEM_PROMPT}\n\nCurrent repository: ${repo.fullName} (${repo.owner}/${repo.name})${repo.description ? `\nDescription: ${repo.description}` : ""}`;

  try {
    const memoryContext = await buildMemoryContext(repoId, conversation.id);
    if (memoryContext) system += `\n\n${memoryContext}`;
  } catch {}

  try {
    const registry = await getSkillRegistry();
    if (registry.listSkills().length > 0) {
      system += `\n\n## Registered DevFlow skills\n${registry.promptContext()}`;
      const activations = await registry.activate(input.message);
      const block = SkillRegistry.renderPromptBlock(activations);
      if (block !== "") {
        system += `\n\n# Active skill instructions for this turn\n${block}`;
      }
    }
  } catch {}

  const t = await getTranslations("api.devflow");
  const guard = new ToolLoopGuard();
  const attemptParams = {
    repo,
    conversationId: conversation.id,
    excludeMessageId: userMessage.id,
    system,
    message: input.message,
    guard,
  };

  let result = yield* streamAssistantAttempt({
    ...attemptParams,
    historyLimit: HISTORY_LIMIT,
  });

  if (
    result.streamError !== undefined &&
    isContextOverflowError(result.streamError) &&
    result.assistantText === "" &&
    result.toolTrace.length === 0
  ) {
    result = yield* streamAssistantAttempt({
      ...attemptParams,
      historyLimit: HISTORY_RETRY_LIMIT,
    });
  }

  if (result.streamError !== undefined) {
    const reason =
      result.streamError instanceof Error
        ? result.streamError.message
        : String(result.streamError);
    const note = t("chatTurnFailed", { message: reason });
    const content = result.assistantText.trim()
      ? `${result.assistantText}\n\n${note}`
      : note;
    const assistantMessage = await appendMessage({
      conversationId: conversation.id,
      repoId,
      role: "assistant",
      content,
      toolCalls: result.toolTrace,
      meta: { error: true, reason },
    });
    yield {
      type: "error",
      message: content,
      assistantMessageId: assistantMessage.id,
    };
    void maybeSealAndMerge(repoId, conversation.id).catch(() => {});
    return;
  }

  let content = result.assistantText;
  if (!content.trim()) {
    content = buildEmptyAnswerFallback({
      toolNames: result.toolTrace.map((call) => call.name),
      withToolsTemplate: t.raw("chatEmptyAnswerWithTools"),
      noToolsTemplate: t("chatEmptyAnswerNoTools"),
    });
    yield { type: "text", content };
  }

  const citations = dedupeCitations(result.citations);

  const assistantMessage = await appendMessage({
    conversationId: conversation.id,
    repoId,
    role: "assistant",
    content,
    toolCalls: result.toolTrace,
    ...(citations.length > 0 ? { meta: { citations } } : {}),
  });

  yield {
    type: "done",
    conversationId: conversation.id,
    userMessageId: userMessage.id,
    assistantMessageId: assistantMessage.id,
    citations,
  };

  void maybeSealAndMerge(repoId, conversation.id).catch(() => {});
}
