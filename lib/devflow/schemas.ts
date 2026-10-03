// Zod schemas for DevFlow: agent structured outputs (ported from the Python
// pydantic schemas, translated to English) and API request payloads.
import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// Agent structured outputs
// ---------------------------------------------------------------------------

export const IssueConclusionSchema = z.enum([
  "start_development",
  "needs_clarification",
  "close",
  "split",
  "merge_duplicate",
]);

export const IssueCategorySchema = z.enum([
  "bug",
  "feature",
  "question",
  "documentation",
  "refactor",
  "test",
  "ops",
]);

export const PrioritySchema = z.enum(["P0", "P1", "P2", "P3"]);
export const ComplexitySchema = z.enum(["S", "M", "L", "XL"]);

export const IssueAnalysisSchema = z.object({
  summary: z.string(),
  conclusion: IssueConclusionSchema,
  conclusion_reason: z.string(),
  category: IssueCategorySchema,
  priority: PrioritySchema,
  complexity: ComplexitySchema,
  suggested_owner: z.string(),
  owner_reason: z.string(),
  duplicate_candidates: z.array(
    z.object({
      number: z.number(),
      title: z.string(),
      reason: z.string(),
    }),
  ),
  evidence: z.array(
    z.object({
      source_type: z.string(),
      title: z.string(),
      snippet: z.string(),
    }),
  ),
  checklist: z.array(z.string()),
  drafts: z.object({
    clarification_comment: z.string().optional(),
    task_breakdown: z.string().optional(),
  }),
  confidence: z.number().min(0).max(1),
});
export type IssueAnalysis = z.infer<typeof IssueAnalysisSchema>;

export const MergeRecommendationSchema = z.enum([
  "approve",
  "merge_with_changes",
  "hold",
  "reject",
]);

export const ReviewFindingSchema = z.object({
  severity: z.enum(["P1", "P2", "P3"]),
  title: z.string(),
  evidence: z.string(),
  required_action: z.string(),
  blocking: z.boolean(),
});

export const PRReviewSchema = z.object({
  summary: z.string(),
  plan: z.array(z.string()),
  executed_steps: z.array(z.string()),
  merge_recommendation: MergeRecommendationSchema,
  recommendation_reason: z.string(),
  review_findings: z.array(ReviewFindingSchema),
  key_changes: z.array(z.string()),
  risk_points: z.array(z.string()),
  blocking_issues: z.array(z.string()),
  review_checklist: z.array(z.string()),
  test_suggestions: z.array(z.string()),
  files_need_attention: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});
export type PRReview = z.infer<typeof PRReviewSchema>;

export const FailureTypeSchema = z.enum([
  "test",
  "build",
  "lint",
  "dependency",
  "permission",
  "environment",
  "unknown",
]);

export const CIDebugSchema = z.object({
  failure_summary: z.string(),
  failure_type: FailureTypeSchema,
  plan: z.array(z.string()),
  executed_steps: z.array(z.string()),
  first_error: z.string().optional(),
  root_cause: z.string(),
  possible_causes: z.array(z.string()),
  fix_steps: z.array(z.string()),
  debug_steps: z.array(z.string()),
  related_files: z.array(z.string()),
  is_merge_blocking: z.boolean(),
  blocking_reason: z.string(),
  confidence: z.number().min(0).max(1),
});
export type CIDebug = z.infer<typeof CIDebugSchema>;

// ---------------------------------------------------------------------------
// API request payloads
// ---------------------------------------------------------------------------

export const RepoConnectSchema = z.object({
  owner: z.string().min(1).max(200),
  repo: z.string().min(1).max(200),
  provider: z.enum(["github", "github_compatible"]).default("github"),
  apiBaseUrl: z.string().url().optional(),
  token: z.string().min(1).optional(),
});

export const RepoSyncSchema = z.object({
  syncIssues: z.boolean().default(true),
  syncPulls: z.boolean().default(true),
  syncRuns: z.boolean().default(true),
  limit: z.number().int().min(1).max(100).default(30),
});

export const WeeklyReportSchema = z.object({
  repoId: z.string().min(1),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const DevflowChatSchema = z.object({
  repoId: z.string().min(1),
  // Omitted on the first turn of a new conversation; the server resolves or
  // creates the conversation and returns its id in the `done` SSE event.
  conversationId: z.string().min(1).optional(),
  message: z.string().min(1).max(8000),
});

export const FeedbackRatingSchema = z.enum(["helpful", "unhelpful"]);
export const FeedbackReasonSchema = z.enum([
  "inaccurate",
  "not_relevant",
  "missing_context",
  "unreliable_citation",
  "tool_error",
  "other",
]);
export const ReviewStatusSchema = z.enum([
  "open",
  "in_review",
  "resolved",
  "dismissed",
]);

export const FeedbackCreateSchema = z
  .object({
    repoId: z.string().min(1),
    conversationId: z.string().min(1),
    assistantMessageId: z.string().min(1),
    rating: FeedbackRatingSchema,
    reason: FeedbackReasonSchema.optional(),
    comment: z.string().max(1000).optional(),
  })
  .refine((v) => !(v.rating === "helpful" && v.reason !== undefined), {
    message: "Helpful feedback must not include a negative reason",
  });

export const FeedbackReviewSchema = z.object({
  reviewStatus: ReviewStatusSchema,
  reviewNote: z.string().max(2000).optional(),
});

export const KnowledgeSearchSchema = z.object({
  repoId: z.string().min(1),
  query: z.string().min(1).max(2000),
  topK: z.number().int().min(1).max(20).default(5),
});

export const KnowledgeAskSchema = z.object({
  repoId: z.string().min(1),
  question: z.string().min(1).max(2000),
  topK: z.number().int().min(1).max(20).default(5),
});

export const DraftCreateSchema = z.object({
  repoId: z.string().min(1),
  draftType: z.enum([
    "issue_comment",
    "create_issue",
    "close_issue",
    "add_labels",
  ]),
  targetType: z.enum(["issue", "pull_request"]).optional(),
  targetNumber: z.number().int().positive().optional(),
  title: z.string().max(300).default(""),
  content: z.string().max(20000).default(""),
  labels: z.array(z.string().max(100)).max(20).default([]),
  riskLevel: z.enum(["low", "medium", "high"]).default("medium"),
});

export const DraftActionSchema = z.object({
  action: z.enum(["execute", "reject"]),
});

// ---------------------------------------------------------------------------
// Display metadata for enum values (used by the frontend)
// ---------------------------------------------------------------------------

export const CONCLUSION_LABELS: Record<
  z.infer<typeof IssueConclusionSchema>,
  string
> = {
  start_development: "Start development",
  needs_clarification: "Needs clarification",
  close: "Close",
  split: "Split",
  merge_duplicate: "Merge into existing issue",
};

export const MERGE_RECOMMENDATION_LABELS: Record<
  z.infer<typeof MergeRecommendationSchema>,
  string
> = {
  approve: "Approve",
  merge_with_changes: "Merge with changes",
  hold: "Hold",
  reject: "Reject",
};
