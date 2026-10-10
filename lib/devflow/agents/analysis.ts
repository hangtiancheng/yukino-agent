import { Output, generateText } from "ai";
import type { z } from "zod/v4";
import { prisma } from "@/lib/db";
import { thinkModel, providerOptions } from "@/lib/ai/models";
import { observeGeneration } from "@/lib/observability";
import { config } from "@/lib/config";
import {
  CIDebugSchema,
  CONCLUSION_LABELS,
  IssueAnalysisSchema,
  PRReviewSchema,
  type CIDebug,
  type IssueAnalysis,
  type PRReview,
} from "@/lib/devflow/schemas";
import { searchKnowledge } from "@/lib/devflow/rag";
import {
  listTeamMembers,
  toTeamMemberProfile,
  type TeamMemberProfile,
} from "@/lib/devflow/team";
import { impactForFiles, type ImpactReport } from "@/lib/devflow/code-graph";
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

export type GenerationMode = "llm" | "deterministic";

export interface AnalysisProvenance {
  generationMode: GenerationMode;
  ownerValidation?: OwnerValidation;
}

export interface OwnerValidation {
  status: "accepted" | "replaced";
  original: string;
  final: string;
}

function clip(text: string | null | undefined, max: number): string {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text;
}

function clipInline(text: string, limit: number): string {
  const t = (text ?? "").trim();
  return t.length <= limit ? t : `${t.slice(0, limit - 1).trimEnd()}…`;
}

