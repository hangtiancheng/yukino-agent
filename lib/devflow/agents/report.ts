// Weekly engineering report agent. Port of the Python report_agent +
// /api/reports/weekly route: gathers issues/PRs/CI runs in a date range,
// generates a markdown report, and stores it in the repository knowledge base
// so later RAG queries can cite it.
import { generateText } from "ai";
import { prisma } from "@/lib/db";
import { thinkModel, providerOptions } from "@/lib/ai/models";
import { observeGeneration } from "@/lib/observability";
import { addKnowledgeDocument } from "@/lib/devflow/rag";
import { WEEKLY_REPORT_PROMPT } from "./prompts";

export interface WeeklyReportInput {
  repoId: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
}

export interface WeeklyReportResult {
  reportMarkdown: string;
  metrics: {
    issues: number;
    pullRequests: number;
    mergedPrs: number;
    openPrs: number;
    failedCi: number;
  };
  knowledgeDocId: string | null;
}

function rangeBounds(
  startDate: string,
  endDate: string,
): { start: Date; end: Date } {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T23:59:59.999Z`);
  return { start, end };
}

export async function generateWeeklyReport(
  input: WeeklyReportInput,
): Promise<WeeklyReportResult> {
  const repo = await prisma.repository.findUnique({
    where: { id: input.repoId },
  });
  if (!repo) throw new Error(`Repository ${input.repoId} not found`);

  const { start, end } = rangeBounds(input.startDate, input.endDate);

  const [issues, prs, runs] = await Promise.all([
    prisma.issue.findMany({
      where: {
        repoId: input.repoId,
        OR: [
          { githubCreatedAt: { gte: start, lte: end } },
          { githubUpdatedAt: { gte: start, lte: end } },
          { githubClosedAt: { gte: start, lte: end } },
        ],
      },
      orderBy: { githubUpdatedAt: "desc" },
      take: 100,
    }),
    prisma.pullRequest.findMany({
      where: {
        repoId: input.repoId,
        OR: [
          { githubCreatedAt: { gte: start, lte: end } },
          { githubUpdatedAt: { gte: start, lte: end } },
          { mergedAt: { gte: start, lte: end } },
        ],
      },
      orderBy: { githubUpdatedAt: "desc" },
      take: 100,
    }),
    prisma.workflowRun.findMany({
      where: {
        repoId: input.repoId,
        OR: [
          { githubCreatedAt: { gte: start, lte: end } },
          { githubUpdatedAt: { gte: start, lte: end } },
        ],
      },
      orderBy: { githubCreatedAt: "desc" },
      take: 100,
    }),
  ]);

  const metrics = {
    issues: issues.length,
    pullRequests: prs.length,
    mergedPrs: prs.filter((p) => p.mergedAt !== null).length,
    openPrs: prs.filter((p) => p.state === "open").length,
    failedCi: runs.filter((r) => r.conclusion === "failure").length,
  };

  const payload = {
    repo: repo.fullName,
    range: { start_date: input.startDate, end_date: input.endDate },
    metrics,
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

  const reportMarkdown = await observeGeneration(
    "devflow-weekly-report",
    async (generation) => {
      const res = await generateText({
        model: thinkModel,
        system: WEEKLY_REPORT_PROMPT,
        prompt: JSON.stringify(payload, null, 2),
        providerOptions,
      });
      generation?.update({ input: JSON.stringify(payload), output: res.text });
      return res.text;
    },
  );

  // Persist into the repo knowledge base (best-effort — a Milvus outage must
  // not discard the generated report).
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

  return { reportMarkdown, metrics, knowledgeDocId };
}
