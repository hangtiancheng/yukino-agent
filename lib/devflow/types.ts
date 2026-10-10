export interface RepoSummary {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  provider: string;
  apiBaseUrl: string | null;
  description: string | null;
  defaultBranch: string | null;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  hasToken: boolean;
  checkoutMode: string;
  localPath: string | null;
  cloneParentDir: string | null;
  createdAt: string;
  counts: {
    issues: number;
    pullRequests: number;
    workflowRuns: number;
    knowledgeDocuments: number;
    actionDrafts?: number;
  };
}

export interface IssueSummary {
  id: string;
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: string[];
  author: string | null;
  assignees: string[];
  githubCreatedAt: string | null;
  githubUpdatedAt: string | null;
  latestAnalysis: { id: string; createdAt: string } | null;
}

export interface PullSummary {
  id: string;
  number: number;
  title: string;
  body: string | null;
  state: string;
  author: string | null;
  baseBranch: string | null;
  headBranch: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  mergedAt: string | null;
  githubCreatedAt: string | null;
  githubUpdatedAt: string | null;
  files: Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
  }>;
  reviewCommentCount: number;
  latestAnalysis: { id: string; createdAt: string } | null;
}

export interface RunSummary {
  id: string;
  githubRunId: string | null;
  name: string;
  headBranch: string | null;
  status: string;
  conclusion: string | null;
  htmlUrl: string | null;
  hasLogs: boolean;
  jobs: Array<{
    id?: number;
    name?: string;
    status?: string;
    conclusion?: string;
    html_url?: string;
    steps?: Array<{
      name?: string;
      status?: string;
      conclusion?: string;
      number?: number;
    }>;
  }> | null;
  githubCreatedAt: string | null;
  latestAnalysis: { id: string; createdAt: string } | null;
}

export interface AnalysisRecord {
  id: string;
  analysisType: string;
  result: unknown;
  modelName: string | null;
  createdAt: string;
}

export type IssueConclusion =
  | "start_development"
  | "needs_clarification"
  | "close"
  | "split"
  | "merge_duplicate";

export interface IssueAnalysis {
  summary: string;
  conclusion: IssueConclusion;
  conclusion_reason: string;
  category: string;
  priority: "P0" | "P1" | "P2" | "P3";
  complexity: "S" | "M" | "L" | "XL";
  suggested_owner: string;
  owner_reason: string;
  duplicate_candidates: Array<{
    number: number;
    title: string;
    reason: string;
  }>;
  evidence: Array<{ source_type: string; title: string; snippet: string }>;
  checklist: string[];
  drafts: {
    clarification_comment?: string;
    task_breakdown?: string;
  };
  confidence: number;
}

export type MergeRecommendation =
  "approve" | "merge_with_changes" | "hold" | "reject";

export interface ReviewFinding {
  severity: "P1" | "P2" | "P3";
  title: string;
  evidence: string;
  required_action: string;
  blocking: boolean;
}

export interface PRReview {
  summary: string;
  plan: string[];
  executed_steps: string[];
  merge_recommendation: MergeRecommendation;
  recommendation_reason: string;
  review_findings: ReviewFinding[];
  key_changes: string[];
  risk_points: string[];
  blocking_issues: string[];
  review_checklist: string[];
  test_suggestions: string[];
  files_need_attention: string[];
  confidence: number;
}

export interface CIDebug {
  failure_summary: string;
  failure_type:
    | "test"
    | "build"
    | "lint"
    | "dependency"
    | "permission"
    | "environment"
    | "unknown";
  plan: string[];
  executed_steps: string[];
  first_error?: string;
  root_cause: string;
  possible_causes: string[];
  fix_steps: string[];
  debug_steps: string[];
  related_files: string[];
  is_merge_blocking: boolean;
  blocking_reason: string;
  confidence: number;
}

export interface KnowledgeDoc {
  id: string;
  name: string;
  sourceType: string;
  status: string;
  charCount: number;
  chunkCount: number;
  errorMessage: string | null;
  createdAt: string;
}

