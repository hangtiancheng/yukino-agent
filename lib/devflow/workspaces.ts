import { generateText } from "ai";
import { z } from "zod/v4";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { quickModel, providerOptions } from "@/lib/ai/models";
import { observeGeneration } from "@/lib/observability";
import {
  llmConfigured,
  type GenerationMode,
} from "@/lib/devflow/agents/analysis";
import { generateWeeklyReport } from "@/lib/devflow/agents/report";

export const WorkspaceCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1000).optional(),
  repoIds: z.array(z.string().min(1)).max(50).default([]),
});
export type WorkspaceCreate = z.infer<typeof WorkspaceCreateSchema>;

export const WorkspaceUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    repoIds: z.array(z.string().min(1)).max(50).optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.description !== undefined ||
      v.repoIds !== undefined,
    { message: "At least one field must be provided" },
  );
export type WorkspaceUpdate = z.infer<typeof WorkspaceUpdateSchema>;

export const MultiRepoReportSchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type MultiRepoReportRequest = z.infer<typeof MultiRepoReportSchema>;

export type WorkspaceErrorCode =
  "notFound" | "nameTaken" | "reposMissing" | "noRepos";

export class WorkspaceError extends Error {
  constructor(
    public code: WorkspaceErrorCode,
    message: string,
    public missingRepoIds: string[] = [],
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

function isUniqueViolation(e: unknown): boolean {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002"
  );
}

export function dedupeRepoIds(repoIds: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const id of repoIds) {
    if (!seen.has(id)) {
      seen.add(id);
      output.push(id);
    }
  }
  return output;
}

export function missingRepoIds(requested: string[], known: string[]): string[] {
  const knownSet = new Set(known);
  return requested.filter((id) => !knownSet.has(id));
}

export const STALE_PR_DAYS = 14;
export const OPEN_PR_BACKLOG = 5;
export const OPEN_ISSUE_BACKLOG = 5;

export type WorkspaceRiskLevel = "P0" | "P1" | "P2";

export interface RepoRiskInput {
  failedCi: number;
  staleOpenPrs: number;
  openPrs: number;
  openIssues: number;
}

export function classifyRepoRisk(input: RepoRiskInput): {
  level: WorkspaceRiskLevel;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (input.failedCi > 0) {
    reasons.push(`${input.failedCi} failed CI run(s) in range`);
  }
  if (input.staleOpenPrs > 0) {
    reasons.push(
      `${input.staleOpenPrs} open PR(s) untouched for ${STALE_PR_DAYS}+ days`,
    );
  }
  if (input.openPrs > OPEN_PR_BACKLOG) {
    reasons.push(`open PR backlog of ${input.openPrs} (> ${OPEN_PR_BACKLOG})`);
  }
  if (reasons.length > 0) return { level: "P0", reasons };
  if (input.openIssues > OPEN_ISSUE_BACKLOG) {
    return {
      level: "P1",
      reasons: [
        `open issue backlog of ${input.openIssues} (> ${OPEN_ISSUE_BACKLOG})`,
      ],
    };
  }
  return { level: "P2", reasons: [] };
}

export interface RepoAggregate {
  repoId: string;
  fullName: string | null;
  issues: number;
  openIssues: number;
  pullRequests: number;
  openPrs: number;
  mergedPrs: number;
  runs: number;
  failedRuns: number;
  knowledgeDocs: number;
}

export interface WorkspaceTotals {
  repos: number;
  issues: number;
  openIssues: number;
  pullRequests: number;
  openPrs: number;
  mergedPrs: number;
  runs: number;
  failedRuns: number;
  knowledgeDocs: number;
}

export function totalsFromRepoStats(stats: RepoAggregate[]): WorkspaceTotals {
  const totals: WorkspaceTotals = {
    repos: stats.length,
    issues: 0,
    openIssues: 0,
    pullRequests: 0,
    openPrs: 0,
    mergedPrs: 0,
    runs: 0,
    failedRuns: 0,
    knowledgeDocs: 0,
  };
  for (const row of stats) {
    totals.issues += row.issues;
    totals.openIssues += row.openIssues;
    totals.pullRequests += row.pullRequests;
    totals.openPrs += row.openPrs;
    totals.mergedPrs += row.mergedPrs;
    totals.runs += row.runs;
    totals.failedRuns += row.failedRuns;
    totals.knowledgeDocs += row.knowledgeDocs;
  }
  return totals;
}

