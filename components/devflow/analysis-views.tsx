"use client";

// Structured renderers for the three DevFlow analysis agents. Each view turns
// the agent's JSON output into a readable report with badges, checklists and
// evidence cards — replacing the raw JSON <pre> dumps of the original UI.
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
  if (items.length === 0) {
    return (
      <p className="text-muted-foreground text-sm italic">None reported.</p>
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

export function IssueAnalysisView({ analysis }: { analysis: IssueAnalysis }) {
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
            <Badge variant="outline">Complexity {analysis.complexity}</Badge>
            <ConfidenceBadge confidence={analysis.confidence} />
          </div>
          <Separator />
          <div className="space-y-1">
            <SectionTitle icon={AlertTriangle}>Why</SectionTitle>
            <p className="text-muted-foreground text-sm leading-relaxed">
              {analysis.conclusion_reason}
            </p>
          </div>
          {analysis.suggested_owner ? (
            <div className="space-y-1">
              <SectionTitle icon={UserRound}>Suggested owner</SectionTitle>
              <p className="text-foreground text-sm">
                <span className="font-medium">{analysis.suggested_owner}</span>
                {analysis.owner_reason ? (
                  <span className="text-muted-foreground">
                    {" "}
                    — {analysis.owner_reason}
                  </span>
                ) : null}
              </p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {analysis.duplicate_candidates.length > 0 ? (
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm">Possible duplicates</CardTitle>
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
              Next actions
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
              Evidence
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {analysis.evidence.length === 0 ? (
              <p className="text-muted-foreground text-sm italic">
                No evidence cited.
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
            <CardTitle className="text-sm">Suggested drafts</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {analysis.drafts.clarification_comment ? (
              <div>
                <SectionTitle icon={Wrench}>Clarification comment</SectionTitle>
                <pre className="bg-muted/50 text-foreground mt-1 rounded-md p-3 text-xs whitespace-pre-wrap">
                  {analysis.drafts.clarification_comment}
                </pre>
              </div>
            ) : null}
            {analysis.drafts.task_breakdown ? (
              <div>
                <SectionTitle icon={ListChecks}>Task breakdown</SectionTitle>
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

export function PRReviewView({ review }: { review: PRReview }) {
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
            <Badge variant="outline">
              {findings.filter((f) => f.blocking).length} blocking
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
              Review findings
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
                    <Badge variant="destructive">blocking</Badge>
                  ) : null}
                </div>
                <p className="text-muted-foreground mt-2 text-xs leading-relaxed">
                  <span className="font-medium">Evidence:</span>{" "}
                  {finding.evidence}
                </p>
                <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
                  <span className="font-medium">Required action:</span>{" "}
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
            <CardTitle className="text-sm">Key changes</CardTitle>
          </CardHeader>
          <CardContent>
            <StringList items={review.key_changes} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm">Risk points</CardTitle>
          </CardHeader>
          <CardContent>
            <StringList items={review.risk_points} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="flex items-center gap-1.5 text-sm">
              <CheckCircle2 className="text-muted-foreground size-4" />
              Review checklist
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
              Test suggestions
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
              Files needing attention
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

export function CIDebugView({ debug }: { debug: CIDebug }) {
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
              conclusion={
                debug.is_merge_blocking ? "merge blocking" : "non-blocking"
              }
            />
            <ConfidenceBadge confidence={debug.confidence} />
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
            <CardTitle className="text-sm">First error</CardTitle>
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
          <CardTitle className="text-sm">Root cause</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-foreground text-sm leading-relaxed">
            {debug.root_cause}
          </p>
          {debug.possible_causes.length > 0 ? (
            <div>
              <SectionTitle icon={AlertTriangle}>
                Alternative hypotheses
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
              Fix steps
            </CardTitle>
          </CardHeader>
          <CardContent>
            <StringList items={debug.fix_steps} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm">Further debugging</CardTitle>
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
              Related files
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