export function llmConfigured(): boolean {
  return config.provider === "anthropic"
    ? Boolean(config.anthropic.think.apiKey)
    : Boolean(config.openai.think.apiKey);
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
  result: T & AnalysisProvenance;
  createdAt: Date;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

export interface IssueFacts {
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: string[];
  author: string | null;
  assignees: string[];
}

export interface IssueEngineContext {
  duplicateCandidates: Array<{ number: number; title: string; score: number }>;
  knowledgeEvidence: Array<{ docName: string; snippet: string }>;
  teamMembers: TeamMemberProfile[];
}

const ISSUE_UNASSIGNED = "unassigned";

type ReviewFinding = PRReview["review_findings"][number];
type IssueCategory = IssueAnalysis["category"];
type IssuePriority = IssueAnalysis["priority"];
type IssueComplexity = IssueAnalysis["complexity"];

export function classifyIssueCategory(
  text: string,
  labels: string[],
): IssueCategory {
  const joined = `${labels.join(" ")} ${text}`;
  const rules: Array<[IssueCategory, string[]]> = [
    [
      "bug",
      [
        "bug",
        "error",
        "fail",
        "500",
        "crash",
        "exception",
        "broken",
        "regression",
      ],
    ],
    [
      "documentation",
      ["doc", "documentation", "readme", "guide", "文档", "说明"],
    ],
    ["test", ["test", "pytest", "coverage", "单测", "测试"]],
    [
      "ops",
      ["ops", "ci", "workflow", "deploy", "docker", "infra", "环境", "权限"],
    ],
    ["refactor", ["refactor", "cleanup", "重构", "technical debt"]],
    ["feature", ["feature", "enhancement", "proposal", "需求", "新增"]],
    ["question", ["question", "how to", "why does", "咨询", "疑问"]],
  ];
  for (const [category, tokens] of rules) {
    if (tokens.some((token) => joined.includes(token))) return category;
  }
  return "feature";
}

export function classifyIssuePriority(
  text: string,
  labels: string[],
): IssuePriority {
  const joined = `${labels.join(" ")} ${text}`;
  if (
    [
      "p0",
      "sev0",
      "critical",
      "security",
      "data loss",
      "数据丢失",
      "全量不可用",
    ].some((token) => joined.includes(token))
  )
    return "P0";
  if (
    [
      "p1",
      "sev1",
      "crash",
      "cannot login",
      "500",
      "生产",
      "阻塞",
      "blocker",
    ].some((token) => joined.includes(token))
  )
    return "P1";
  if (
    ["p3", "minor", "polish", "typo", "文案", "低优"].some((token) =>
      joined.includes(token),
    )
  )
    return "P3";
  return "P2";
}

export function estimateIssueComplexity(
  text: string,
  labels: string[],
): IssueComplexity {
  const joined = `${labels.join(" ")} ${text}`;
  if (
    ["xl", "architecture", "migration", "rewrite", "跨模块", "架构"].some(
      (token) => joined.includes(token),
    )
  )
    return "XL";
  if (
    ["large", "complex", "integration", "schema", "多模块"].some((token) =>
      joined.includes(token),
    )
  )
    return "L";
  if (
    text.length < 280 &&
    ["typo", "copy", "文案", "doc"].some((token) => joined.includes(token))
  )
    return "S";
  return text.length < 1400 ? "M" : "L";
}

export function inferIssueArea(text: string): string {
  const areaKeywords: Record<string, string[]> = {
    backend: [
      "api",
      "database",
      "token",
      "server",
      "fastapi",
      "postgres",
      "auth",
      "jwt",
    ],
    frontend: [
      "ui",
      "page",
      "button",
      "react",
      "next",
      "css",
      "layout",
      "browser",
      "页面",
      "按钮",
      "electron",
      "desktop",
      "桌面化",
      "桌面端",
    ],
    ci: ["ci", "workflow", "actions", "pytest", "lint", "build", "deploy"],
    docs: ["readme", "doc", "文档", "说明"],
  };
  for (const [area, keywords] of Object.entries(areaKeywords)) {
    if (keywords.some((keyword) => text.includes(keyword))) return area;
  }
  return ISSUE_UNASSIGNED;
}

export function ownerDomainRules(): Array<[string, string[], string[]]> {
  return [
    [
      "desktop/electron",
      [
        "桌面化",
        "桌面端",
        "桌面应用",
        "electron",
        "desktop",
        "windows",
        "macos",
        "native app",
      ],
      [
        "electron",
        "desktop",
        "桌面",
        "windows",
        "macos",
        "tauri",
        "javascript",
        "js",
        "node",
        "frontend",
        "前端",
      ],
    ],
    [
      "backend/API",
      [
        "api",
        "database",
        "token",
        "server",
        "fastapi",
        "postgres",
        "auth",
        "jwt",
      ],
      [
        "api",
        "database",
        "server",
        "fastapi",
        "postgres",
        "auth",
        "jwt",
        "后端",
      ],
    ],
    [
      "frontend/UI",
      [
        "ui",
        "page",
        "button",
        "react",
        "next",
        "css",
        "layout",
        "browser",
        "页面",
        "按钮",
      ],
      ["ui", "react", "next", "css", "browser", "frontend", "前端"],
    ],
    [
      "CI/tooling",
      ["ci", "workflow", "actions", "pytest", "lint", "build", "deploy"],
      [
        "ci",
        "workflow",
        "actions",
        "pytest",
        "lint",
        "build",
        "deploy",
        "工程化",
      ],
    ],
  ];
}

export function profileTerms(profile: string): string[] {
  const normalized = profile
    .replaceAll("擅长", " ")
    .replaceAll("熟悉", " ")
    .replaceAll("技术栈", " ");
  return normalized.toLowerCase().match(/[a-zA-Z0-9_+#.\u4e00-\u9fff]+/g) ?? [];
}

export function memberProfileText(member: TeamMemberProfile): string {
  return [
    member.displayName,
    member.skills.join(" "),
    member.availability,
    member.notes,
  ]
    .join(" ")
    .toLowerCase();
}

export function matchOwnerFromTeam(
  members: TeamMemberProfile[],
  signalText: string,
): { name: string; reason: string } | null {
  let best: { name: string; score: number; reasons: string[] } | null = null;
  for (const member of members) {
    const name = member.name.trim();
    if (!name) continue;
    const profile = memberProfileText(member);
    let score = 0;
    const reasons: string[] = [];
    for (const term of profileTerms(profile)) {
      if (term.length >= 2 && signalText.includes(term)) {
        score += 1;
        reasons.push(term);
      }
    }
    for (const [domain, issueTerms, profileTokens] of ownerDomainRules()) {
      if (
        issueTerms.some((token) => signalText.includes(token)) &&
        profileTokens.some((token) => profile.includes(token))
      ) {
        score += 8;
        reasons.push(domain);
      }
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { name, score, reasons };
    }
  }
  if (!best) return null;
  const unique = [...new Set(best.reasons.slice(0, 4))].join(", ");
  return {
    name: best.name,
    reason: `Team profile matches issue/code/document signals: ${unique || "team profile"} (score ${best.score}).`,
  };
}

export function ownerSignalText(
  issueText: string,
  ctx: IssueEngineContext,
): string {
  const parts = [issueText];
  for (const item of ctx.knowledgeEvidence.slice(0, 6)) {
    parts.push(item.docName, item.snippet);
  }
  let text = parts.join(" ").toLowerCase();
  if (
    ["桌面化", "桌面端", "桌面应用", "electron"].some((term) =>
      text.includes(term),
    )
  ) {
    text += " electron desktop windows macos javascript node frontend";
  }
  return text;
}

export function suggestIssueOwner(
  facts: IssueFacts,
  issueText: string,
  ctx: IssueEngineContext,
): { owner: string; reason: string } {
  if (facts.assignees.length > 0) {
    const owner = String(facts.assignees[0]);
    return {
      owner,
      reason: `Issue is already assigned to ${owner}; keep the existing assignee.`,
    };
  }
  const signal = ownerSignalText(issueText, ctx);
  const teamMatch = matchOwnerFromTeam(ctx.teamMembers, signal);
  if (teamMatch) return { owner: teamMatch.name, reason: teamMatch.reason };

  const area = inferIssueArea(signal);
  if (ctx.teamMembers.length === 0) {
    if (area !== ISSUE_UNASSIGNED) {
      return {
        owner: ISSUE_UNASSIGNED,
        reason: `No team members are configured yet; this issue looks like a ${area} direction — add a matching member in the team panel before assigning.`,
      };
    }
    return {
      owner: ISSUE_UNASSIGNED,
      reason:
        "No team members are configured yet; add development members in the team panel before assigning.",
    };
  }
  if (area !== ISSUE_UNASSIGNED) {
    return {
      owner: ISSUE_UNASSIGNED,
      reason: `No team member matches the ${area} direction; enrich team-member profiles before assigning.`,
    };
  }
  return {
    owner: ISSUE_UNASSIGNED,
    reason:
      "Match confidence against team profiles and code/document evidence is too low; the owner needs human confirmation.",
  };
}

export function validatedDuplicates(
  candidates: IssueEngineContext["duplicateCandidates"],
): Array<{ number: number; title: string; score: number }> {
  const rows: Array<{ number: number; title: string; score: number }> = [];
  for (const item of candidates.slice(0, 5)) {
    const title = String(item.title ?? "").trim();
    const score = Math.max(
      0,
      Math.min(1, Number.isFinite(item.score) ? item.score : 0),
    );
    if (title) rows.push({ number: item.number, title, score });
  }
  return rows;
}

export function lexicalDuplicateScore(a: string, b: string): number {
  const tokensA = lexicalTokens(a);
  const tokensB = lexicalTokens(b);
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let shared = 0;
  for (const token of tokensA) if (tokensB.has(token)) shared += 1;
  const union = tokensA.size + tokensB.size - shared;
  return union === 0 ? 0 : shared / union;
}

function lexicalTokens(text: string): Set<string> {
  const lowered = text.toLowerCase();
  const tokens = new Set<string>();
  for (const match of lowered.match(/[a-z0-9_+#.-]{2,}/g) ?? [])
    tokens.add(match);
  const cjk = lowered.match(/[\u4e00-\u9fff]/g) ?? [];
  for (let i = 0; i + 1 < cjk.length; i += 1) tokens.add(cjk[i] + cjk[i + 1]);
  return tokens;
}

export function looksLikeMultiScope(text: string): boolean {
  const separators =
    countOccurrences(text, "\n-") +
    countOccurrences(text, "\n*") +
    countOccurrences(text, "、") +
    countOccurrences(text, ";");
  const broadTerms = [
    "同时",
    "以及",
    "并且",
    "多个",
    "all of",
    "migration",
    "architecture",
    "跨模块",
  ];
  return separators >= 5 || broadTerms.some((term) => text.includes(term));
}

export function needsClarification(text: string, category: string): boolean {
  if (text.trim().length < 80) return true;
  if (category === "bug") {
    const hasRepro = [
      "reproduce",
      "steps",
      "复现",
      "步骤",
      "expected",
      "actual",
      "期望",
      "实际",
    ].some((token) => text.includes(token));
    const hasImpact = [
      "impact",
      "影响",
      "scope",
      "范围",
      "blocking",
      "阻塞",
    ].some((token) => text.includes(token));
    return !(hasRepro || hasImpact);
  }
  if (category === "feature") {
    const hasAcceptance = [
      "acceptance",
      "验收",
      "criteria",
      "why",
      "value",
      "价值",
      "场景",
    ].some((token) => text.includes(token));
    return !hasAcceptance && text.trim().length < 220;
  }
  return false;
}

export function chooseIssueConclusion(
  facts: IssueFacts,
  text: string,
  labels: string[],
  category: string,
  complexity: string,
  duplicates: Array<{ score: number }>,
): { conclusion: IssueAnalysis["conclusion"]; conclusionReason: string } {
  const state = (facts.state ?? "").toLowerCase();
  const joined = `${labels.join(" ")} ${text}`;
  if (
    state === "closed" ||
    ["invalid", "wontfix", "won't fix", "not planned", "无效", "不处理"].some(
      (token) => joined.includes(token),
    )
  ) {
    return {
      conclusion: "close",
      conclusionReason:
        "The issue is closed or carries invalid/wontfix signals; archive it with a closing note.",
    };
  }
  if (duplicates.some((item) => item.score >= 0.86)) {
    return {
      conclusion: "merge_duplicate",
      conclusionReason:
        "A similar historical issue matches strongly; merge the context to avoid duplicate work.",
    };
  }
  if (complexity === "XL" || looksLikeMultiScope(text)) {
    return {
      conclusion: "split",
      conclusionReason:
        "The scope is large or contains multiple independent goals; splitting makes scheduling and acceptance easier.",
    };
  }
  if (needsClarification(text, category)) {
    return {
      conclusion: "needs_clarification",
      conclusionReason:
        "The description lacks impact scope, reproduction/acceptance conditions or expected results; starting development directly is risky.",
    };
  }
  return {
    conclusion: "start_development",
    conclusionReason:
      "The issue is actionable; confirm the acceptance criteria and then start development.",
  };
}

export function buildIssueChecklist(
  conclusion: IssueAnalysis["conclusion"],
  category: IssueCategory,
): string[] {
  if (conclusion === "needs_clarification") {
    return [
      "Ask for the problem background, impact scope and user scenario.",
      "For bugs add reproduction steps, expected vs actual results, and logs/screenshots.",
      "For features add acceptance criteria and out-of-scope boundaries.",
      "Re-run the Issue Agent analysis after the clarification.",
    ];
  }
  if (conclusion === "merge_duplicate") {
    return [
      "Confirm that the similar issue already covers this request.",
      "Append the new information from this issue as a comment on the existing issue.",
      "Mark the current issue as a duplicate / link the relation.",
      "Close the duplicate issue after human confirmation.",
    ];
  }
  if (conclusion === "split") {
    return [
      "Split into 2-5 subtasks by user value, module boundary or delivery order.",
      "Add acceptance criteria, dependencies and a suggested owner to each subtask.",
      "Agree on the minimal deliverable and schedule the first independently verifiable subtask.",
      "Post the split plan as a comment back on the original issue.",
    ];
  }
  if (conclusion === "close") {
    return [
      "Confirm whether the closing reason is invalid, duplicate, already done or not planned.",
      "Add a short closing comment with the rationale and the alternative path.",
      "Update labels or close the issue after human confirmation.",
    ];
  }
  const baseline = [
    "Confirm the acceptance criteria and the out-of-scope boundary.",
    "Locate the related code/documents and add design notes.",
    "Create a branch and implement the minimal fix/feature increment.",
    "Add automated tests or a manual verification record.",
    "Open a PR that links this issue in its description.",
  ];
  if (category === "bug") {
    baseline.splice(
      2,
      0,
      "First write a failing test or minimal reproduction script for the problem.",
    );
  }
  return baseline;
}

export function buildIssueDrafts(
  facts: IssueFacts,
  conclusion: string,
  checklist: string[],
): IssueAnalysis["drafts"] {
  const clarification =
    conclusion === "needs_clarification"
      ? `For issue #${facts.number} ${facts.title}, the current information is not enough to start development. Please add: impact scope, reproduction steps or usage scenario, expected vs actual results, and any logs, screenshots or version information.`
      : undefined;
  let taskBreakdown: string | undefined;
  if (conclusion === "split" || conclusion === "start_development") {
    taskBreakdown = `Suggested next steps:\n${checklist
      .slice(0, 5)
      .map((item) => `- ${item}`)
      .join("\n")}`;
  }
  if (conclusion === "merge_duplicate") {
    taskBreakdown = `Merge the new information from issue #${facts.number} into the similar historical issue, then leave a duplicate note here and close it.`;
  }
  return {
    ...(clarification ? { clarification_comment: clarification } : {}),
    ...(taskBreakdown ? { task_breakdown: taskBreakdown } : {}),
  };
}

export function estimateIssueConfidence(
  body: string,
  evidenceCount: number,
  duplicateCount: number,
  owner: string,
): number {
  let score = 0.45;
  if (body.trim().length >= 120) score += 0.12;
  if (evidenceCount >= 3) score += 0.14;
  if (duplicateCount > 0) score += 0.08;
  if (owner !== ISSUE_UNASSIGNED) score += 0.08;
  return Math.round(Math.max(0.35, Math.min(0.86, score)) * 100) / 100;
}

export function collectIssueEvidence(
  facts: IssueFacts,
  ctx: IssueEngineContext,
  duplicates: Array<{ number: number; title: string; score: number }>,
): IssueAnalysis["evidence"] {
  const evidence: IssueAnalysis["evidence"] = [
    {
      source_type: "issue",
      title: `Issue #${facts.number}: ${facts.title}`,
      snippet: clipInline(
        [facts.title, facts.body ?? ""].filter(Boolean).join("\n"),
        320,
      ),
    },
  ];
  for (const duplicate of duplicates.slice(0, 3)) {
    evidence.push({
      source_type: "similar_issue",
      title: duplicate.title,
      snippet: `Similarity ${duplicate.score.toFixed(2)} — candidate duplicate or historical fix to reference.`,
    });
  }
  for (const item of ctx.knowledgeEvidence.slice(0, 4)) {
    const snippet = clipInline(item.snippet, 320);
    if (!snippet) continue;
    evidence.push({ source_type: "document", title: item.docName, snippet });
  }
  for (const member of ctx.teamMembers.slice(0, 3)) {
    const name = member.name.trim();
    if (!name) continue;
    const profile = memberProfileText(member).trim();
    evidence.push({
      source_type: "team_member",
      title: `Team member: ${name}`,
      snippet: profile || "Team member profile usable for owner assignment.",
    });
  }
  const seen = new Set<string>();
  const deduped: IssueAnalysis["evidence"] = [];
  for (const item of evidence) {
    const key = `${item.source_type}\u001f${item.title}\u001f${item.snippet.slice(0, 180)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped.slice(0, 10);
}

export function deterministicIssueAnalysis(
  facts: IssueFacts,
  ctx: IssueEngineContext,
): IssueAnalysis {
  const text = `${facts.title} ${facts.body ?? ""}`.toLowerCase();
  const labels = facts.labels.map((label) => label.toLowerCase());
  const category = classifyIssueCategory(text, labels);
  const priority = classifyIssuePriority(text, labels);
  const complexity = estimateIssueComplexity(text, labels);
  const owner = suggestIssueOwner(facts, text, ctx);
  const duplicates = validatedDuplicates(ctx.duplicateCandidates);
  const { conclusion, conclusionReason } = chooseIssueConclusion(
    facts,
    text,
    labels,
    category,
    complexity,
    duplicates,
  );
  const checklist = buildIssueChecklist(conclusion, category);
  const drafts = buildIssueDrafts(facts, conclusion, checklist);
  const evidence = collectIssueEvidence(facts, ctx, duplicates);
  const confidence = estimateIssueConfidence(
    facts.body ?? "",
    evidence.length,
    duplicates.length,
    owner.owner,
  );
  return {
    summary: `The suggested conclusion for issue #${facts.number} ${
      facts.title || "Untitled Issue"
    } is: ${CONCLUSION_LABELS[conclusion]}.`,
    conclusion,
    conclusion_reason: conclusionReason,
    category,
    priority,
    complexity,
    suggested_owner: owner.owner,
    owner_reason: owner.reason,
    duplicate_candidates: duplicates.map((item) => ({
      number: item.number,
      title: item.title,
      reason: `Lexical match score ${item.score.toFixed(2)}.`,
    })),
    evidence,
    checklist,
    drafts,
    confidence,
  };
}

export function buildOwnerAllowList(input: {
  assignees: string[];
  author: string | null;
  historicalAuthors: string[];
  teamLogins: string[];
}): Set<string> {
  const allowed = new Set<string>();
  for (const value of [
    ...input.assignees,
    ...input.historicalAuthors,
    ...input.teamLogins,
    input.author ?? "",
  ]) {
    const normalized = String(value ?? "")
      .trim()
      .toLowerCase();
    if (normalized) allowed.add(normalized);
  }
  return allowed;
}

export function isAllowedOwner(owner: string, allowed: Set<string>): boolean {
  const normalized = owner.trim().toLowerCase();
  if (["", "待分配", ISSUE_UNASSIGNED].includes(normalized)) return true;
  return allowed.has(normalized);
}

const GENERIC_OWNERS = new Set([
  "",
  "待分配",
  ISSUE_UNASSIGNED,
  "backend",
  "frontend",
  "ci",
  "docs",
]);

export function mergeIssueAnalysis(
  llm: IssueAnalysis,
  rule: IssueAnalysis,
  allowedOwners: Set<string>,
): { result: IssueAnalysis; ownerValidation: OwnerValidation } {
  const merged: IssueAnalysis = { ...rule, ...llm };
  if (merged.evidence.length === 0) merged.evidence = rule.evidence;
  if (merged.duplicate_candidates.length === 0) {
    merged.duplicate_candidates = rule.duplicate_candidates;
  }
  if (
    !merged.drafts.clarification_comment &&
    !merged.drafts.task_breakdown &&
    (rule.drafts.clarification_comment || rule.drafts.task_breakdown)
  ) {
    merged.drafts = rule.drafts;
  }

  const original = merged.suggested_owner.trim();
  let final = original;
  let replaced = false;
  if (!isAllowedOwner(original, allowedOwners)) {
    final = rule.suggested_owner;
    merged.suggested_owner = final;
    merged.owner_reason = rule.owner_reason;
    replaced = true;
  } else {
    const ruleOwner = rule.suggested_owner;
    if (
      !GENERIC_OWNERS.has(ruleOwner.toLowerCase()) &&
      GENERIC_OWNERS.has(final.trim().toLowerCase())
    ) {
      final = ruleOwner;
      merged.suggested_owner = final;
      merged.owner_reason = rule.owner_reason;
      replaced = true;
    }
  }

  if (merged.category === "question" && rule.category !== "question") {
    merged.category = rule.category;
  }

  return {
    result: merged,
    ownerValidation: {
      status: replaced ? "replaced" : "accepted",
      original,
      final,
    },
  };
}

export interface PrFileFact {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
}

export interface PrFacts {
  number: number;
  title: string;
  body: string | null;
  state: string;
  author: string | null;
  mergedAt: boolean;
  files: PrFileFact[];
  comments: string[];
}

export interface PrEngineContext {
  ciSummary: {
    recentRuns: number;
    failedRuns: number;
    failed: Array<{
      name: string;
      conclusion: string | null;
      logsExcerpt: string;
    }>;
  };
  relatedIssues: Array<{ number: number; title: string; state: string }>;
  codeReferences: number;
  knowledgeEvidence: number;
  conversationEvidence: number;
}

export const SENSITIVE_FILE_TOKENS = [
  "auth",
  "security",
  "migration",
  "schema",
  "payment",
  "permission",
  "config",
  "ci",
  "workflow",
];

export const TEST_FILE_TOKENS = [
  "test",
  "spec",
  "__tests__",
  "pytest",
  "playwright",
];

export function findSensitiveFiles(filenames: string[]): string[] {
  return filenames.filter((name) =>
    SENSITIVE_FILE_TOKENS.some((token) => name.toLowerCase().includes(token)),
  );
}

export function findTestFiles(filenames: string[]): string[] {
  return filenames.filter((name) =>
    TEST_FILE_TOKENS.some((token) => name.toLowerCase().includes(token)),
  );
}

export function estimateDiffChunkCount(files: PrFileFact[]): number {
  return files.reduce(
    (total, file) => total + Math.ceil((file.patch ?? "").length / 1800),
    0,
  );
}

export function prRiskFindings(
  facts: PrFacts,
  ctx: PrEngineContext,
  riskyFiles: string[],
  testFiles: string[],
  diffChunks: number,
): {
  riskPoints: string[];
  blockingIssues: string[];
  reviewFindings: ReviewFinding[];
  failedCi: number;
} {
  const riskPoints: string[] = [];
  const blockingIssues: string[] = [];
  const reviewFindings: ReviewFinding[] = [];
  const failedCi = ctx.ciSummary.failedRuns;

  if (failedCi) {
    const message = `The repository still has ${failedCi} failed CI run(s); confirm whether this PR introduced them before merging.`;
    blockingIssues.push(message);
    reviewFindings.push({
      severity: "P1",
      title: "Failing CI blocks merge",
      evidence: message,
      required_action:
        "Fix or explain the failing CI, then re-evaluate the merge.",
      blocking: true,
    });
  }
  if (riskyFiles.length > 0) {
    const message = `Sensitive files need focused review: ${riskyFiles.slice(0, 5).join(", ")}`;
    riskPoints.push(message);
    reviewFindings.push({
      severity: "P2",
      title: "Sensitive file changes need extra validation",
      evidence: message,
      required_action:
        "Add review records, regression tests or manual verification notes.",
      blocking: true,
    });
  }
  if (facts.comments.length > 0) {
    const message = `${facts.comments.length} review comment(s) exist; confirm every one of them is addressed.`;
    riskPoints.push(message);
    blockingIssues.push(message);
    reviewFindings.push({
      severity: "P2",
      title: "Review comments still need confirmation",
      evidence: message,
      required_action:
        "Respond to each comment and confirm it is resolved before approving.",
      blocking: true,
    });
  }
  const totalPatchChars = facts.files.reduce(
    (total, file) => total + (file.patch ?? "").length,
    0,
  );
  if (totalPatchChars > 12000 || diffChunks > 8) {
    const message =
      "The diff is large; review it module by module to avoid missing cross-file impact.";
    riskPoints.push(message);
    reviewFindings.push({
      severity: "P3",
      title: "Large diff size",
      evidence: message,
      required_action:
        "Split the review path by module and add staged verification if needed.",
      blocking: false,
    });
  }
  const totalChanges = facts.files.reduce(
    (total, file) => total + file.additions + file.deletions,
    0,
  );
  if (
    facts.files.length > 0 &&
    testFiles.length === 0 &&
    (riskyFiles.length > 0 || totalChanges > 250)
  ) {
    const message =
      "This change contains no obvious test files; add automated tests or an explicit manual verification record before merging.";
    blockingIssues.push(message);
    reviewFindings.push({
      severity: "P2",
      title: "Missing test coverage evidence",
      evidence: message,
      required_action:
        "Add automated tests, or leave a verifiable manual verification record.",
      blocking: true,
    });
  }
  if (riskPoints.length === 0) {
    riskPoints.push(
      "Confirm whether boundary conditions and error paths have test coverage.",
    );
  }
  if (reviewFindings.length === 0) {
    reviewFindings.push({
      severity: "P3",
      title: "No clear blockers found",
      evidence:
        "Based on the current diff, comments and CI summary, no clear P1/P2 blocker was found.",
      required_action:
        "Finish the final human confirmation from the checklist.",
      blocking: false,
    });
  }
  return { riskPoints, blockingIssues, reviewFindings, failedCi };
}

export function chooseMergeRecommendation(
  facts: PrFacts,
  riskPoints: string[],
  blockingIssues: string[],
  failedCi: number,
): { recommendation: PRReview["merge_recommendation"]; reason: string } {
  const state = (facts.state ?? "").toLowerCase();
  const text = `${facts.title} ${facts.body ?? ""}`.toLowerCase();
  if (state === "closed" && !facts.mergedAt) {
    return {
      recommendation: "reject",
      reason:
        "The PR is closed without a merge record; merging is not recommended.",
    };
  }
  if (
    ["do not merge", "wip", "draft", "blocked", "暂缓", "不要合并"].some(
      (token) => text.includes(token),
    )
  ) {
    return {
      recommendation: "hold",
      reason:
        "The PR description contains WIP/blocked signals; wait for the author to update it.",
    };
  }
  if (failedCi) {
    return {
      recommendation: "hold",
      reason:
        "Failed CI signals exist; confirm the root cause and restore the quality gate before merging.",
    };
  }
  if (facts.files.length === 0) {
    return {
      recommendation: "hold",
      reason:
        "Changed files are missing, so the real impact range cannot be judged.",
    };
  }
  if (blockingIssues.length > 0) {
    return {
      recommendation: "merge_with_changes",
      reason:
        "Fixable blockers exist; re-evaluate after tests or explanations are added.",
    };
  }
  const riskText = riskPoints.join(" ");
  if (
    ["Sensitive files", "diff is large", "review comment"].some((token) =>
      riskText.toLowerCase().includes(token.toLowerCase()),
    )
  ) {
    return {
      recommendation: "merge_with_changes",
      reason:
        "The PR has concrete risk points; finish the focused review and validation before merging.",
    };
  }
  return {
    recommendation: "approve",
    reason:
      "No obvious blockers were found; merge after the final checklist confirmation.",
  };
}

export function buildTestSuggestions(
  filenames: string[],
  riskyFiles: string[],
  failedCi: number,
): string[] {
  const suggestions = ["Run the related unit and integration tests."];
  const lowered = filenames.join(" ").toLowerCase();
  if (
    ["frontend", ".tsx", ".ts", "next", "react"].some((token) =>
      lowered.includes(token),
    )
  ) {
    suggestions.push(
      "Run the frontend typecheck/build and cover key page interactions.",
    );
  }
  if (
    ["backend", ".py", "api", "db"].some((token) => lowered.includes(token))
  ) {
    suggestions.push(
      "Run the backend pytest and cover API or database boundaries.",
    );
  }
  if (riskyFiles.length > 0) {
    suggestions.push(
      "Add regression tests or manual verification records for the sensitive files.",
    );
  }
  if (failedCi) {
    suggestions.push("Fix the failing CI first, then rerun the full pipeline.");
  }
  return [...new Set(suggestions)];
}

export function estimatePrConfidence(
  hasFiles: boolean,
  ctx: PrEngineContext,
  failedCi: number,
  blockingIssues: string[],
): number {
  let score = 0.48;
  if (hasFiles) score += 0.12;
  if (ctx.codeReferences > 0) score += 0.08;
  if (ctx.knowledgeEvidence > 0) score += 0.06;
  if (ctx.conversationEvidence > 0) score += 0.05;
  if (failedCi) score += 0.04;
  if (blockingIssues.length > 0) score += 0.04;
  return Math.round(Math.max(0.38, Math.min(0.88, score)) * 100) / 100;
}

export function deterministicPrReview(
  facts: PrFacts,
  ctx: PrEngineContext,
): PRReview {
  const filenames = facts.files.map((file) => file.filename);
  const totalAdditions = facts.files.reduce(
    (total, file) => total + file.additions,
    0,
  );
  const totalDeletions = facts.files.reduce(
    (total, file) => total + file.deletions,
    0,
  );
  const riskyFiles = findSensitiveFiles(filenames);
  const testFiles = findTestFiles(filenames);
  const diffChunks = estimateDiffChunkCount(facts.files);
  const { riskPoints, blockingIssues, reviewFindings, failedCi } =
    prRiskFindings(facts, ctx, riskyFiles, testFiles, diffChunks);
  const { recommendation, reason } = chooseMergeRecommendation(
    facts,
    riskPoints,
    blockingIssues,
    failedCi,
  );
  return {
    summary: `PR #${facts.number} changed ${facts.files.length} file(s), mainly touching ${
      filenames.slice(0, 3).join(", ") || "no files provided"
    }.`,
    plan: [
      "Understand the PR title, description, branches, changed files and related context.",
      "Split the diff risk by module and identify sensitive paths and large changes.",
      "Read the related source code, project documents and historical conversation evidence.",
      "Check the CI status, failure records and existing review comments.",
      "Produce the merge recommendation, blockers, test suggestions and review checklist.",
    ],
    executed_steps: [
      `Read PR #${facts.number}; state ${facts.state || "unknown"}, author ${facts.author || "unknown"}.`,
      `Scanned ${facts.files.length} changed file(s), total +${totalAdditions} / -${totalDeletions}.`,
      `Identified ${riskyFiles.length} sensitive file(s), ${testFiles.length} test-related file(s), ${facts.comments.length} review comment(s).`,
      `Incorporated ${ctx.codeReferences} code leads, ${ctx.knowledgeEvidence} project documents, ${ctx.relatedIssues.length} related issue(s), ${failedCi} failed CI signal(s).`,
      `Conclusion produced: ${recommendation}.`,
    ],
    merge_recommendation: recommendation,
    recommendation_reason: reason,
    review_findings: reviewFindings,
    key_changes: filenames.slice(0, 5).map((name) => `Update ${name}`),
    risk_points:
      facts.files.length > 0
        ? riskPoints
        : ["Changed files are missing, so risk judgement is limited."],
    blocking_issues: blockingIssues,
    review_checklist: [
      "Confirm API compatibility.",
      "Confirm the error-handling paths.",
      "Confirm tests cover the key branches.",
      "Confirm all review comments are answered.",
    ],
    test_suggestions: buildTestSuggestions(filenames, riskyFiles, failedCi),
    files_need_attention: (riskyFiles.length > 0
      ? riskyFiles
      : filenames
    ).slice(0, 5),
    confidence: estimatePrConfidence(
      facts.files.length > 0,
      ctx,
      failedCi,
      blockingIssues,
    ),
  };
}

export function normalizeReviewFindings(
  items: ReviewFinding[],
  rule: ReviewFinding[],
): ReviewFinding[] {
  const source = items.length > 0 ? items : rule;
  const normalized: ReviewFinding[] = [];
  for (const item of source) {
    const severity = item.severity;
    const title = item.title.trim();
    const evidence = item.evidence.trim();
    if (!title && !evidence) continue;
    normalized.push({
      severity,
      title: title || evidence.slice(0, 80),
      evidence: evidence || title,
      required_action:
        item.required_action.trim() || "Add a verifiable follow-up note.",
      blocking: item.blocking,
    });
  }
  return normalized.length > 0 ? normalized : rule;
}

export function blockingIssuesFromFindings(
  blockingIssues: string[],
  findings: ReviewFinding[],
): string[] {
  const rows = blockingIssues.map((item) => item.trim()).filter(Boolean);
  for (const finding of findings) {
    if (
      finding.severity === "P1" ||
      finding.severity === "P2" ||
      finding.blocking
    ) {
      const action = finding.required_action.trim();
      const title = finding.title.trim();
      const message = title && action ? `${title}: ${action}` : title || action;
      if (message) rows.push(message);
    }
  }
  return [...new Set(rows)];
}

export function mergePrReview(llm: PRReview, rule: PRReview): PRReview {
  const merged: PRReview = { ...rule, ...llm };
  const listKeys = [
    "plan",
    "executed_steps",
    "review_findings",
    "key_changes",
    "risk_points",
    "blocking_issues",
    "review_checklist",
    "test_suggestions",
    "files_need_attention",
  ] as const;
  for (const key of listKeys) {
    if (merged[key].length === 0) {
      Object.assign(merged, { [key]: rule[key] });
    }
  }
  for (const key of [
    "merge_recommendation",
    "recommendation_reason",
    "summary",
  ] as const) {
    if (!merged[key].trim()) {
      Object.assign(merged, { [key]: rule[key] });
    }
  }
  merged.review_findings = normalizeReviewFindings(
    llm.review_findings,
    rule.review_findings,
  );
  merged.blocking_issues = blockingIssuesFromFindings(
    merged.blocking_issues,
    merged.review_findings,
  );
  if (
    merged.blocking_issues.length > 0 &&
    merged.merge_recommendation === "approve"
  ) {
    merged.merge_recommendation = "merge_with_changes";
    merged.recommendation_reason =
      "P1/P2 review findings are still open; finish the fixes or confirmations before merging.";
  }
  return merged;
}

export interface CiJobFact {
  name?: string;
  conclusion?: string;
  steps?: Array<{ name?: string; conclusion?: string }>;
}

export interface CiFacts {
  name: string;
  status: string;
  conclusion: string | null;
  logsText: string | null;
  jobs: CiJobFact[];
}

export interface CiEngineContext {
  recentPrs: Array<{ number: number; title: string; state: string }>;
  matchedPrNumber: number | null;
  codeReferences: number;
}

export function classifyCiFailure(logs: string): CIDebug["failure_type"] {
  const orderedRules: Array<[CIDebug["failure_type"], string[]]> = [
    ["permission", ["permission", "denied", "forbidden", "eacces", "权限"]],
    [
      "environment",
      ["missing env", "environment variable", "secret", "not set", "环境变量"],
    ],
    [
      "dependency",
      [
        "npm err",
        "pip install",
        "dependency",
        "module not found",
        "no matching distribution",
        "cannot find module",
        "依赖",
      ],
    ],
    ["lint", ["eslint", "lint", "ruff", "flake8", "biome"]],
    [
      "build",
      [
        "build failed",
        "compilation",
        "webpack",
        "vite",
        "next build",
        "tsc",
        "type error",
        "构建",
      ],
    ],
    [
      "test",
      [
        "pytest",
        "assert",
        "test failed",
        "tests failed",
        "failed tests",
        "断言",
        "测试",
      ],
    ],
  ];
  for (const [failureType, tokens] of orderedRules) {
    if (tokens.some((token) => logs.includes(token))) return failureType;
  }
  return "unknown";
}

export function extractFirstError(logs: string): string | undefined {
  if (!logs.trim()) return undefined;
  const lines = logs
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const markers = [
    "error",
    "failed",
    "failure",
    "exception",
    "traceback",
    "assertionerror",
    "npm err",
    "fatal",
  ];
  for (let index = 0; index < lines.length; index += 1) {
    const lowered = lines[index].toLowerCase();
    if (markers.some((token) => lowered.includes(token))) {
      const start = Math.max(0, index - 2);
      const end = Math.min(lines.length, index + 5);
      return lines.slice(start, end).join("\n").slice(0, 900);
    }
  }
  return lines.slice(0, 6).join("\n").slice(0, 900);
}

export function extractRelatedFiles(logs: string): string[] {
  const candidates =
    logs.match(
      /[\w./\\-]+\.(?:py|ts|tsx|js|jsx|json|ya?ml|toml|ini|cfg|md)/g,
    ) ?? [];
  const normalized: string[] = [];
  for (const item of candidates) {
    const cleaned = item
      .replace(/^["'`(){}[\]:,;]+|["'`(){}[\]:,;]+$/g, "")
      .replaceAll("\\", "/");
    if (cleaned && !normalized.includes(cleaned)) normalized.push(cleaned);
  }
  return normalized.slice(0, 8);
}

export function inferCiRootCause(
  failureType: CIDebug["failure_type"],
  firstError: string | undefined,
  failedJobNames: string[],
  failedSteps: string[],
): string {
  const scope = [
    failedJobNames.slice(0, 2).join(", "),
    failedSteps.slice(0, 2).join(", "),
  ]
    .filter(Boolean)
    .join(", ");
  const suffix = scope ? ` (${scope})` : "";
  switch (failureType) {
    case "test":
      return `The failure is concentrated in the test phase${suffix}; the first error points to an assertion, a case, or inconsistent behavior under test.`;
    case "build":
      return `The failure is concentrated in the build/type-check phase${suffix}; the first error usually comes from compilation, typing or bundling configuration.`;
    case "dependency":
      return "The logs show dependency installation or module resolution failing; check the lockfile, package versions and CI cache first.";
    case "permission":
      return "The logs show insufficient permissions or denied access; check the token, file permissions and workflow permission configuration first.";
    case "environment":
      return "The logs show a missing environment variable or secret; check the workflow env configuration and repository secrets first.";
    case "lint":
      return "The logs show lint/format checks failing; locate the rule violations in the reported files and run lint locally.";
    default:
      return `The logs lack a definitive classification signal; the first error block is the most reliable entry point: ${
        firstError ? firstError.slice(0, 160) : "no logs provided"
      }`;
  }
}

export function ciPossibleCauses(
  failureType: CIDebug["failure_type"],
): string[] {
  const mapping: Record<CIDebug["failure_type"], string[]> = {
    test: [
      "Test assertions are inconsistent.",
      "A recent change altered interface behavior.",
      "Test data or environment initialization is incomplete.",
    ],
    build: [
      "Type or compilation errors.",
      "Build configuration no longer matches the code.",
      "Generated artifacts or path references are missing.",
    ],
    lint: [
      "Format or static-rule violations.",
      "New code was not linted locally.",
      "A rule upgrade changed the enforced rules.",
    ],
    dependency: [
      "Dependency version drift.",
      "The lockfile is out of sync.",
      "CI cache or registry configuration is broken.",
    ],
    permission: [
      "Insufficient workflow permissions.",
      "Token scope is too narrow.",
      "The script writes into a restricted directory.",
    ],
    environment: [
      "Missing environment variable.",
      "A secret is not configured.",
      "CI defaults differ from the local configuration.",
    ],
    unknown: [
      "The first error block is inconclusive.",
      "An upstream command swallowed the real error.",
      "The full job log needs to be inspected.",
    ],
  };
  return mapping[failureType];
}

export function ciFixSteps(
  failureType: CIDebug["failure_type"],
  relatedFiles: string[],
): string[] {
  const focus =
    relatedFiles.length > 0
      ? `, focusing on ${relatedFiles.slice(0, 3).join(", ")}`
      : "";
  const mapping: Record<CIDebug["failure_type"], string[]> = {
    test: [
      `Run the failing test command locally and reproduce it${focus}.`,
      "Compare against recent PR changes to confirm the expected behavior.",
      "Fix the code or test data, then add a regression case.",
    ],
    build: [
      `Run the build/type-check command locally${focus}.`,
      "Fix the first compilation or type error.",
      "Confirm generated paths, import paths and config files are updated together.",
    ],
    lint: [
      `Run the lint/format commands locally${focus}.`,
      "Fix the first rule violation.",
      "Adjust the rule only when necessary and document why.",
    ],
    dependency: [
      "Reinstall dependencies and confirm the lockfile was updated.",
      "Check that package/requirements versions match CI.",
      "Clear the CI cache and rerun.",
    ],
    permission: [
      "Check the workflow permissions configuration.",
      "Confirm the token/secrets scope.",
      "Avoid writing to restricted directories or calling restricted APIs in scripts.",
    ],
    environment: [
      "Add the missing workflow env or repository secrets.",
      "Provide consistent defaults for local runs and CI.",
      "Avoid leaking secret plaintext in logs.",
    ],
    unknown: [
      "Expand the full job log.",
      "Find the stderr of the earliest failing command.",
      "Add diagnostic output to the workflow and rerun if needed.",
    ],
  };
  return mapping[failureType];
}

export function isCiMergeBlocking(
  facts: Pick<CiFacts, "status" | "conclusion">,
  failureType: CIDebug["failure_type"],
): boolean {
  const conclusion = (facts.conclusion ?? "").toLowerCase();
  const status = (facts.status ?? "").toLowerCase();
  return (
    conclusion === "failure" ||
    (status === "completed" && failureType !== "unknown")
  );
}

export function estimateCiConfidence(
  firstError: string | undefined,
  failedJobCount: number,
  relatedFileCount: number,
  ctx: CiEngineContext,
): number {
  let score = 0.42;
  if (firstError) score += 0.16;
  if (failedJobCount > 0) score += 0.12;
  if (relatedFileCount > 0) score += 0.08;
  if (ctx.recentPrs.length > 0) score += 0.05;
  if (ctx.codeReferences > 0) score += 0.05;
  return Math.round(Math.max(0.36, Math.min(0.86, score)) * 100) / 100;
}

export function deterministicCiDebug(
  facts: CiFacts,
  ctx: CiEngineContext,
): CIDebug {
  const logs = (facts.logsText ?? "").toLowerCase();
  const rawLogs = facts.logsText ?? "";
  const failedJobs = facts.jobs.filter((job) => job.conclusion === "failure");
  const failedSteps = failedJobs.flatMap((job) =>
    (job.steps ?? [])
      .filter((step) => step.conclusion === "failure" && step.name)
      .map((step) => String(step.name)),
  );
  const failureType = classifyCiFailure(logs);
  const firstError = extractFirstError(rawLogs);
  const relatedFiles = extractRelatedFiles(rawLogs);
  const failedJobNames = failedJobs
    .map((job) => (job.name ? String(job.name) : ""))
    .filter(Boolean);
  const jobHint =
    failedJobNames.length > 0
      ? ` Failed job(s): ${failedJobNames.slice(0, 3).join(", ")}.`
      : "";
  const stepHint =
    failedSteps.length > 0
      ? ` Failed step(s): ${failedSteps.slice(0, 3).join(", ")}.`
      : "";
  const isBlocking = isCiMergeBlocking(facts, failureType);
  return {
    failure_summary: `${facts.name || "CI run"} execution failed.${jobHint}${stepHint} Inspect the logs to locate the first error block.`,
    failure_type: failureType,
    plan: [
      "Find the failed jobs and failed steps.",
      "Extract the first key error block.",
      "Classify the failure: dependency, test, build, permission, environment or unknown.",
      "Search the related code, test files and workflow configuration.",
      "Correlate with recent PRs or changed modules.",
      "Output the root cause, fix steps and the merge-blocking judgement.",
    ],
    executed_steps: [
      `Identified ${failedJobs.length} failed job(s): ${failedJobNames.slice(0, 3).join(", ") || "no job details provided"}.`,
      `Identified ${failedSteps.length} failed step(s): ${failedSteps.slice(0, 3).join(", ") || "no step details provided"}.`,
      `Extracted the first key error block: ${firstError ? clipInline(firstError, 200) : "no explicit error block found in the logs"}.`,
      `Classified the failure type as ${failureType} with ${relatedFiles.length} related file(s).`,
      `Correlated ${ctx.recentPrs.length} recent PR signal(s)${ctx.matchedPrNumber ? ` (matched PR #${ctx.matchedPrNumber})` : ""} and ${ctx.codeReferences} code/config lead(s).`,
      "Generated the root cause, fix steps and the blocking judgement.",
    ],
    ...(firstError ? { first_error: firstError } : {}),
    root_cause: inferCiRootCause(
      failureType,
      firstError,
      failedJobNames,
      failedSteps,
    ),
    possible_causes: ciPossibleCauses(failureType),
    fix_steps: ciFixSteps(failureType, relatedFiles),
    debug_steps: [
      "Inspect the first error block of the failed job.",
      "Reproduce the failing command locally.",
      "Check the files touched by recent PRs.",
      "After the fix, rerun the failed job and the full workflow.",
    ],
    related_files: relatedFiles,
    is_merge_blocking: isBlocking,
    blocking_reason: isBlocking
      ? "The workflow run conclusion is failure, which is a quality gate that must be restored before merging."
      : "The workflow run has no failure conclusion, so it does not block merging.",
    confidence: estimateCiConfidence(
      firstError,
      failedJobs.length,
      relatedFiles.length,
      ctx,
    ),
  };
}

export function mergeCiDebug(llm: CIDebug, rule: CIDebug): CIDebug {
  const merged: CIDebug = { ...rule, ...llm };
  for (const key of [
    "plan",
    "executed_steps",
    "possible_causes",
    "fix_steps",
    "debug_steps",
    "related_files",
  ] as const) {
    if (merged[key].length === 0) {
      Object.assign(merged, { [key]: rule[key] });
    }
  }
  for (const key of [
    "failure_summary",
    "root_cause",
    "blocking_reason",
  ] as const) {
    if (!merged[key].trim()) {
      Object.assign(merged, { [key]: rule[key] });
    }
  }
  if (merged.failure_type === "unknown" && rule.failure_type !== "unknown") {
    merged.failure_type = rule.failure_type;
  }
  if (!merged.first_error) merged.first_error = rule.first_error;
  return merged;
}

export async function analyzeIssue(
  issueId: string,
): Promise<AnalysisRecord<IssueAnalysis>> {
  const issue = await prisma.issue.findUnique({
    where: { id: issueId },
    include: { repo: true },
  });
  if (!issue) throw new Error(`Issue ${issueId} not found`);

  const siblings = await prisma.issue.findMany({
    where: { repoId: issue.repoId, id: { not: issueId } },
    orderBy: { githubUpdatedAt: "desc" },
    take: SIMILAR_ISSUES,
    select: { number: true, title: true, body: true, state: true },
  });
  const currentText = `${issue.title}\n${clip(issue.body, 600)}`;
  const duplicateCandidates = siblings
    .map((sibling) => ({
      number: sibling.number,
      title: sibling.title,
      score: lexicalDuplicateScore(
        currentText,
        `${sibling.title}\n${clip(sibling.body, 600)}`,
      ),
    }))
    .filter((candidate) => candidate.score >= 0.25)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

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
  } catch {}

  const [teamRows, issueAuthors, prAuthors] = await Promise.all([
    listTeamMembers(issue.repoId),
    prisma.issue.findMany({
      where: { repoId: issue.repoId },
      select: { author: true },
      distinct: ["author"],
    }),
    prisma.pullRequest.findMany({
      where: { repoId: issue.repoId },
      select: { author: true },
      distinct: ["author"],
    }),
  ]);
  const teamMembers = teamRows.map(toTeamMemberProfile);
  const historicalAuthors = [
    ...issueAuthors.map((row) => row.author ?? ""),
    ...prAuthors.map((row) => row.author ?? ""),
  ];
  const ownerAllowList = buildOwnerAllowList({
    assignees: issue.assignees,
    author: issue.author,
    historicalAuthors,
    teamLogins: teamMembers.map((member) => member.name),
  });

  const facts: IssueFacts = {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels,
    author: issue.author,
    assignees: issue.assignees,
  };
  const engineContext: IssueEngineContext = {
    duplicateCandidates,
    knowledgeEvidence: knowledge,
    teamMembers,
  };

  const rule = deterministicIssueAnalysis(facts, engineContext);

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
    duplicate_candidates: duplicateCandidates,
    knowledge_evidence: knowledge,
    team_members: teamMembers,
    allowed_owners: [...ownerAllowList],
  };

  let result = rule;
  let mode: GenerationMode = "deterministic";
  let ownerValidation: OwnerValidation | undefined;
  if (llmConfigured()) {
    try {
      const llmOut = await generateStructured({
        name: "devflow-issue-analysis",
        system: ISSUE_ANALYSIS_PROMPT,
        prompt: JSON.stringify(input, null, 2),
        schema: IssueAnalysisSchema,
      });
      const merged = mergeIssueAnalysis(llmOut, rule, ownerAllowList);
      result = merged.result;
      ownerValidation = merged.ownerValidation;
      mode = "llm";
    } catch (e) {
      console.warn(
        "[devflow-analysis] issue LLM failed; persisting deterministic result:",
        e,
      );
    }
  }

  const provenance: AnalysisProvenance = {
    generationMode: mode,
    ...(ownerValidation ? { ownerValidation } : {}),
  };
  const id = await saveAnalysis({
    targetType: "issue",
    targetId: issueId,
    analysisType: "issue_analysis",
    inputSnapshot: {
      issue_number: issue.number,
      title: issue.title,
      evidence_counts: {
        duplicates: duplicateCandidates.length,
        knowledge: knowledge.length,
        team_members: teamMembers.length,
      },
    },
    result: { ...result, ...provenance },
  });
  return { id, result: { ...result, ...provenance }, createdAt: new Date() };
}

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

  const recentRuns = await prisma.workflowRun.findMany({
    where: { repoId: pr.repoId },
    orderBy: { githubCreatedAt: "desc" },
    take: 8,
    select: { name: true, conclusion: true, logsText: true },
  });
  const failedRuns = recentRuns.filter((run) => run.conclusion === "failure");
  const ciSummary = {
    recentRuns: recentRuns.length,
    failedRuns: failedRuns.length,
    failed: failedRuns.slice(0, 4).map((run) => ({
      name: run.name,
      conclusion: run.conclusion,
      logsExcerpt: (run.logsText ?? "").slice(0, 260),
    })),
  };

  const refNumbers = [
    ...new Set(
      [...`${pr.title}\n${pr.body ?? ""}`.matchAll(/#(\d+)/g)].map((m) =>
        Number(m[1]),
      ),
    ),
  ];
  const branchTokens = [
    ...new Set(
      (pr.headBranch ?? "")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length >= 3),
    ),
  ].slice(0, 4);
  type IssueMatch = {
    number?: { in: number[] };
    title?: { contains: string; mode: "insensitive" };
  };
  const conditions: IssueMatch[] = [];
  if (refNumbers.length > 0) conditions.push({ number: { in: refNumbers } });
  for (const token of branchTokens) {
    conditions.push({ title: { contains: token, mode: "insensitive" } });
  }
  const relatedIssueRows =
    conditions.length > 0
      ? await prisma.issue.findMany({
          where: { repoId: pr.repoId, OR: conditions },
          take: 4,
          orderBy: { githubUpdatedAt: "desc" },
          select: { number: true, title: true, state: true },
        })
      : [];
  const relatedIssues = relatedIssueRows.map((row) => ({
    number: row.number,
    title: row.title,
    state: row.state,
  }));

  const codeImpact = await impactForFiles(
    pr.repoId,
    pr.files.map((file) => file.filename),
  ).catch(() => null);
  const codeImpactSummary = summarizeCodeImpact(codeImpact);

  const facts: PrFacts = {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    author: pr.author,
    mergedAt: pr.mergedAt !== null,
    files: pr.files.map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patch: file.patch,
    })),
    comments: pr.reviewComments
      .map((comment) => comment.body ?? "")
      .filter((body) => body.trim().length > 0),
  };
  const engineContext: PrEngineContext = {
    ciSummary,
    relatedIssues,
    codeReferences: codeImpact?.dependents.length ?? 0,
    knowledgeEvidence: 0,
    conversationEvidence: 0,
  };

  const rule = deterministicPrReview(facts, engineContext);

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
    ci_summary: ciSummary,
    related_issues: relatedIssues,
    code_impact: codeImpactSummary,
    diff_stats: {
      files: pr.files.length,
      additions: pr.additions,
      deletions: pr.deletions,
      sensitive_files: findSensitiveFiles(
        pr.files.map((file) => file.filename),
      ),
    },
  };

  let result = rule;
  let mode: GenerationMode = "deterministic";
  if (llmConfigured()) {
    try {
      const llmOut = await generateStructured({
        name: "devflow-pr-review",
        system: PR_REVIEW_PROMPT,
        prompt: JSON.stringify(input, null, 2),
        schema: PRReviewSchema,
      });
      result = mergePrReview(llmOut, rule);
      mode = "llm";
    } catch (e) {
      console.warn(
        "[devflow-analysis] PR review LLM failed; persisting deterministic result:",
        e,
      );
    }
  }

  const provenance: AnalysisProvenance = { generationMode: mode };
  const id = await saveAnalysis({
    targetType: "pull_request",
    targetId: prId,
    analysisType: "pr_review",
    inputSnapshot: {
      pr_number: pr.number,
      title: pr.title,
      evidence_counts: {
        files: pr.files.length,
        comments: pr.reviewComments.length,
        failed_ci: ciSummary.failedRuns,
        related_issues: relatedIssues.length,
        sensitive_files: input.diff_stats.sensitive_files.length,
      },
    },
    result: { ...result, ...provenance },
  });
  return { id, result: { ...result, ...provenance }, createdAt: new Date() };
}