export interface WorkspaceStats {
  workspaceId: string;
  repos: RepoAggregate[];
  totals: WorkspaceTotals;
}

async function mustGetWorkspace(id: string): Promise<{
  id: string;
  name: string;
  description: string | null;
  repoIds: string[];
  createdAt: Date;
  updatedAt: Date;
}> {
  const workspace = await prisma.workspace.findUnique({ where: { id } });
  if (!workspace) {
    throw new WorkspaceError("notFound", `Workspace ${id} not found`);
  }
  return workspace;
}

export async function aggregateWorkspaceStats(
  workspaceId: string,
): Promise<WorkspaceStats> {
  const workspace = await mustGetWorkspace(workspaceId);
  const repoIds = dedupeRepoIds(workspace.repoIds);

  const repoRows = repoIds.length
    ? await prisma.repository.findMany({
        where: { id: { in: repoIds } },
        select: { id: true, fullName: true },
      })
    : [];
  const names = new Map(repoRows.map((row) => [row.id, row.fullName]));

  const [issuesByState, prsByState, mergedPrRows, runsByConclusion, docRows] =
    await Promise.all(
      repoIds.length
        ? [
            prisma.issue.groupBy({
              by: ["repoId", "state"],
              where: { repoId: { in: repoIds } },
              _count: { _all: true },
            }),
            prisma.pullRequest.groupBy({
              by: ["repoId", "state"],
              where: { repoId: { in: repoIds } },
              _count: { _all: true },
            }),
            prisma.pullRequest.groupBy({
              by: ["repoId"],
              where: { repoId: { in: repoIds }, mergedAt: { not: null } },
              _count: { _all: true },
            }),
            prisma.workflowRun.groupBy({
              by: ["repoId", "conclusion"],
              where: { repoId: { in: repoIds } },
              _count: { _all: true },
            }),
            prisma.knowledgeDocument.groupBy({
              by: ["repoId"],
              where: { repoId: { in: repoIds } },
              _count: { _all: true },
            }),
          ]
        : [[], [], [], [], []],
    );

  const stats = new Map<string, RepoAggregate>(
    repoIds.map((repoId) => [
      repoId,
      {
        repoId,
        fullName: names.get(repoId) ?? null,
        issues: 0,
        openIssues: 0,
        pullRequests: 0,
        openPrs: 0,
        mergedPrs: 0,
        runs: 0,
        failedRuns: 0,
        knowledgeDocs: 0,
      },
    ]),
  );
  const at = (repoId: string): RepoAggregate | undefined => stats.get(repoId);

  for (const row of issuesByState) {
    const entry = at(row.repoId);
    if (!entry) continue;
    entry.issues += row._count._all;
    if (row.state === "open") entry.openIssues += row._count._all;
  }
  for (const row of prsByState) {
    const entry = at(row.repoId);
    if (!entry) continue;
    entry.pullRequests += row._count._all;
    if (row.state === "open") entry.openPrs += row._count._all;
  }
  for (const row of mergedPrRows) {
    const entry = at(row.repoId);
    if (entry) entry.mergedPrs += row._count._all;
  }
  for (const row of runsByConclusion) {
    const entry = at(row.repoId);
    if (!entry) continue;
    entry.runs += row._count._all;
    if (row.conclusion === "failure") entry.failedRuns += row._count._all;
  }
  for (const row of docRows) {
    const entry = at(row.repoId);
    if (entry) entry.knowledgeDocs += row._count._all;
  }

  const repos = repoIds
    .map((repoId) => stats.get(repoId))
    .filter((row): row is RepoAggregate => row !== undefined);
  return {
    workspaceId: workspace.id,
    repos,
    totals: totalsFromRepoStats(repos),
  };
}

