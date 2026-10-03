// DevFlow analysis agents: Issue Triage, PR Review, CI Debug.
// Each agent loads synced data from PostgreSQL, assembles a bounded context,
// runs one structured-output LLM call (AI SDK Output.object), and persists the
// result as an AnalysisResult row. Ports the Python issue_agent /
// pr_review_agent / ci_debug_agent behavior.
import { Output, generateText } from "ai";
import type { z } from "zod/v4";
import { prisma } from "@/lib/db";
import { thinkModel, providerOptions } from "@/lib/ai/models";
import { observeGeneration } from "@/lib/observability";
import {
  CIDebugSchema,
  IssueAnalysisSchema,
  PRReviewSchema,
  type CIDebug,
  type IssueAnalysis,
  type PRReview,
} from "@/lib/devflow/schemas";
import { searchKnowledge } from "@/lib/devflow/rag";
import {
  CI_DEBUG_PROMPT,
  ISSUE_ANALYSIS_PROMPT,
  PR_REVIEW_PROMPT,
} from "./prompts";

const BODY_CHARS = 6000;
const PATCH_CHARS_PER_FILE = 4000;
const PATCH_CHARS_TOTAL = 40_000;
const LOG_CHARS = 40_000;
const SIMILAR_ISSUES = 20;

function clip(text: string | null | undefined, max: number): string {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text;
}

async function saveAnalysis(input: {
  targetType: string;
  targetId: string;
  analysisType: string;
  inputSnapshot: unknown;
  result: unknown;
}): Promise<string> {
  const row = await prisma.analysisResult.create({
    data: {
      targetType: input.targetType,
      targetId: input.targetId,
      analysisType: input.analysisType,
      inputSnapshot: input.inputSnapshot as object,
      resultJson: input.result as object,
      modelName: modelId(),
    },
  });
  return row.id;
}

function modelId(): string {
  const model = thinkModel;
  if (typeof model === "string") return model;
  if ("modelId" in model && typeof model.modelId === "string") {
    return model.modelId;
  }
  return "unknown";
}

// Structured generation with one corrective retry. Some OpenAI-compatible
// gateways ignore the JSON-schema instruction on the first attempt and wrap
// the object in prose/fences; a stricter retry usually recovers. Mirrors the
// Python original's validate-then-fallback behavior.
async function generateStructured<T>(input: {
  name: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
}): Promise<T> {
  const runOnce = async (prompt: string) => {
    return observeGeneration(input.name, async (generation) => {
      const res = await generateText({
        model: thinkModel,
        system: input.system,
        prompt,
        output: Output.object({ schema: input.schema }),
        providerOptions,
      });
      generation?.update({ input: prompt, output: res.text });
      return res;
    });
  };

  let firstError: unknown;
  try {
    const res = await runOnce(input.prompt);
    if (res.output) return res.output;
    firstError = new Error("empty structured output");
  } catch (e) {
    firstError = e;
  }

  // Retry once with an explicit JSON-only reminder.
  const retryPrompt = `${input.prompt}\n\nIMPORTANT: respond with ONLY a JSON object that matches the required schema. No markdown, no code fences, no commentary.`;
  try {
    const res = await runOnce(retryPrompt);
    if (res.output) return res.output;
  } catch (e) {
    firstError = e;
  }
  throw new Error(
    `${input.name}: model did not produce schema-valid output (${
      firstError instanceof Error ? firstError.message : String(firstError)
    })`,
  );
}

