import { z } from "zod/v4";

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

export const RepoConnectSchema = z
  .object({
    owner: z.string().min(1).max(200).optional(),
    repo: z.string().min(1).max(200).optional(),
    provider: z.enum(["github", "github_compatible"]).default("github"),
    apiBaseUrl: z.string().url().optional(),
    token: z.string().min(1).optional(),
    localPath: z.string().min(1).max(1000).optional(),
    cloneParentDir: z.string().min(1).max(1000).optional(),
  })
  .refine(
    (v) => Boolean(v.localPath) || (Boolean(v.owner) && Boolean(v.repo)),
    {
      message: "Provide either a local repository path or owner/repository",
    },
  );

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
    "send_report",
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

export const ProjectIndexSnoozeSchema = z.object({
  action: z.literal("snooze"),
  days: z.number().int().min(1).max(365).default(7),
});

export const AuditLogsQuerySchema = z.object({
  repoId: z.string().min(1).optional(),
  action: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const ConversationMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200),
  beforeMessageId: z.string().min(1).optional(),
});

const GitHubActorSchema = z
  .object({
    id: z.number().nullish(),
    login: z.string().nullish(),
  })
  .loose();

const GitHubLabelSchema = z
  .object({
    name: z.string().nullish(),
    color: z.string().nullish(),
    description: z.string().nullish(),
  })
  .loose();

const GitHubLabelListSchema = z
  .array(z.union([z.string(), GitHubLabelSchema]))
  .nullish();

const GitHubBranchSchema = z
  .object({
    ref: z.string().nullish(),
    sha: z.string().nullish(),
    label: z.string().nullish(),
  })
  .loose();

export const GitHubRepoSchema = z
  .object({
    id: z.number(),
    name: z.string().nullish(),
    full_name: z.string().nullish(),
    private: z.boolean().nullish(),
    description: z.string().nullish(),
    default_branch: z.string().nullish(),
    clone_url: z.string().nullish(),
    html_url: z.string().nullish(),
  })
  .loose();
export type GitHubRepo = z.infer<typeof GitHubRepoSchema>;

export const GitHubIssueSchema = z
  .object({
    id: z.number(),
    number: z.number(),
    title: z.string().nullish(),
    body: z.string().nullish(),
    state: z.string().nullish(),
    labels: GitHubLabelListSchema,
    user: GitHubActorSchema.nullish(),
    assignees: z.array(GitHubActorSchema).nullish(),
    created_at: z.string().nullish(),
    updated_at: z.string().nullish(),
    closed_at: z.string().nullish(),
    pull_request: z.record(z.string(), z.unknown()).nullish(),
  })
  .loose();
export type GitHubIssue = z.infer<typeof GitHubIssueSchema>;

export const GitHubPullRequestSchema = z
  .object({
    id: z.number(),
    number: z.number(),
    title: z.string().nullish(),
    body: z.string().nullish(),
    state: z.string().nullish(),
    merged_at: z.string().nullish(),
    closed_at: z.string().nullish(),
    user: GitHubActorSchema.nullish(),
    base: GitHubBranchSchema.nullish(),
    head: GitHubBranchSchema.nullish(),
    labels: GitHubLabelListSchema,
    additions: z.number().nullish(),
    deletions: z.number().nullish(),
    changed_files: z.number().nullish(),
    created_at: z.string().nullish(),
    updated_at: z.string().nullish(),
  })
  .loose();
export type GitHubPullRequest = z.infer<typeof GitHubPullRequestSchema>;

export const GitHubPullRequestFileSchema = z
  .object({
    sha: z.string().nullish(),
    filename: z.string().nullish(),
    status: z.string().nullish(),
    additions: z.number().nullish(),
    deletions: z.number().nullish(),
    changes: z.number().nullish(),
    patch: z.string().nullish(),
  })
  .loose();
export type GitHubPullRequestFile = z.infer<typeof GitHubPullRequestFileSchema>;

export const GitHubReviewCommentSchema = z
  .object({
    id: z.number().nullish(),
    body: z.string().nullish(),
    path: z.string().nullish(),
    line: z.number().nullish(),
    original_line: z.number().nullish(),
    user: GitHubActorSchema.nullish(),
    created_at: z.string().nullish(),
    updated_at: z.string().nullish(),
  })
  .loose();
export type GitHubReviewComment = z.infer<typeof GitHubReviewCommentSchema>;

export const GitHubWorkflowRunSchema = z
  .object({
    id: z.number(),
    name: z.string().nullish(),
    display_title: z.string().nullish(),
    event: z.string().nullish(),
    run_number: z.number().nullish(),
    status: z.string().nullish(),
    conclusion: z.string().nullish(),
    head_branch: z.string().nullish(),
    html_url: z.string().nullish(),
    created_at: z.string().nullish(),
    updated_at: z.string().nullish(),
  })
  .loose();
export type GitHubWorkflowRun = z.infer<typeof GitHubWorkflowRunSchema>;

export const GitHubWorkflowRunsResponseSchema = z
  .object({
    total_count: z.number().nullish(),
    workflow_runs: z.array(GitHubWorkflowRunSchema).optional(),
  })
  .loose();

const GitHubJobStepSchema = z
  .object({
    name: z.string().nullish(),
    status: z.string().nullish(),
    conclusion: z.string().nullish(),
    number: z.number().nullish(),
  })
  .loose();

export const GitHubWorkflowJobSchema = z
  .object({
    id: z.number().nullish(),
    name: z.string().nullish(),
    status: z.string().nullish(),
    conclusion: z.string().nullish(),
    html_url: z.string().nullish(),
    started_at: z.string().nullish(),
    completed_at: z.string().nullish(),
    steps: z.array(GitHubJobStepSchema).nullish(),
  })
  .loose();
export type GitHubWorkflowJob = z.infer<typeof GitHubWorkflowJobSchema>;

export const GitHubWorkflowJobsResponseSchema = z
  .object({
    total_count: z.number().nullish(),
    jobs: z.array(GitHubWorkflowJobSchema).optional(),
  })
  .loose();

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