export interface WorkspaceView {
  id: string;
  name: string;
  description: string | null;
  repoIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

export function toWorkspaceView(workspace: {
  id: string;
  name: string;
  description: string | null;
  repoIds: string[];
  createdAt: Date;
  updatedAt: Date;
}): WorkspaceView {
  return {
    id: workspace.id,
    name: workspace.name,
    description: workspace.description,
    repoIds: workspace.repoIds,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  };
}

export interface WorkspaceRepoCount {
  repoId: string;
  fullName: string | null;
  issues: number;
  pullRequests: number;
  workflowRuns: number;
}

export interface WorkspaceListItem extends WorkspaceView {
  repos: WorkspaceRepoCount[];
}

export async function createWorkspace(
  input: WorkspaceCreate,
): Promise<WorkspaceView> {
  const repoIds = dedupeRepoIds(input.repoIds);
  const known = repoIds.length
    ? await prisma.repository.findMany({
        where: { id: { in: repoIds } },
        select: { id: true },
      })
    : [];
  const missing = missingRepoIds(
    repoIds,
    known.map((row) => row.id),
  );
  if (missing.length > 0) {
    throw new WorkspaceError(
      "reposMissing",
      `Repositories not found: ${missing.join(", ")}`,
      missing,
    );
  }
  const nameTaken = await prisma.workspace.findUnique({
    where: { name: input.name },
    select: { id: true },
  });
  if (nameTaken) {
    throw new WorkspaceError(
      "nameTaken",
      `Workspace name already in use: ${input.name}`,
    );
  }
  try {
    const workspace = await prisma.workspace.create({
      data: {
        name: input.name,
        description: input.description ?? null,
        repoIds,
      },
    });
    return toWorkspaceView(workspace);
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new WorkspaceError(
        "nameTaken",
        `Workspace name already in use: ${input.name}`,
      );
    }
    throw e;
  }
}

export async function updateWorkspace(
  id: string,
  input: WorkspaceUpdate,
): Promise<WorkspaceView> {
  const existing = await mustGetWorkspace(id);
  if (input.repoIds !== undefined) {
    const repoIds = dedupeRepoIds(input.repoIds);
    const known = repoIds.length
      ? await prisma.repository.findMany({
          where: { id: { in: repoIds } },
          select: { id: true },
        })
      : [];
    const missing = missingRepoIds(
      repoIds,
      known.map((row) => row.id),
    );
    if (missing.length > 0) {
      throw new WorkspaceError(
        "reposMissing",
        `Repositories not found: ${missing.join(", ")}`,
        missing,
      );
    }
  }
  if (input.name !== undefined && input.name !== existing.name) {
    const nameTaken = await prisma.workspace.findUnique({
      where: { name: input.name },
      select: { id: true },
    });
    if (nameTaken) {
      throw new WorkspaceError(
        "nameTaken",
        `Workspace name already in use: ${input.name}`,
      );
    }
  }
  try {
    const workspace = await prisma.workspace.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
        ...(input.repoIds !== undefined
          ? { repoIds: dedupeRepoIds(input.repoIds) }
          : {}),
      },
    });
    return toWorkspaceView(workspace);
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new WorkspaceError(
        "nameTaken",
        `Workspace name already in use: ${input.name ?? existing.name}`,
      );
    }
    throw e;
  }
}

export async function deleteWorkspace(id: string): Promise<WorkspaceView> {
  await mustGetWorkspace(id);
  const workspace = await prisma.workspace.delete({ where: { id } });
  return toWorkspaceView(workspace);
}

export async function listWorkspaces(): Promise<WorkspaceListItem[]> {
  const items = await prisma.workspace.findMany({
    orderBy: { updatedAt: "desc" },
  });
  const allRepoIds = dedupeRepoIds(items.flatMap((item) => item.repoIds));

  const [repoRows, issueRows, prRows, runRows] = await Promise.all(
    allRepoIds.length
      ? [
          prisma.repository.findMany({
            where: { id: { in: allRepoIds } },
            select: { id: true, fullName: true },
          }),
          prisma.issue.groupBy({
            by: ["repoId"],
            where: { repoId: { in: allRepoIds } },
            _count: { _all: true },
          }),
          prisma.pullRequest.groupBy({
            by: ["repoId"],
            where: { repoId: { in: allRepoIds } },
            _count: { _all: true },
          }),
          prisma.workflowRun.groupBy({
            by: ["repoId"],
            where: { repoId: { in: allRepoIds } },
            _count: { _all: true },
          }),
        ]
      : [[], [], [], []],
  );

  const names = new Map(repoRows.map((row) => [row.id, row.fullName]));
  const issueCounts = new Map(
    issueRows.map((row) => [row.repoId, row._count._all]),
  );
  const prCounts = new Map(prRows.map((row) => [row.repoId, row._count._all]));
  const runCounts = new Map(
    runRows.map((row) => [row.repoId, row._count._all]),
  );

  return items.map((item) => ({
    ...toWorkspaceView(item),
    repos: dedupeRepoIds(item.repoIds).map((repoId) => ({
      repoId,
      fullName: names.get(repoId) ?? null,
      issues: issueCounts.get(repoId) ?? 0,
      pullRequests: prCounts.get(repoId) ?? 0,
      workflowRuns: runCounts.get(repoId) ?? 0,
    })),
  }));
}

