import { generateText } from "ai";
import { prisma } from "@/lib/db";
import { thinkModel, providerOptions } from "@/lib/ai/models";
import { observeGeneration } from "@/lib/observability";
import { addKnowledgeDocument } from "@/lib/devflow/rag";
import { llmConfigured, type GenerationMode } from "./analysis";
import { WEEKLY_REPORT_PROMPT } from "./prompts";

export interface WeeklyReportInput {
  repoId: string;
  startDate: string;
  endDate: string;
}

export interface WeeklyReportMetrics {
  issues: number;
  pullRequests: number;
  mergedPrs: number;
  openPrs: number;
  failedCi: number;
  closedIssues: number;
  totalRuns: number;
}

export interface WeeklyReportResult {
  reportMarkdown: string;
  metrics: WeeklyReportMetrics;
  knowledgeDocId: string | null;
  generationMode: GenerationMode;
}

const SAMPLE_LIMIT = 100;

function rangeBounds(
  startDate: string,
  endDate: string,
): { start: Date; end: Date } {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T23:59:59.999Z`);
  return { start, end };
}

export interface WeeklyReportTemplateInput {
  repoName: string;
  startDate: string;
  endDate: string;
  metrics: WeeklyReportMetrics;
  sampleTruncated: boolean;
  mergedPrNumbers: number[];
  closedIssueNumbers: number[];
  openPrs: Array<{ number: number; title: string }>;
  prsForAttention: Array<{ number: number; title: string }>;
  failedRuns: Array<{ name: string; conclusion: string | null }>;
  repeatFailWorkflows: Array<{ name: string; count: number }>;
}

export function deterministicWeeklyReport(
  input: WeeklyReportTemplateInput,
): string {
  const { metrics } = input;
  const mergedPrNumbers =
    input.mergedPrNumbers.map((n) => `#${n}`).join(", ") || "none";
  const closedIssueNumbers =
    input.closedIssueNumbers.map((n) => `#${n}`).join(", ") || "none";
  const sampleNote = input.sampleTruncated
    ? "\n\n> Lists below show the most recent items only; the counts are exact for the full range.\n"
    : "";

  const lines = [
    `# ${input.repoName} engineering weekly report`,
    ``,
    `> Range: ${input.startDate} to ${input.endDate}`,
    ``,
    `## Overview`,
    `- Issues: ${metrics.issues} in range (${metrics.closedIssues} closed)`,
    `- PRs: ${metrics.pullRequests} in range, ${metrics.mergedPrs} merged, ${metrics.openPrs} open`,
    `- Failed CI: ${metrics.failedCi} of ${metrics.totalRuns} runs`,
    ``,
    `## Completed`,
    `- Merged ${metrics.mergedPrs} PR(s): ${mergedPrNumbers}.`,
    `- Closed ${metrics.closedIssues} issue(s): ${closedIssueNumbers}.`,
    ``,
    `## In progress`,
    `- ${metrics.openPrs} open PR(s) still need follow-up.`,
    ...input.openPrs.map((pr) => `- #${pr.number} ${pr.title}`),
    ...(input.openPrs.length === 0 ? ["- No open PRs."] : []),
    ``,
    `## Risks and blockers`,
    `- ${metrics.failedCi} failed CI run(s); prioritize the repeatedly failing workflows.`,
    ...input.repeatFailWorkflows
      .slice(0, 3)
      .map(
        (row) =>
          `- Workflow "${row.name}" failed ${row.count} time(s) in range.`,
      ),
    ...(input.failedRuns.length === 0
      ? ["- No failed CI was synced for this period."]
      : []),
    ``,
    `## PRs needing attention`,
    ...input.prsForAttention.map((pr) => `- #${pr.number} ${pr.title}`),
    ``,
    `## Failed CI`,
    ...input.failedRuns
      .slice(0, 5)
      .map((run) => `- ${run.name}: ${run.conclusion ?? "failure"}`),
    ``,
    `## Suggestions for next week`,
    `- Add test coverage for the key modules.`,
    `- Split high-risk PRs for early review.`,
  ];
  return lines.join("\n") + sampleNote;
}

