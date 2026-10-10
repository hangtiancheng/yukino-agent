import type { Repository } from "@/generated/prisma/client";

export type RecommendationKey =
  | "emptyRepoOverview"
  | "emptyRepoCodeStructure"
  | "emptyRepoSyncHowto"
  | "emptyRepoChecklist"
  | "emptyRepoFirstSetup"
  | "emptyRepoPlanSync"
  | "ciDiagnose"
  | "ciFixSteps"
  | "ciPrLink"
  | "ciChecklist"
  | "ciCheckStatus"
  | "ciRisks"
  | "ciHealthSummary"
  | "ciNextStep"
  | "prRiskTitle"
  | "prRisk"
  | "prTests"
  | "prMergeChecklist"
  | "prImpact"
  | "issueOwnerTitle"
  | "issueOwner"
  | "issuePriority"
  | "issueClarifyDraft"
  | "issueSplit"
  | "whyCiFailed"
  | "ciPrChain"
  | "ciTriageSteps"
  | "prSummarizeRisk"
  | "prRiskSort"
  | "prMergeToday"
  | "prChecklist"
  | "issueOldest"
  | "issueNeedRepro"
  | "issuePrioritySort"
  | "standupSummary"
  | "deliveryBlockers"
  | "weeklyReport"
  | "repoOverview"
  | "topThree"
  | "dailySnapshot"
  | "blockers"
  | "codeStructure"
  | "testConfig"
  | "changeRisks"
  | "nextPlan"
  | "teamUpdate"
  | "kbContents";

export type RecommendTranslate = (
  key: RecommendationKey,
  values?: Record<string, string | number>,
) => string;