export interface RepoReportSummary {
  repoId: string;
  fullName: string | null;
  rangeIssues: number;
  rangePrs: number;
  rangeRuns: number;
  openIssues: number;
  openPrs: number;
  mergedPrs: number;
  failedCi: number;
  staleOpenPrs: number;
  knowledgeDocs: number;
  riskLevel: WorkspaceRiskLevel;
  riskReasons: string[];
}

export interface MultiRepoTotals {
  repos: number;
  rangeIssues: number;
  rangePrs: number;
  rangeRuns: number;
  openIssues: number;
  openPrs: number;
  mergedPrs: number;
  failedCi: number;
  staleOpenPrs: number;
}

export function reportTotalsFromSummaries(
  summaries: RepoReportSummary[],
): MultiRepoTotals {
  const totals: MultiRepoTotals = {
    repos: summaries.length,
    rangeIssues: 0,
    rangePrs: 0,
    rangeRuns: 0,
    openIssues: 0,
    openPrs: 0,
    mergedPrs: 0,
    failedCi: 0,
    staleOpenPrs: 0,
  };
  for (const row of summaries) {
    totals.rangeIssues += row.rangeIssues;
    totals.rangePrs += row.rangePrs;
    totals.rangeRuns += row.rangeRuns;
    totals.openIssues += row.openIssues;
    totals.openPrs += row.openPrs;
    totals.mergedPrs += row.mergedPrs;
    totals.failedCi += row.failedCi;
    totals.staleOpenPrs += row.staleOpenPrs;
  }
  return totals;
}

export interface RiskItem {
  repoId: string;
  fullName: string | null;
  level: WorkspaceRiskLevel;
  reasons: string[];
}

export function buildRiskItems(summaries: RepoReportSummary[]): RiskItem[] {
  const rank: Record<WorkspaceRiskLevel, number> = { P0: 0, P1: 1, P2: 2 };
  return summaries
    .filter((row) => row.riskLevel !== "P2")
    .sort((a, b) => rank[a.riskLevel] - rank[b.riskLevel])
    .map((row) => ({
      repoId: row.repoId,
      fullName: row.fullName,
      level: row.riskLevel,
      reasons: row.riskReasons,
    }));
}

export interface MultiRepoTemplateInput {
  workspaceName: string;
  startDate: string;
  endDate: string;
  totals: MultiRepoTotals;
  summaries: RepoReportSummary[];
}

export function deterministicMultiRepoReport(
  input: MultiRepoTemplateInput,
): string {
  const { totals } = input;
  const label = (name: string | null, repoId: string): string =>
    name ?? `deleted repo (${repoId})`;
  const focus = input.summaries.filter((row) => row.riskLevel === "P0");

  const lines = [
    `# Multi-repository engineering weekly report`,
    ``,
    `> Range: ${input.startDate} to ${input.endDate} · Workspace: ${input.workspaceName}`,
    ``,
    `## Overview`,
    `- Repositories: ${totals.repos}`,
    `- Open Issues: ${totals.openIssues}`,
    `- Open PRs: ${totals.openPrs}`,
    `- Merged PRs in range: ${totals.mergedPrs}`,
    `- Failed CI in range: ${totals.failedCi}`,
    `- PRs untouched for ${STALE_PR_DAYS}+ days: ${totals.staleOpenPrs}`,
    ``,
    `## Repository breakdown`,
    ...input.summaries.map(
      (row) =>
        `- ${label(row.fullName, row.repoId)}: open issues ${row.openIssues}, open PRs ${row.openPrs}, merged ${row.mergedPrs}, failed CI ${row.failedCi}, risk ${row.riskLevel}`,
    ),
    ...(input.summaries.length === 0
      ? [`- No repositories in this workspace yet.`]
      : []),
    ``,
    `## Key focus`,
    ...focus.flatMap((row) =>
      row.riskReasons.map(
        (reason) => `- ${label(row.fullName, row.repoId)}: ${reason}.`,
      ),
    ),
    ...(focus.length === 0
      ? [
          `- No high-risk repositories; keep watching PR dwell time and review backlog.`,
        ]
      : []),
  ];
  return lines.join("\n") + "\n";
}