export async function generateWeeklyReport(
  input: WeeklyReportInput,
): Promise<WeeklyReportResult> {
  const repo = await prisma.repository.findUnique({
    where: { id: input.repoId },
  });
  if (!repo) throw new Error(`Repository ${input.repoId} not found`);

  const { start, end } = rangeBounds(input.startDate, input.endDate);

  const issueRangeWhere = {
    repoId: input.repoId,
    OR: [
      { githubCreatedAt: { gte: start, lte: end } },
      { githubUpdatedAt: { gte: start, lte: end } },
      { githubClosedAt: { gte: start, lte: end } },
    ],
  };
  const prRangeWhere = {
    repoId: input.repoId,
    OR: [
      { githubCreatedAt: { gte: start, lte: end } },
      { githubUpdatedAt: { gte: start, lte: end } },
      { mergedAt: { gte: start, lte: end } },
    ],
  };
  const runRangeWhere = {
    repoId: input.repoId,
    OR: [
      { githubCreatedAt: { gte: start, lte: end } },
      { githubUpdatedAt: { gte: start, lte: end } },
    ],
  };

  const [
    issuesTotal,
    closedIssuesTotal,
    prsTotal,
    mergedPrsTotal,
    openPrsTotal,
    runsTotal,
    failedCiTotal,
  ] = await Promise.all([
    prisma.issue.count({ where: issueRangeWhere }),
    prisma.issue.count({ where: { ...issueRangeWhere, state: "closed" } }),
    prisma.pullRequest.count({ where: prRangeWhere }),
    prisma.pullRequest.count({
      where: { ...prRangeWhere, mergedAt: { not: null } },
    }),
    prisma.pullRequest.count({ where: { ...prRangeWhere, state: "open" } }),
    prisma.workflowRun.count({ where: runRangeWhere }),
    prisma.workflowRun.count({
      where: { ...runRangeWhere, conclusion: "failure" },
    }),
  ]);

  const metrics: WeeklyReportMetrics = {
    issues: issuesTotal,
    pullRequests: prsTotal,
    mergedPrs: mergedPrsTotal,
    openPrs: openPrsTotal,
    failedCi: failedCiTotal,
    closedIssues: closedIssuesTotal,
    totalRuns: runsTotal,
  };

  const [
    issues,
    prs,
    runs,
    mergedRows,
    closedRows,
    openRows,
    attentionRows,
    failedRunRows,
  ] = await Promise.all([
    prisma.issue.findMany({
      where: issueRangeWhere,
      orderBy: { githubUpdatedAt: "desc" },
      take: SAMPLE_LIMIT,
      select: {
        number: true,
        title: true,
        state: true,
        labels: true,
        author: true,
        githubClosedAt: true,
      },
    }),
    prisma.pullRequest.findMany({
      where: prRangeWhere,
      orderBy: { githubUpdatedAt: "desc" },
      take: SAMPLE_LIMIT,
      select: {
        number: true,
        title: true,
        state: true,
        author: true,
        mergedAt: true,
        additions: true,
        deletions: true,
      },
    }),
    prisma.workflowRun.findMany({
      where: runRangeWhere,
      orderBy: { githubCreatedAt: "desc" },
      take: SAMPLE_LIMIT,
      select: { name: true, headBranch: true, status: true, conclusion: true },
    }),
    prisma.pullRequest.findMany({
      where: { ...prRangeWhere, mergedAt: { not: null } },
      orderBy: { mergedAt: "desc" },
      take: 8,
      select: { number: true },
    }),
    prisma.issue.findMany({
      where: { ...issueRangeWhere, state: "closed" },
      orderBy: { githubClosedAt: "desc" },
      select: { number: true },
      take: 8,
    }),
    prisma.pullRequest.findMany({
      where: { ...prRangeWhere, state: "open" },
      orderBy: { githubUpdatedAt: "desc" },
      take: 5,
      select: { number: true, title: true },
    }),
    prisma.pullRequest.findMany({
      where: prRangeWhere,
      orderBy: { githubUpdatedAt: "desc" },
      take: 5,
      select: { number: true, title: true },
    }),
    prisma.workflowRun.findMany({
      where: { ...runRangeWhere, conclusion: "failure" },
      orderBy: { githubCreatedAt: "desc" },
      take: 5,
      select: { name: true, conclusion: true },
    }),
  ]);

  const failedGroupRows = await prisma.workflowRun.groupBy({
    by: ["name"],
    where: { ...runRangeWhere, conclusion: "failure" },
    _count: { _all: true },
  });
  const repeatFailWorkflows = failedGroupRows
    .map((row) => ({ name: row.name, count: row._count._all }))
    .sort((a, b) => b.count - a.count);

  const sampleTruncated =
    issuesTotal > SAMPLE_LIMIT ||
    prsTotal > SAMPLE_LIMIT ||
    runsTotal > SAMPLE_LIMIT;

  const templateInput: WeeklyReportTemplateInput = {
    repoName: repo.fullName,
    startDate: input.startDate,
    endDate: input.endDate,
    metrics,
    sampleTruncated,
    mergedPrNumbers: mergedRows.map((row) => row.number),
    closedIssueNumbers: closedRows.map((row) => row.number),
    openPrs: openRows.map((row) => ({ number: row.number, title: row.title })),
    prsForAttention: attentionRows.map((row) => ({
      number: row.number,
      title: row.title,
    })),
    failedRuns: failedRunRows.map((run) => ({
      name: run.name,
      conclusion: run.conclusion,
    })),
    repeatFailWorkflows,
  };

  const payload = {
    repo: repo.fullName,
    range: { start_date: input.startDate, end_date: input.endDate },
    metrics,
    sample_truncated: sampleTruncated,
    issues: issues.map((i) => ({
      number: i.number,
      title: i.title,
      state: i.state,
      labels: i.labels,
      author: i.author,
      closed_at: i.githubClosedAt,
    })),
    pull_requests: prs.map((p) => ({
      number: p.number,
      title: p.title,
      state: p.state,
      author: p.author,
      merged_at: p.mergedAt,
      additions: p.additions,
      deletions: p.deletions,
    })),
    workflow_runs: runs.map((r) => ({
      name: r.name,
      head_branch: r.headBranch,
      status: r.status,
      conclusion: r.conclusion,
    })),
  };

  let reportMarkdown: string;
  let generationMode: GenerationMode = "deterministic";
  if (llmConfigured()) {
    try {
      const text = await observeGeneration(
        "devflow-weekly-report",
        async (generation) => {
          const res = await generateText({
            model: thinkModel,
            system: WEEKLY_REPORT_PROMPT,
            prompt: JSON.stringify(payload, null, 2),
            providerOptions,
          });
          generation?.update({
            input: JSON.stringify(payload),
            output: res.text,
          });
          return res.text;
        },
      );
      if (text.trim().length > 0) {
        reportMarkdown = text;
        generationMode = "llm";
      } else {
        reportMarkdown = deterministicWeeklyReport(templateInput);
      }
    } catch (e) {
      console.warn(
        "[devflow-report] LLM report failed; persisting deterministic template:",
        e,
      );
      reportMarkdown = deterministicWeeklyReport(templateInput);
    }
  } else {
    reportMarkdown = deterministicWeeklyReport(templateInput);
  }

  let knowledgeDocId: string | null = null;
  try {
    const added = await addKnowledgeDocument({
      repoId: input.repoId,
      name: `Weekly Report ${input.startDate} → ${input.endDate}`,
      content: reportMarkdown,
      sourceType: "weekly_report",
    });
    knowledgeDocId = added.docId;
  } catch (e) {
    console.error("[devflow-report] knowledge indexing failed:", e);
  }

  return { reportMarkdown, metrics, knowledgeDocId, generationMode };
}