export interface RecommendationInput {
  issues: Array<{
    number: number;
    title: string;
    state: string;
    updatedAt: Date | string | null;
  }>;
  pulls: Array<{
    number: number;
    title: string;
    state: string;
    updatedAt: Date | string | null;
  }>;
  runs: Array<{
    name: string;
    conclusion: string | null;
    updatedAt?: Date | string | null;
    createdAt?: Date | string | null;
  }>;
  exclude?: string[];
  limit?: number;
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function short(value: string, maxLength = 22): string {
  const text = value.trim().replace(/\s+/g, " ");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trimEnd()}...`;
}

function sortTimestamp(value: Date | string | null | undefined): number {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? 0 : parsed;
}

function dedupe(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const key = normalize(value);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

export function buildRecommendations(
  input: RecommendationInput,
  t: RecommendTranslate,
): {
  suggestions: string[];
  sourceCounts: { issues: number; pullRequests: number; workflowRuns: number };
} {
  const limit = Math.min(Math.max(input.limit ?? 5, 4), 5);
  const excluded = new Set((input.exclude ?? []).map(normalize));
  const seen = new Set(excluded);

  const issues = [...input.issues].sort(
    (a, b) => sortTimestamp(b.updatedAt) - sortTimestamp(a.updatedAt),
  );
  const pulls = [...input.pulls].sort(
    (a, b) => sortTimestamp(b.updatedAt) - sortTimestamp(a.updatedAt),
  );
  const runs = [...input.runs].sort(
    (a, b) =>
      sortTimestamp(b.updatedAt ?? b.createdAt) -
      sortTimestamp(a.updatedAt ?? a.createdAt),
  );

  if (issues.length === 0 && pulls.length === 0 && runs.length === 0) {
    const candidates = [
      t("emptyRepoOverview"),
      t("emptyRepoCodeStructure"),
      t("emptyRepoSyncHowto"),
      t("emptyRepoChecklist"),
      t("emptyRepoFirstSetup"),
      t("emptyRepoPlanSync"),
    ];
    const selected = candidates
      .filter((s) => !seen.has(normalize(s)))
      .slice(0, limit);
    return {
      suggestions: selected,
      sourceCounts: { issues: 0, pullRequests: 0, workflowRuns: 0 },
    };
  }

  const openIssues = issues.filter(
    (i) => String(i.state).toLowerCase() === "open",
  );
  const openPulls = pulls.filter(
    (p) => String(p.state).toLowerCase() === "open",
  );
  const failedRuns = runs.filter(
    (r) => String(r.conclusion ?? "").toLowerCase() === "failure",
  );

  const candidates: string[] = [];
  for (const run of failedRuns.slice(0, 5)) {
    const name = short(run.name || "CI");
    candidates.push(
      t("ciDiagnose", { name }),
      t("ciFixSteps", { name }),
      t("ciPrLink", { name }),
      t("ciChecklist", { name }),
    );
  }
  if (failedRuns.length === 0 && runs.length > 0) {
    const latest = short((runs[0]?.name ?? "") || "CI");
    candidates.push(
      t("ciCheckStatus", { name: latest }),
      t("ciRisks"),
      t("ciHealthSummary"),
      t("ciNextStep"),
    );
  }
  for (const pull of openPulls.slice(0, 5)) {
    const label = pull.number ? `PR #${pull.number}` : "PR";
    const title = short(pull.title ?? "");
    candidates.push(
      title !== ""
        ? t("prRiskTitle", { label, title })
        : t("prRisk", { label }),
      t("prTests", { label }),
      t("prMergeChecklist", { label }),
      t("prImpact", { label }),
    );
  }
  for (const issue of openIssues.slice(0, 5)) {
    const label = issue.number ? `Issue #${issue.number}` : "Issue";
    const title = short(issue.title ?? "");
    candidates.push(
      title !== ""
        ? t("issueOwnerTitle", { label, title })
        : t("issueOwner", { label }),
      t("issuePriority", { label }),
      t("issueClarifyDraft", { label }),
      t("issueSplit", { label }),
    );
  }
  if (failedRuns.length > 0) {
    candidates.push(
      t("whyCiFailed"),
      pulls.length > 0 ? t("ciPrChain") : t("ciTriageSteps"),
    );
  }
  if (pulls.length > 0) {
    candidates.push(
      t("prSummarizeRisk"),
      t("prRiskSort"),
      t("prMergeToday"),
      t("prChecklist"),
    );
  }
  if (issues.length > 0) {
    candidates.push(
      t("issueOldest"),
      t("issueNeedRepro"),
      t("issuePrioritySort"),
    );
  }
  if (issues.length > 0 && pulls.length > 0) {
    candidates.push(t("standupSummary"), t("deliveryBlockers"));
  }
  candidates.push(
    t("weeklyReport"),
    t("repoOverview"),
    t("topThree"),
    t("dailySnapshot"),
    t("blockers"),
    t("codeStructure"),
    t("testConfig"),
    t("changeRisks"),
    t("nextPlan"),
    t("teamUpdate"),
    t("kbContents"),
  );

  const ordered = dedupe(candidates);
  let selected = ordered.filter((s) => !seen.has(normalize(s))).slice(0, limit);
  if (selected.length === 0 && (input.exclude?.length ?? 0) > 0) {
    selected = ordered.slice(0, limit);
  }
  return {
    suggestions: selected,
    sourceCounts: {
      issues: issues.length,
      pullRequests: pulls.length,
      workflowRuns: runs.length,
    },
  };
}

export async function gatherRecommendationInput(repo: Repository) {
  const { prisma } = await import("@/lib/db");
  const [issues, pulls, runs] = await Promise.all([
    prisma.issue.findMany({
      where: { repoId: repo.id },
      orderBy: { githubUpdatedAt: "desc" },
      take: 20,
      select: { number: true, title: true, state: true, githubUpdatedAt: true },
    }),
    prisma.pullRequest.findMany({
      where: { repoId: repo.id },
      orderBy: { githubUpdatedAt: "desc" },
      take: 20,
      select: { number: true, title: true, state: true, githubUpdatedAt: true },
    }),
    prisma.workflowRun.findMany({
      where: { repoId: repo.id },
      orderBy: { githubCreatedAt: "desc" },
      take: 20,
      select: { name: true, conclusion: true, githubCreatedAt: true },
    }),
  ]);
  return {
    issues: issues.map((i) => ({
      number: i.number,
      title: i.title,
      state: i.state,
      updatedAt: i.githubUpdatedAt,
    })),
    pulls: pulls.map((p) => ({
      number: p.number,
      title: p.title,
      state: p.state,
      updatedAt: p.githubUpdatedAt,
    })),
    runs: runs.map((r) => ({
      name: r.name,
      conclusion: r.conclusion,
      createdAt: r.githubCreatedAt,
    })),
  };
}