function summarizeCodeImpact(impact: ImpactReport | null) {
  if (impact === null) return null;
  const symbols = impact.symbols.slice(0, 20).map((s) => ({
    name: s.name,
    kind: s.kind,
    path: s.path,
    start_line: s.startLine,
  }));
  const dependents = impact.dependents.slice(0, 20).map((d) => ({
    path: d.path,
    source: d.sourceName,
    target: d.targetName,
    type: d.type,
    same_file: d.sameFile,
  }));
  if (symbols.length === 0 && dependents.length === 0) return null;
  return {
    symbols,
    dependents,
    truncated: impact.symbols.length > 20 || impact.dependents.length > 20,
  };
}

function parseCiJobs(jobs: unknown): CiJobFact[] {
  if (!Array.isArray(jobs)) return [];
  const rows: CiJobFact[] = [];
  for (const job of jobs) {
    if (typeof job !== "object" || job === null) continue;
    const record = job as Record<string, unknown>;
    const steps = Array.isArray(record.steps)
      ? record.steps
          .filter(
            (step): step is Record<string, unknown> =>
              typeof step === "object" && step !== null,
          )
          .map((step) => ({
            name: typeof step.name === "string" ? step.name : undefined,
            conclusion:
              typeof step.conclusion === "string" ? step.conclusion : undefined,
          }))
      : undefined;
    rows.push({
      name: typeof record.name === "string" ? record.name : undefined,
      conclusion:
        typeof record.conclusion === "string" ? record.conclusion : undefined,
      steps,
    });
  }
  return rows;
}

