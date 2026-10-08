"use client";

// Structured renderers for the three DevFlow analysis agents. Each view turns
// the agent's JSON output into a readable report with badges, checklists and
// evidence cards — replacing the raw JSON <pre> dumps of the original UI.
import { useTranslations } from "next-intl";
import {
  AlertTriangle,
  CheckCircle2,
  FileCode2,
  ListChecks,
  Quote,
  Terminal,
  UserRound,
  Wrench,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  CiConclusionBadge,
  ConfidenceBadge,
  ConclusionBadge,
  MergeRecommendationBadge,
  PriorityBadge,
  SeverityBadge,
} from "./badges";
import type { CIDebug, IssueAnalysis, PRReview } from "@/lib/devflow/types";

// Provenance attached by lib/devflow/agents/analysis.ts to every persisted
// result. Optional so historical analyses (without the fields) still render.
type GenerationMode = "llm" | "deterministic";

interface AnalysisProvenance {
  generationMode?: GenerationMode;
  ownerValidation?: {
    status?: "accepted" | "replaced";
    original?: string;
    final?: string;
  };
}

export type IssueAnalysisReport = IssueAnalysis & AnalysisProvenance;
export type PRReviewReport = PRReview & AnalysisProvenance;
export type CIDebugReport = CIDebug & AnalysisProvenance;

const GENERATION_MODE_KEYS: Record<string, "llm" | "deterministic"> = {
  llm: "llm",
  deterministic: "deterministic",
};

function GenerationModeBadge({ mode }: { mode?: GenerationMode }) {
  const t = useTranslations("devflow.analysis");
  const key = GENERATION_MODE_KEYS[mode ?? "llm"] ?? "llm";
  return (
    <Badge
      variant={key === "deterministic" ? "secondary" : "outline"}
      className="text-[10px]"
    >
      {t(`generationMode.${key}`)}
    </Badge>
  );
}

function SectionTitle({
  icon: Icon,
  children,
}: {
  icon: typeof ListChecks;
  children: React.ReactNode;
}) {
  return (
    <div className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium tracking-wide uppercase">
      <Icon className="size-3.5" />
      {children}
    </div>
  );
}

