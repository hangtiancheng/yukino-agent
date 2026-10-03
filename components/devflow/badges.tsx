"use client";

// Domain status badges for the DevFlow workspace, built on the shadcn Badge.
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { IssueConclusion, MergeRecommendation } from "@/lib/devflow/types";

export function IssueStateBadge({ state }: { state: string }) {
  const variant = state === "open" ? "default" : "secondary";
  return (
    <Badge variant={variant} className="capitalize">
      {state}
    </Badge>
  );
}

export function PrStateBadge({ state }: { state: string }) {
  const className =
    state === "merged"
      ? "border-transparent bg-violet-500/15 text-violet-700 dark:text-violet-300"
      : state === "open"
        ? "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
        : "bg-secondary text-secondary-foreground";
  return <Badge className={cn("capitalize", className)}>{state}</Badge>;
}

export function CiConclusionBadge({
  status,
  conclusion,
}: {
  status: string;
  conclusion: string | null;
}) {
  const value = conclusion ?? status;
  const className =
    value === "success"
      ? "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
      : value === "failure"
        ? "border-transparent bg-red-500/15 text-red-700 dark:text-red-300"
        : value === "cancelled" || value === "timed_out"
          ? "bg-secondary text-secondary-foreground"
          : value === "in_progress" || value === "queued"
            ? "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300"
            : "bg-secondary text-secondary-foreground";
  return (
    <Badge className={cn("capitalize", className)}>
      {value.replaceAll("_", " ")}
    </Badge>
  );
}

const PRIORITY_CLASSES: Record<string, string> = {
  P0: "border-transparent bg-red-500/15 text-red-700 dark:text-red-300",
  P1: "border-transparent bg-orange-500/15 text-orange-700 dark:text-orange-300",
  P2: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300",
  P3: "border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-300",
};

export function PriorityBadge({ priority }: { priority: string }) {
  return (
    <Badge className={PRIORITY_CLASSES[priority] ?? "bg-secondary"}>
      {priority}
    </Badge>
  );
}

export function SeverityBadge({ severity }: { severity: string }) {
  return <PriorityBadge priority={severity} />;
}

const CONCLUSION_LABELS: Record<IssueConclusion, string> = {
  start_development: "Start development",
  needs_clarification: "Needs clarification",
  close: "Close",
  split: "Split",
  merge_duplicate: "Merge duplicate",
};

const CONCLUSION_CLASSES: Record<IssueConclusion, string> = {
  start_development:
    "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  needs_clarification:
    "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300",
  close: "bg-secondary text-secondary-foreground",
  split: "border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-300",
  merge_duplicate:
    "border-transparent bg-violet-500/15 text-violet-700 dark:text-violet-300",
};

export function ConclusionBadge({
  conclusion,
}: {
  conclusion: IssueConclusion;
}) {
  return (
    <Badge className={CONCLUSION_CLASSES[conclusion] ?? "bg-secondary"}>
      {CONCLUSION_LABELS[conclusion] ?? conclusion}
    </Badge>
  );
}

const MERGE_LABELS: Record<MergeRecommendation, string> = {
  approve: "Approve",
  merge_with_changes: "Merge with changes",
  hold: "Hold",
  reject: "Reject",
};

const MERGE_CLASSES: Record<MergeRecommendation, string> = {
  approve:
    "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  merge_with_changes:
    "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300",
  hold: "border-transparent bg-orange-500/15 text-orange-700 dark:text-orange-300",
  reject: "border-transparent bg-red-500/15 text-red-700 dark:text-red-300",
};

export function MergeRecommendationBadge({
  recommendation,
}: {
  recommendation: MergeRecommendation;
}) {
  return (
    <Badge className={MERGE_CLASSES[recommendation] ?? "bg-secondary"}>
      {MERGE_LABELS[recommendation] ?? recommendation}
    </Badge>
  );
}

const RISK_CLASSES: Record<string, string> = {
  low: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  medium:
    "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300",
  high: "border-transparent bg-red-500/15 text-red-700 dark:text-red-300",
};

export function RiskBadge({ level }: { level: string }) {
  return (
    <Badge className={RISK_CLASSES[level] ?? "bg-secondary"}>
      {level} risk
    </Badge>
  );
}

const DRAFT_STATUS_CLASSES: Record<string, string> = {
  pending_confirmation:
    "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300",
  executed:
    "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  rejected: "bg-secondary text-secondary-foreground",
  failed: "border-transparent bg-red-500/15 text-red-700 dark:text-red-300",
};

export function DraftStatusBadge({ status }: { status: string }) {
  return (
    <Badge className={DRAFT_STATUS_CLASSES[status] ?? "bg-secondary"}>
      {status.replaceAll("_", " ")}
    </Badge>
  );
}

export function DocStatusBadge({ status }: { status: string }) {
  const className =
    status === "ready"
      ? "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
      : status === "failed"
        ? "border-transparent bg-red-500/15 text-red-700 dark:text-red-300"
        : status === "skipped"
          ? "bg-secondary text-secondary-foreground"
          : "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300";
  return <Badge className={className}>{status}</Badge>;
}

export function ConfidenceBadge({ confidence }: { confidence: number }) {
  const pct = Math.round(confidence * 100);
  const className =
    pct >= 80
      ? "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
      : pct >= 55
        ? "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300"
        : "border-transparent bg-red-500/15 text-red-700 dark:text-red-300";
  return <Badge className={className}>{pct}% confidence</Badge>;
}