export async function debugRun(
  runId: string,
): Promise<AnalysisRecord<CIDebug>> {
  const run = await prisma.workflowRun.findUnique({
    where: { id: runId },
    include: { repo: true },
  });
  if (!run) throw new Error(`Workflow run ${runId} not found`);

  const recentPrRows = await prisma.pullRequest.findMany({
    where: { repoId: run.repoId },
    orderBy: { githubUpdatedAt: "desc" },
    take: 8,
    select: { number: true, title: true, state: true, headBranch: true },
  });
  const logsHaystack = `${run.name}\n${run.logsText ?? ""}`.toLowerCase();
  const matchedPr = recentPrRows.find(
    (prRow) =>
      prRow.headBranch &&
      prRow.headBranch.length > 0 &&
      logsHaystack.includes(prRow.headBranch.toLowerCase()),
  );
  const engineContext: CiEngineContext = {
    recentPrs: recentPrRows.slice(0, 5).map((prRow) => ({
      number: prRow.number,
      title: prRow.title,
      state: prRow.state,
    })),
    matchedPrNumber: matchedPr ? matchedPr.number : null,
    codeReferences: 0,
  };

  const facts: CiFacts = {
    name: run.name,
    status: run.status,
    conclusion: run.conclusion,
    logsText: run.logsText,
    jobs: parseCiJobs(run.jobs),
  };

  const rule = deterministicCiDebug(facts, engineContext);

  const ciCodeImpact =
    rule.related_files.length > 0
      ? await impactForFiles(run.repoId, rule.related_files).catch(() => null)
      : null;

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
    context: {
      first_error: rule.first_error ?? null,
      related_files_from_logs: rule.related_files,
      rule_failure_type: rule.failure_type,
      recent_prs: engineContext.recentPrs,
      matched_pr_number: engineContext.matchedPrNumber,
      code_impact: summarizeCodeImpact(ciCodeImpact),
    },
  };

  let result = rule;
  let mode: GenerationMode = "deterministic";
  if (llmConfigured()) {
    try {
      const llmOut = await generateStructured({
        name: "devflow-ci-debug",
        system: CI_DEBUG_PROMPT,
        prompt: JSON.stringify(input, null, 2),
        schema: CIDebugSchema,
      });
      result = mergeCiDebug(llmOut, rule);
      mode = "llm";
    } catch (e) {
      console.warn(
        "[devflow-analysis] CI debug LLM failed; persisting deterministic result:",
        e,
      );
    }
  }

  const provenance: AnalysisProvenance = { generationMode: mode };
  const id = await saveAnalysis({
    targetType: "workflow_run",
    targetId: runId,
    analysisType: "ci_debug",
    inputSnapshot: {
      run_name: run.name,
      conclusion: run.conclusion,
      evidence_counts: {
        jobs: facts.jobs.length,
        failed_jobs: facts.jobs.filter((job) => job.conclusion === "failure")
          .length,
        related_prs: engineContext.recentPrs.length,
        has_logs: Boolean(run.logsText),
      },
    },
    result: { ...result, ...provenance },
  });
  return { id, result: { ...result, ...provenance }, createdAt: new Date() };
}

export async function latestAnalysis(targetType: string, targetId: string) {
  return prisma.analysisResult.findFirst({
    where: { targetType, targetId },
    orderBy: { createdAt: "desc" },
  });
}