function StringList({ items }: { items: string[] }) {
  const t = useTranslations("devflow.analysis");
  if (items.length === 0) {
    return (
      <p className="text-muted-foreground text-sm italic">
        {t("noneReported")}
      </p>
    );
  }
  return (
    <ul className="space-y-1.5">
      {items.map((item, i) => (
        <li
          key={i}
          className="text-foreground flex gap-2 text-sm leading-relaxed"
        >
          <span className="text-muted-foreground mt-0.5 shrink-0 text-xs">
            {String(i + 1).padStart(2, "0")}
          </span>
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Issue triage
// ---------------------------------------------------------------------------

export function IssueAnalysisView({
  analysis,
}: {
  analysis: IssueAnalysisReport;
}) {
  const t = useTranslations("devflow.analysis");
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 pt-5">
          <p className="text-foreground text-sm leading-relaxed">
            {analysis.summary}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <ConclusionBadge conclusion={analysis.conclusion} />
            <Badge variant="outline" className="capitalize">
              {analysis.category}
            </Badge>
            <PriorityBadge priority={analysis.priority} />
            <Badge variant="outline">
              {t("complexity", { complexity: analysis.complexity })}
            </Badge>
            <ConfidenceBadge confidence={analysis.confidence} />
            <GenerationModeBadge mode={analysis.generationMode} />
          </div>
          <Separator />
          <div className="space-y-1">
            <SectionTitle icon={AlertTriangle}>{t("why")}</SectionTitle>
            <p className="text-muted-foreground text-sm leading-relaxed">
              {analysis.conclusion_reason}
            </p>
          </div>
          {analysis.suggested_owner ? (
            <div className="space-y-1">
              <SectionTitle icon={UserRound}>
                {t("suggestedOwner")}
              </SectionTitle>
              <p className="text-foreground text-sm">
                <span className="font-medium">
                  {analysis.suggested_owner === "unassigned"
                    ? t("unassignedOwner")
                    : analysis.suggested_owner}
                </span>
                {analysis.owner_reason ? (
                  <span className="text-muted-foreground">
                    {" "}
                    — {analysis.owner_reason}
                  </span>
                ) : null}
              </p>
              {analysis.ownerValidation?.status === "replaced" ? (
                <p className="text-muted-foreground text-xs">
                  {t("ownerValidationReplaced", {
                    original: analysis.ownerValidation.original || "—",
                    final:
                      analysis.ownerValidation.final === "unassigned"
                        ? t("unassignedOwner")
                        : analysis.ownerValidation.final || "—",
                  })}
                </p>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {analysis.duplicate_candidates.length > 0 ? (
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm">{t("possibleDuplicates")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {analysis.duplicate_candidates.map((dup) => (
              <div
                key={dup.number}
                className="bg-muted/50 rounded-md px-3 py-2 text-sm"
              >
                <span className="text-muted-foreground font-mono">
                  #{dup.number}
                </span>{" "}
                <span className="text-foreground">{dup.title}</span>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  {dup.reason}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="flex items-center gap-1.5 text-sm">
              <ListChecks className="text-muted-foreground size-4" />
              {t("nextActions")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <StringList items={analysis.checklist} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="flex items-center gap-1.5 text-sm">
              <Quote className="text-muted-foreground size-4" />
              {t("evidence")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {analysis.evidence.length === 0 ? (
              <p className="text-muted-foreground text-sm italic">
                {t("noEvidence")}
              </p>
            ) : (
              analysis.evidence.map((item, i) => (
                <div
                  key={i}
                  className="border-border rounded-md border px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className="text-[10px]">
                      {item.source_type}
                    </Badge>
                    <span className="text-foreground truncate text-xs font-medium">
                      {item.title}
                    </span>
                  </div>
                  <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
                    {item.snippet}
                  </p>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      {analysis.drafts.clarification_comment ||
      analysis.drafts.task_breakdown ? (
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm">{t("suggestedDrafts")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {analysis.drafts.clarification_comment ? (
              <div>
                <SectionTitle icon={Wrench}>
                  {t("clarificationComment")}
                </SectionTitle>
                <pre className="bg-muted/50 text-foreground mt-1 rounded-md p-3 text-xs whitespace-pre-wrap">
                  {analysis.drafts.clarification_comment}
                </pre>
              </div>
            ) : null}
            {analysis.drafts.task_breakdown ? (
              <div>
                <SectionTitle icon={ListChecks}>
                  {t("taskBreakdown")}
                </SectionTitle>
                <pre className="bg-muted/50 text-foreground mt-1 rounded-md p-3 text-xs whitespace-pre-wrap">
                  {analysis.drafts.task_breakdown}
                </pre>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PR review
// ---------------------------------------------------------------------------

const FINDING_ORDER = { P1: 0, P2: 1, P3: 2 } as const;

export function PRReviewView({ review }: { review: PRReviewReport }) {
  const t = useTranslations("devflow.analysis");
  const tb = useTranslations("devflow.badges");
  const findings = [...review.review_findings].sort(
    (a, b) => FINDING_ORDER[a.severity] - FINDING_ORDER[b.severity],
  );
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 pt-5">
          <p className="text-foreground text-sm leading-relaxed">
            {review.summary}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <MergeRecommendationBadge
              recommendation={review.merge_recommendation}
            />
            <ConfidenceBadge confidence={review.confidence} />
            <GenerationModeBadge mode={review.generationMode} />
            <Badge variant="outline">
              {tb("blockingCount", {
                count: findings.filter((f) => f.blocking).length,
              })}
            </Badge>
          </div>
          {review.recommendation_reason ? (
            <p className="text-muted-foreground text-sm leading-relaxed">
              {review.recommendation_reason}
            </p>
          ) : null}
        </CardContent>
      </Card>

      {findings.length > 0 ? (
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="flex items-center gap-1.5 text-sm">
              <AlertTriangle className="text-muted-foreground size-4" />
              {t("reviewFindings")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {findings.map((finding, i) => (
              <div key={i} className="border-border rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <SeverityBadge severity={finding.severity} />
                  <span className="text-foreground text-sm font-medium">
                    {finding.title}
                  </span>
                  {finding.blocking ? (
                    <Badge variant="destructive">{tb("blocking")}</Badge>
                  ) : null}
                </div>
                <p className="text-muted-foreground mt-2 text-xs leading-relaxed">
                  <span className="font-medium">{t("evidenceLabel")}</span>{" "}
                  {finding.evidence}
                </p>
                <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
                  <span className="font-medium">{t("requiredAction")}</span>{" "}
                  {finding.required_action}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm">{t("keyChanges")}</CardTitle>
          </CardHeader>
          <CardContent>
            <StringList items={review.key_changes} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm">{t("riskPoints")}</CardTitle>
          </CardHeader>
          <CardContent>
            <StringList items={review.risk_points} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="flex items-center gap-1.5 text-sm">
              <CheckCircle2 className="text-muted-foreground size-4" />
              {t("reviewChecklist")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <StringList items={review.review_checklist} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="flex items-center gap-1.5 text-sm">
              <Terminal className="text-muted-foreground size-4" />
              {t("testSuggestions")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <StringList items={review.test_suggestions} />
          </CardContent>
        </Card>
      </div>

      {review.files_need_attention.length > 0 ? (
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="flex items-center gap-1.5 text-sm">
              <FileCode2 className="text-muted-foreground size-4" />
              {t("filesNeedingAttention")}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-1.5">
            {review.files_need_attention.map((file) => (
              <Badge key={file} variant="outline" className="font-mono text-xs">
                {file}
              </Badge>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CI debug
// ---------------------------------------------------------------------------

export function CIDebugView({ debug }: { debug: CIDebugReport }) {
  const t = useTranslations("devflow.analysis");
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 pt-5">
          <p className="text-foreground text-sm leading-relaxed">
            {debug.failure_summary}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="capitalize">
              {debug.failure_type}
            </Badge>
            <CiConclusionBadge
              status={debug.is_merge_blocking ? "failure" : "success"}
              conclusion={null}
              label={
                debug.is_merge_blocking ? t("mergeBlocking") : t("nonBlocking")
              }
            />
            <ConfidenceBadge confidence={debug.confidence} />
            <GenerationModeBadge mode={debug.generationMode} />
          </div>
          {debug.blocking_reason ? (
            <p className="text-muted-foreground text-sm">
              {debug.blocking_reason}
            </p>
          ) : null}
        </CardContent>
      </Card>

      {debug.first_error ? (
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm">{t("firstError")}</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="overflow-x-auto rounded-md bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-100">
              {debug.first_error}
            </pre>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-sm">{t("rootCause")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-foreground text-sm leading-relaxed">
            {debug.root_cause}
          </p>
          {debug.possible_causes.length > 0 ? (
            <div>
              <SectionTitle icon={AlertTriangle}>
                {t("alternativeHypotheses")}
              </SectionTitle>
              <div className="mt-1.5">
                <StringList items={debug.possible_causes} />
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="flex items-center gap-1.5 text-sm">
              <Wrench className="text-muted-foreground size-4" />
              {t("fixSteps")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <StringList items={debug.fix_steps} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm">{t("furtherDebugging")}</CardTitle>
          </CardHeader>
          <CardContent>
            <StringList items={debug.debug_steps} />
          </CardContent>
        </Card>
      </div>

      {debug.related_files.length > 0 ? (
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="flex items-center gap-1.5 text-sm">
              <FileCode2 className="text-muted-foreground size-4" />
              {t("relatedFiles")}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-1.5">
            {debug.related_files.map((file) => (
              <Badge key={file} variant="outline" className="font-mono text-xs">
                {file}
              </Badge>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