export const MULTI_REPO_REPORT_PROMPT = `You are the Multi-Repository Report Agent of DevFlow.
The input contains the aggregate statistics and risk grading of EVERY repository
in one workspace within a date range.

Write a cross-repository engineering weekly report in Markdown covering:
- Workspace overview (totals)
- Per-repository breakdown
- Risks and priorities (P0 repositories first, with the concrete reasons)
- Recommendations for next week

The "totals" object and each repository summary hold EXACT aggregate counts.
Quote these numbers verbatim; never invent repositories, issues, PRs, CI runs,
or owners that are not present in the input data. Keep the "riskLevel" gradings
(P0/P1/P2) and their "riskReasons" as computed — you may rephrase, not re-grade.`;

export interface MultiRepoReportResult {
  workspaceId: string;
  workspaceName: string;
  startDate: string;
  endDate: string;
  reportMarkdown: string;
  metrics: MultiRepoTotals;
  repoSummaries: RepoReportSummary[];
  riskItems: RiskItem[];
  generationMode: GenerationMode;
  repoReportsTriggered: string[];
}

export async function generateMultiRepoReport(input: {
  workspaceId: string;
  startDate: string;
  endDate: string;
}): Promise<MultiRepoReportResult> {
  const workspace = await mustGetWorkspace(input.workspaceId);
  const repoIds = dedupeRepoIds(workspace.repoIds);
  const repos = repoIds.length
    ? await prisma.repository.findMany({
        where: { id: { in: repoIds } },
        select: { id: true, fullName: true },
      })
    : [];
  if (repos.length === 0) {
    throw new WorkspaceError(
      "noRepos",
      "Select at least one repository for the multi-repository report",
    );
  }
  const byId = new Map(repos.map((row) => [row.id, row.fullName]));

  const start = new Date(`${input.startDate}T00:00:00.000Z`);
  const end = new Date(`${input.endDate}T23:59:59.999Z`);
  const staleCutoff = new Date(Date.now() - STALE_PR_DAYS * 86_400_000);

  const issueRangeWhere = {
    repoId: { in: repoIds },
    OR: [
      { githubCreatedAt: { gte: start, lte: end } },
      { githubUpdatedAt: { gte: start, lte: end } },
      { githubClosedAt: { gte: start, lte: end } },
    ],
  };
  const prRangeWhere = {
    repoId: { in: repoIds },
    OR: [
      { githubCreatedAt: { gte: start, lte: end } },
      { githubUpdatedAt: { gte: start, lte: end } },
      { mergedAt: { gte: start, lte: end } },
    ],
  };
  const runRangeWhere = {
    repoId: { in: repoIds },
    OR: [
      { githubCreatedAt: { gte: start, lte: end } },
      { githubUpdatedAt: { gte: start, lte: end } },
    ],
  };

  const [
    rangeIssueRows,
    rangePrRows,
    mergedRows,
    openIssueRows,
    openPrRows,
    rangeRunRows,
    failedCiRows,
    stalePrRows,
    docRows,
  ] = await Promise.all([
    prisma.issue.groupBy({
      by: ["repoId"],
      where: issueRangeWhere,
      _count: { _all: true },
    }),
    prisma.pullRequest.groupBy({
      by: ["repoId"],
      where: prRangeWhere,
      _count: { _all: true },
    }),
    prisma.pullRequest.groupBy({
      by: ["repoId"],
      where: { ...prRangeWhere, mergedAt: { not: null } },
      _count: { _all: true },
    }),
    prisma.issue.groupBy({
      by: ["repoId"],
      where: { repoId: { in: repoIds }, state: "open" },
      _count: { _all: true },
    }),
    prisma.pullRequest.groupBy({
      by: ["repoId"],
      where: { repoId: { in: repoIds }, state: "open" },
      _count: { _all: true },
    }),
    prisma.workflowRun.groupBy({
      by: ["repoId"],
      where: runRangeWhere,
      _count: { _all: true },
    }),
    prisma.workflowRun.groupBy({
      by: ["repoId"],
      where: { ...runRangeWhere, conclusion: "failure" },
      _count: { _all: true },
    }),
    prisma.pullRequest.groupBy({
      by: ["repoId"],
      where: {
        repoId: { in: repoIds },
        state: "open",
        githubUpdatedAt: { lt: staleCutoff },
      },
      _count: { _all: true },
    }),
    prisma.knowledgeDocument.groupBy({
      by: ["repoId"],
      where: { repoId: { in: repoIds } },
      _count: { _all: true },
    }),
  ]);

  const countOf = (rows: Array<{ repoId: string; _count: { _all: number } }>) =>
    new Map(rows.map((row) => [row.repoId, row._count._all]));
  const rangeIssues = countOf(rangeIssueRows);
  const rangePrs = countOf(rangePrRows);
  const merged = countOf(mergedRows);
  const openIssues = countOf(openIssueRows);
  const openPrs = countOf(openPrRows);
  const rangeRuns = countOf(rangeRunRows);
  const failedCi = countOf(failedCiRows);
  const staleOpenPrs = countOf(stalePrRows);
  const knowledgeDocs = countOf(docRows);

  const summaries: RepoReportSummary[] = repoIds
    .filter((repoId) => byId.has(repoId))
    .map((repoId) => {
      const risk = classifyRepoRisk({
        failedCi: failedCi.get(repoId) ?? 0,
        staleOpenPrs: staleOpenPrs.get(repoId) ?? 0,
        openPrs: openPrs.get(repoId) ?? 0,
        openIssues: openIssues.get(repoId) ?? 0,
      });
      return {
        repoId,
        fullName: byId.get(repoId) ?? null,
        rangeIssues: rangeIssues.get(repoId) ?? 0,
        rangePrs: rangePrs.get(repoId) ?? 0,
        rangeRuns: rangeRuns.get(repoId) ?? 0,
        openIssues: openIssues.get(repoId) ?? 0,
        openPrs: openPrs.get(repoId) ?? 0,
        mergedPrs: merged.get(repoId) ?? 0,
        failedCi: failedCi.get(repoId) ?? 0,
        staleOpenPrs: staleOpenPrs.get(repoId) ?? 0,
        knowledgeDocs: knowledgeDocs.get(repoId) ?? 0,
        riskLevel: risk.level,
        riskReasons: risk.reasons,
      };
    });

  const totals = reportTotalsFromSummaries(summaries);
  const riskItems = buildRiskItems(summaries);
  const templateInput: MultiRepoTemplateInput = {
    workspaceName: workspace.name,
    startDate: input.startDate,
    endDate: input.endDate,
    totals,
    summaries,
  };

  let reportMarkdown: string;
  let generationMode: GenerationMode = "deterministic";
  if (llmConfigured()) {
    const payload = {
      workspace: workspace.name,
      range: { start_date: input.startDate, end_date: input.endDate },
      totals,
      repositories: summaries,
    };
    try {
      const text = await observeGeneration(
        "devflow-multi-repo-report",
        async (generation) => {
          const res = await generateText({
            model: quickModel,
            system: MULTI_REPO_REPORT_PROMPT,
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
        reportMarkdown = deterministicMultiRepoReport(templateInput);
      }
    } catch (e) {
      console.warn(
        "[devflow-workspaces] LLM multi-repo report failed; using deterministic template:",
        e,
      );
      reportMarkdown = deterministicMultiRepoReport(templateInput);
    }
  } else {
    reportMarkdown = deterministicMultiRepoReport(templateInput);
  }

  const triggeredRepoIds = repos.map((repo) => repo.id);
  void Promise.all(
    triggeredRepoIds.map(async (repoId) => {
      try {
        await generateWeeklyReport({
          repoId,
          startDate: input.startDate,
          endDate: input.endDate,
        });
      } catch (e) {
        console.warn(
          "[devflow-workspaces] per-repo weekly report failed (fire-and-forget):",
          repoId,
          e instanceof Error ? e.message : String(e),
        );
      }
    }),
  );

  return {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    startDate: input.startDate,
    endDate: input.endDate,
    reportMarkdown,
    metrics: totals,
    repoSummaries: summaries,
    riskItems,
    generationMode,
    repoReportsTriggered: triggeredRepoIds,
  };
}