export interface AnalysisRecord<T> {
  id: string;
  result: T;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Issue triage
// ---------------------------------------------------------------------------

export async function analyzeIssue(
  issueId: string,
): Promise<AnalysisRecord<IssueAnalysis>> {
  const issue = await prisma.issue.findUnique({
    where: { id: issueId },
    include: { repo: true },
  });
  if (!issue) throw new Error(`Issue ${issueId} not found`);

  // Duplicate candidates: recent issues from the same repo (the model judges
  // similarity from titles/bodies; only listed numbers may be referenced).
  const siblings = await prisma.issue.findMany({
    where: { repoId: issue.repoId, id: { not: issueId } },
    orderBy: { githubUpdatedAt: "desc" },
    take: SIMILAR_ISSUES,
    select: { number: true, title: true, body: true, state: true },
  });

  // Knowledge-base evidence scoped to the repository.
  let knowledge: Array<{ docName: string; snippet: string }> = [];
  try {
    const hits = await searchKnowledge(
      issue.repoId,
      `${issue.title}\n${clip(issue.body, 1000)}`,
      3,
    );
    knowledge = hits.map((h) => ({
      docName: h.docName,
      snippet: clip(h.content, 800),
    }));
  } catch {
    // KB retrieval is best-effort context; triage still works without it.
  }

  const input = {
    issue: {
      number: issue.number,
      title: issue.title,
      body: clip(issue.body, BODY_CHARS),
      state: issue.state,
      labels: issue.labels,
      author: issue.author,
      assignees: issue.assignees,
      created_at: issue.githubCreatedAt,
    },
    similar_issues: siblings.map((s) => ({
      number: s.number,
      title: s.title,
      state: s.state,
      body: clip(s.body, 600),
    })),
    knowledge_evidence: knowledge,
    team_members: issue.assignees,
  };

  const result = await generateStructured({
    name: "devflow-issue-analysis",
    system: ISSUE_ANALYSIS_PROMPT,
    prompt: JSON.stringify(input, null, 2),
    schema: IssueAnalysisSchema,
  });

  const id = await saveAnalysis({
    targetType: "issue",
    targetId: issueId,
    analysisType: "issue_analysis",
    inputSnapshot: { issue_number: issue.number, title: issue.title },
    result,
  });
  return { id, result, createdAt: new Date() };
}

// ---------------------------------------------------------------------------
// PR review
// ---------------------------------------------------------------------------

export async function reviewPull(
  prId: string,
): Promise<AnalysisRecord<PRReview>> {
  const pr = await prisma.pullRequest.findUnique({
    where: { id: prId },
    include: { repo: true, files: true, reviewComments: true },
  });
  if (!pr) throw new Error(`Pull request ${prId} not found`);

  let patchBudget = PATCH_CHARS_TOTAL;
  const files = pr.files.map((file) => {
    const patch = clip(file.patch, Math.min(PATCH_CHARS_PER_FILE, patchBudget));
    patchBudget = Math.max(0, patchBudget - patch.length);
    return {
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patch,
    };
  });

  const input = {
    pull_request: {
      number: pr.number,
      title: pr.title,
      body: clip(pr.body, BODY_CHARS),
      state: pr.state,
      author: pr.author,
      base_branch: pr.baseBranch,
      head_branch: pr.headBranch,
      additions: pr.additions,
      deletions: pr.deletions,
      changed_files: pr.changedFiles,
    },
    files,
    review_comments: pr.reviewComments.map((c) => ({
      author: c.author,
      path: c.path,
      line: c.line,
      body: clip(c.body, 800),
    })),
  };

  const result = await generateStructured({
    name: "devflow-pr-review",
    system: PR_REVIEW_PROMPT,
    prompt: JSON.stringify(input, null, 2),
    schema: PRReviewSchema,
  });

  const id = await saveAnalysis({
    targetType: "pull_request",
    targetId: prId,
    analysisType: "pr_review",
    inputSnapshot: { pr_number: pr.number, title: pr.title },
    result,
  });
  return { id, result, createdAt: new Date() };
}

// ---------------------------------------------------------------------------
// CI debug
// ---------------------------------------------------------------------------

export async function debugRun(
  runId: string,
): Promise<AnalysisRecord<CIDebug>> {
  const run = await prisma.workflowRun.findUnique({
    where: { id: runId },
    include: { repo: true },
  });
  if (!run) throw new Error(`Workflow run ${runId} not found`);

  const input = {
    workflow_run: {
      name: run.name,
      head_branch: run.headBranch,
      status: run.status,
      conclusion: run.conclusion,
      html_url: run.htmlUrl,
      created_at: run.githubCreatedAt,
    },
    jobs: run.jobs,
    failed_logs: clip(run.logsText, LOG_CHARS) || null,
  };

  const result = await generateStructured({
    name: "devflow-ci-debug",
    system: CI_DEBUG_PROMPT,
    prompt: JSON.stringify(input, null, 2),
    schema: CIDebugSchema,
  });

  const id = await saveAnalysis({
    targetType: "workflow_run",
    targetId: runId,
    analysisType: "ci_debug",
    inputSnapshot: { run_name: run.name, conclusion: run.conclusion },
    result,
  });
  return { id, result, createdAt: new Date() };
}

// Latest saved analysis for a target (used to show previous results).
export async function latestAnalysis(targetType: string, targetId: string) {
  return prisma.analysisResult.findFirst({
    where: { targetType, targetId },
    orderBy: { createdAt: "desc" },
  });
}
