"use client";

// Domain status badges for the DevFlow workspace, built on the shadcn Badge.
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import type { IssueConclusion, MergeRecommendation } from "@/lib/devflow/types";

const ISSUE_STATE_KEYS: Record<string, "open" | "closed"> = {
  open: "open",
  closed: "closed",
};

export function IssueStateBadge({ state }: { state: string }) {
  const t = useTranslations("devflow.badges");
  const variant = state === "open" ? "default" : "secondary";
  const key = ISSUE_STATE_KEYS[state];
  return (
    <Badge variant={variant}>{key ? t(`issueState.${key}`) : state}</Badge>
  );
}

const PR_STATE_KEYS: Record<string, "open" | "closed" | "merged"> = {
  open: "open",
  closed: "closed",
  merged: "merged",
};

export function PrStateBadge({ state }: { state: string }) {
  const t = useTranslations("devflow.badges");
  const className =
    state === "merged"
      ? "border-transparent bg-violet-500/15 text-violet-700 dark:text-violet-300"
      : state === "open"
        ? "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
        : "bg-secondary text-secondary-foreground";
  const key = PR_STATE_KEYS[state];
  return (
    <Badge className={className}>{key ? t(`prState.${key}`) : state}</Badge>
  );
}

const CI_KEYS: Record<
  string,
  | "queued"
  | "inProgress"
  | "completed"
  | "waiting"
  | "requested"
  | "pending"
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "skipped"
  | "timedOut"
  | "actionRequired"
  | "stale"
  | "startupFailure"
> = {
  queued: "queued",
  in_progress: "inProgress",
  completed: "completed",
  waiting: "waiting",
  requested: "requested",
  pending: "pending",
  success: "success",
  failure: "failure",
  neutral: "neutral",
  cancelled: "cancelled",
  skipped: "skipped",
  timed_out: "timedOut",
  action_required: "actionRequired",
  stale: "stale",
  startup_failure: "startupFailure",
};

export function CiConclusionBadge({
  status,
  conclusion,
  label,
}: {
  status: string;
  conclusion: string | null;
  label?: string;
}) {
  const t = useTranslations("devflow.badges");
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
  const key = CI_KEYS[value];
  return (
    <Badge className={className}>
      {label ?? (key ? t(`ci.${key}`) : value.replaceAll("_", " "))}
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

const CONCLUSION_KEYS: Record<
  IssueConclusion,
  | "startDevelopment"
  | "needsClarification"
  | "close"
  | "split"
  | "mergeDuplicate"
> = {
  start_development: "startDevelopment",
  needs_clarification: "needsClarification",
  close: "close",
  split: "split",
  merge_duplicate: "mergeDuplicate",
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
  const t = useTranslations("devflow.badges");
  const key = CONCLUSION_KEYS[conclusion];
  return (
    <Badge className={CONCLUSION_CLASSES[conclusion] ?? "bg-secondary"}>
      {key ? t(`conclusion.${key}`) : conclusion}
    </Badge>
  );
}

const MERGE_KEYS: Record<
  MergeRecommendation,
  "approve" | "mergeWithChanges" | "hold" | "reject"
> = {
  approve: "approve",
  merge_with_changes: "mergeWithChanges",
  hold: "hold",
  reject: "reject",
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
  const t = useTranslations("devflow.badges");
  const key = MERGE_KEYS[recommendation];
  return (
    <Badge className={MERGE_CLASSES[recommendation] ?? "bg-secondary"}>
      {key ? t(`merge.${key}`) : recommendation}
    </Badge>
  );
}

const RISK_KEYS: Record<string, "low" | "medium" | "high"> = {
  low: "low",
  medium: "medium",
  high: "high",
};

const RISK_CLASSES: Record<string, string> = {
  low: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  medium:
    "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300",
  high: "border-transparent bg-red-500/15 text-red-700 dark:text-red-300",
};

export function RiskBadge({ level }: { level: string }) {
  const t = useTranslations("devflow.badges");
  const key = RISK_KEYS[level];
  return (
    <Badge className={RISK_CLASSES[level] ?? "bg-secondary"}>
      {key ? t(`risk.${key}`) : level}
    </Badge>
  );
}

const DRAFT_STATUS_KEYS: Record<
  string,
  "pendingConfirmation" | "executed" | "rejected" | "failed"
> = {
  pending_confirmation: "pendingConfirmation",
  executed: "executed",
  rejected: "rejected",
  failed: "failed",
};

const DRAFT_STATUS_CLASSES: Record<string, string> = {
  pending_confirmation:
    "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300",
  executed:
    "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  rejected: "bg-secondary text-secondary-foreground",
  failed: "border-transparent bg-red-500/15 text-red-700 dark:text-red-300",
};

export function DraftStatusBadge({ status }: { status: string }) {
  const t = useTranslations("devflow.badges");
  const key = DRAFT_STATUS_KEYS[status];
  return (
    <Badge className={DRAFT_STATUS_CLASSES[status] ?? "bg-secondary"}>
      {key ? t(`draftStatus.${key}`) : status.replaceAll("_", " ")}
    </Badge>
  );
}

const DOC_STATUS_KEYS: Record<
  string,
  "pending" | "indexing" | "ready" | "failed" | "skipped"
> = {
  pending: "pending",
  indexing: "indexing",
  ready: "ready",
  failed: "failed",
  skipped: "skipped",
};

export function DocStatusBadge({ status }: { status: string }) {
  const t = useTranslations("devflow.badges");
  const className =
    status === "ready"
      ? "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
      : status === "failed"
        ? "border-transparent bg-red-500/15 text-red-700 dark:text-red-300"
        : status === "skipped"
          ? "bg-secondary text-secondary-foreground"
          : "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300";
  const key = DOC_STATUS_KEYS[status];
  return (
    <Badge className={className}>{key ? t(`docStatus.${key}`) : status}</Badge>
  );
}

export function ConfidenceBadge({ confidence }: { confidence: number }) {
  const t = useTranslations("devflow.badges");
  const pct = Math.round(confidence * 100);
  const className =
    pct >= 80
      ? "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
      : pct >= 55
        ? "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300"
        : "border-transparent bg-red-500/15 text-red-700 dark:text-red-300";
  return <Badge className={className}>{t("confidence", { pct })}</Badge>;
}
