// DevFlow Chat Agent: native tool calling over one repository's synced data.
// Port of the Python ChatAgent's tool surface (issues / PRs / CI / knowledge /
// workspace-style queries / safe action drafts) onto AI SDK v7 streamText.
import {
  streamText,
  tool,
  isStepCount,
  type Tool,
  type ModelMessage,
} from "ai";
import { z } from "zod/v4";
import { prisma } from "@/lib/db";
import { quickModel, providerOptions } from "@/lib/ai/models";
import { searchKnowledge } from "../rag";
import {
  listFiles,
  readCodeFile,
  requireCheckout,
  searchCode,
} from "../workspace";
import { searchProjectDocs } from "../project-index";
import {
  appendMessage,
  ensureConversation,
  listMessages,
} from "../conversations";
import { DEVFLOW_CHAT_SYSTEM_PROMPT } from "./prompts";
import type { Repository } from "@/generated/prisma/client";

export type DevflowChatEvent =
  | { type: "text"; content: string }
  | { type: "tool"; name: string; state: "call" | "result"; input?: unknown }
  | {
      type: "done";
      conversationId: string;
      userMessageId: string;
      assistantMessageId: string;
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

// Build the repository-scoped tool set. Every tool reads from the synced
// PostgreSQL data; the only write path is create_action_draft, which produces
// a pending draft that requires human confirmation before touching GitHub.
function buildTools(repo: Repository): Record<string, Tool> {
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
  };
}

const HISTORY_LIMIT = 20;

// Stream one DevFlow chat turn. Persists the user message, streams the
// assistant answer, then persists it (with its tool trace) so conversations are
// durable server-side and each answer can be rated. The `done` event carries
// the ids the client needs to attach feedback.
export async function* devflowChatStream(
  repoId: string,
  input: { conversationId?: string; message: string },
): AsyncGenerator<DevflowChatEvent> {
  const repo = await prisma.repository.findUnique({ where: { id: repoId } });
  if (!repo) throw new Error(`Repository ${repoId} not found`);

  const conversation = await ensureConversation(repoId, input.conversationId);
  const prior = await listMessages(conversation.id, HISTORY_LIMIT);
  const userMessage = await appendMessage({
    conversationId: conversation.id,
    repoId,
    role: "user",
    content: input.message,
  });

  const system = `${DEVFLOW_CHAT_SYSTEM_PROMPT}\n\nCurrent repository: ${repo.fullName} (${repo.owner}/${repo.name})${repo.description ? `\nDescription: ${repo.description}` : ""}`;

  const history: ModelMessage[] = [
    ...prior.map(
      (m) =>
        ({
          role: m.role as "user" | "assistant",
          content: m.content,
        }) satisfies ModelMessage,
    ),
    { role: "user", content: input.message } satisfies ModelMessage,
  ];

  let streamError: unknown;
  const toolTrace: Array<{ name: string; input?: unknown }> = [];
  let assistantText = "";
  const result = streamText({
    model: quickModel,
    system,
    messages: history,
    tools: buildTools(repo),
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
    throw streamError instanceof Error
      ? streamError
      : new Error(String(streamError));
  }

  const assistantMessage = await appendMessage({
    conversationId: conversation.id,
    repoId,
    role: "assistant",
    content: assistantText,
    toolCalls: toolTrace,
  });

  yield {
    type: "done",
    conversationId: conversation.id,
    userMessageId: userMessage.id,
    assistantMessageId: assistantMessage.id,
  };
}