export interface KnowledgeHit {
  docId: string;
  docName: string;
  chunkIndex: number;
  score: number;
  content: string;
  sectionTitle?: string;
  rankReason?: string;
}

export interface KnowledgeCitation {
  index: number;
  docName: string;
  snippet: string;
  score: number;
}

export interface ActionDraft {
  id: string;
  repoId: string;
  repoFullName: string;
  draftType: string;
  targetType: string | null;
  targetNumber: number | null;
  title: string;
  content: string | null;
  labels: string[];
  riskLevel: string;
  status: string;
  executionResult: unknown;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationSummary {
  id: string;
  repoId: string;
  title: string;
  status: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessageView {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  toolCalls: Array<{ name: string; input?: unknown }>;
  meta: Record<string, unknown>;
  createdAt: string;
  feedback: { rating: string; reviewStatus: string } | null;
}

export type FeedbackRating = "helpful" | "unhelpful";
export type FeedbackReason =
  | "inaccurate"
  | "not_relevant"
  | "missing_context"
  | "unreliable_citation"
  | "tool_error"
  | "other";
export type FeedbackReviewStatus =
  "open" | "in_review" | "resolved" | "dismissed";

export interface FeedbackView {
  id: string;
  repoId: string;
  conversationId: string;
  assistantMessageId: string;
  rating: FeedbackRating;
  reason: FeedbackReason | null;
  comment: string | null;
  reviewStatus: FeedbackReviewStatus;
  reviewNote: string | null;
  notificationStatus: string;
  notificationError: string | null;
  notifiedAt: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FeedbackMetrics {
  repoId: string;
  assistantMessages: number;
  ratedMessages: number;
  feedbackCoverage: number;
  helpful: number;
  unhelpful: number;
  helpfulRate: number;
  unhelpfulRate: number;
  negativeFeedbackRate: number;
  openReviews: number;
  reasonCounts: Record<string, number>;
}

export interface FeedbackTrace {
  traceId: string;
  repository: { id: string; fullName: string } | null;
  conversation: { id: string; title: string } | null;
  feedback: FeedbackView | null;
  messages: {
    user: {
      id: string;
      role: string;
      content: string;
      createdAt: string;
    } | null;
    assistant: {
      id: string;
      role: string;
      content: string;
      toolCalls: Array<{ name: string; input?: unknown }>;
      createdAt: string;
    } | null;
  };
}

export interface WorkspaceStatus {
  cloned: boolean;
  path: string;
  branch: string | null;
  commitSha: string | null;
}

export interface FileEntry {
  path: string;
  type: "file" | "dir";
  size: number | null;
}

export interface FileContent {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
}

export interface CodeSearchHit {
  path: string;
  line: number;
  snippet: string;
  score: number;
}

export interface ProjectIndexState {
  status: string;
  fingerprint: string | null;
  branch: string | null;
  commitSha: string | null;
  fileCount: number;
  chunkCount: number;
  summary: {
    techStack?: string[];
    topDirs?: string[];
    sourceTypeCoverage?: Record<string, number>;
    docs?: Array<{ path: string; tier: string; sourceType: string }>;
  } | null;
  errorMessage: string | null;
  lastIndexedAt: string | null;
  stale: boolean;
  checkoutCloned: boolean;
  snoozedUntil?: string | null;
  snoozed?: boolean;
}

export interface DevflowStats {
  repos: number;
  openIssues: number;
  closedIssues: number;
  openPrs: number;
  mergedPrs: number;
  failedRuns: number;
  totalRuns: number;
  knowledgeDocs: number;
  pendingDrafts: number;
  analyses: number;
  recentIssues: Array<{
    id: string;
    number: number;
    title: string;
    state: string;
    repoId: string;
  }>;
  recentPrs: Array<{
    id: string;
    number: number;
    title: string;
    state: string;
    repoId: string;
  }>;
  recentFailedRuns: Array<{
    id: string;
    name: string;
    headBranch: string | null;
    repoId: string;
    githubCreatedAt: string | null;
  }>;
}
