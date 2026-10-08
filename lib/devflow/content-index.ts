// GitHub history content as semantically-searchable RAG sources — TS port of
// the DevFlow-AI `services/rag/indexing.py:71-204` + `source_policy.py:9-30`
// data layer (the legacy `source_policy` GitHub-content search surface;
// Yukino.md #30/#35). Issues (title+body+labels), pull requests
// (title+body+changed-files summary+review comments) and failed workflow runs
// (secret-sanitized logs, ≤8000 chars × ≤6 chunks per legacy
// indexing.py:10-11) are indexed into the SHARED Milvus collection under
// `source = "devflow:item:<repoId>:<type>:<itemId>"`, with the same row-id /
// parent / sibling conventions the retrieval pipeline (dedup, per-parent cap,
// sibling expansion in lib/devflow/search.ts) was built on, so item chunks
// behave exactly like KB documents at query time.
import { prisma } from "@/lib/db";
import { indexChunks, deleteBySourcePrefix } from "@/lib/milvus/indexer";
import { count as milvusCount } from "@/lib/milvus/client";
import type { RetrievedDoc } from "@/lib/milvus/retriever";
import { chunkDocument, siblingIdsByParent, type Chunk } from "./chunking";
import { chunkRowMetadata } from "./rag";
import { sanitizeCiLog } from "./sanitize";

// ---------------------------------------------------------------------------
// Source policy (port of services/rag/source_policy.py:5-49)
// ---------------------------------------------------------------------------

export type RetrievalMode = "rag" | "direct";

// RAG is reserved for reusable, unstructured project knowledge where semantic
// recall is useful; structured live facts stay in their source tables/APIs.
const RAG_SOURCE_TYPES = new Set([
  "issue",
  "pull_request",
  "workflow_run",
  "project_doc",
  "knowledge_file",
  "memory_note",
]);

const DIRECT_SOURCE_TYPES = new Set([
  "project_overview",
  "project_manifest",
  "team_member",
  "weekly_report",
  "chat_session",
  "conversation_memory",
  "thread_memory",
]);

export function retrievalMode(sourceType: string): RetrievalMode {
  if (RAG_SOURCE_TYPES.has(sourceType)) return "rag";
  if (DIRECT_SOURCE_TYPES.has(sourceType)) return "direct";
  // Legacy default: unknown types are direct (source_policy.py:33-36).
  return "direct";
}

export function shouldVectorize(sourceType: string): boolean {
  return retrievalMode(sourceType) === "rag";
}

export function isSearchableSource(sourceType: string): boolean {
  return retrievalMode(sourceType) === "rag";
}

// ---------------------------------------------------------------------------
// Source naming + filter expressions
// ---------------------------------------------------------------------------

export const CONTENT_SOURCE_PREFIX = "devflow:item";

// The three synced item types (SYNCED_REPO_SOURCE_TYPES, indexing.py:9).
export const CONTENT_SOURCE_TYPES = [
  "issue",
  "pull_request",
  "workflow_run",
] as const;
export type ContentSourceType = (typeof CONTENT_SOURCE_TYPES)[number];

export function contentSource(
  repoId: string,
  sourceType: ContentSourceType,
  itemId: string,
): string {
  return `${CONTENT_SOURCE_PREFIX}:${repoId}:${sourceType}:${itemId}`;
}

// Prefix used for full-repo rebuild deletes (also what repo deletion should
// clean up — see cleanupRepoContentIndex below).
export function contentRepoPrefix(repoId: string): string {
  return `${CONTENT_SOURCE_PREFIX}:${repoId}:`;
}

// Milvus filter scoping retrieval to one repo's synced items; pass a type to
// scope to one item type (e.g. the similar-issues endpoint filters
// `devflow:item:<repoId>:issue:%`).
export function contentScopeFilter(
  repoId: string,
  sourceType?: ContentSourceType,
): string {
  const tail = sourceType ? `${sourceType}:` : "";
  return `source like "${contentRepoPrefix(repoId)}${tail}%"`;
}

// ---------------------------------------------------------------------------
// CI log windowing (port of indexing.py:43-52 _ci_log_chunks; the secret
// scrubbing itself lives in lib/devflow/sanitize.ts)
// ---------------------------------------------------------------------------

export const CI_LOG_CHUNK_CHARS = 8_000;
export const CI_LOG_MAX_CHUNKS = 6;

export function ciLogChunks(text: string): {
  chunks: string[];
  truncated: boolean;
} {
  const sanitized = sanitizeCiLog(text.trim());
  const maxChars = CI_LOG_CHUNK_CHARS * CI_LOG_MAX_CHUNKS;
  const bounded = sanitized.slice(0, maxChars);
  const chunks: string[] = [];
  for (let start = 0; start < bounded.length; start += CI_LOG_CHUNK_CHARS) {
    const piece = bounded.slice(start, start + CI_LOG_CHUNK_CHARS);
    if (piece.trim() !== "") chunks.push(piece);
  }
  return { chunks, truncated: sanitized.length > maxChars };
}

// ---------------------------------------------------------------------------
// Item payload builders (pure; fixture-testable)
// ---------------------------------------------------------------------------

export interface IssueContentInput {
  id: string;
  number: number;
  title: string;
  body: string | null;
  labels: string[];
  state: string;
  author: string | null;
  assignees: string[];
  createdAt: Date | null;
  updatedAt: Date | null;
  closedAt: Date | null;
}

export interface PrFileContentInput {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface PrReviewCommentInput {
  path: string | null;
  line: number | null;
  // GitHub returns line=null with original_line set for outdated comments.
  originalLine: number | null;
  author: string | null;
  body: string | null;
}

export interface PrContentInput {
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
  mergedAt: Date | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  files: PrFileContentInput[];
  reviewComments: PrReviewCommentInput[];
}

export interface RunContentInput {
  id: string;
  name: string;
  headBranch: string | null;
  status: string;
  conclusion: string | null;
  htmlUrl: string | null;
  jobs: unknown;
  logsText: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}

// One searchable item (or one atomic CI log window of an item).
export interface ItemPayload {
  itemId: string;
  sourceType: ContentSourceType;
  number: number | null;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  // Present only for multi-chunk CI log windows (indexing.py:150-168).
  logWindow?: { index: number; total: number; truncated: boolean };
}

// Legacy DocumentPayload gate (_payload, indexing.py:59-68): skip empty
// content, clip the title to 500 chars.
function itemPayload(
  sourceType: ContentSourceType,
  itemId: string,
  number: number | null,
  title: string,
  content: string,
  metadata: Record<string, unknown>,
  logWindow?: ItemPayload["logWindow"],
): ItemPayload | null {
  if (!content.trim()) return null;
  return {
    itemId,
    sourceType,
    number,
    title: title.slice(0, 500),
    content,
    metadata,
    logWindow,
  };
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function jobNames(jobs: unknown): string[] {
  if (!Array.isArray(jobs)) return [];
  const names: string[] = [];
  for (const job of jobs) {
    if (typeof job !== "object" || job === null) continue;
    const name = (job as { name?: unknown }).name;
    if (typeof name === "string") names.push(name);
  }
  return names;
}

// Port of index_repository_documents' payload assembly
// (indexing.py:82-171). Issues: title + body (indexing.py:85-104). PRs:
// title + body + changed-files summary + review comments — the changed-files
// list is legacy metadata `files` (indexing.py:134) surfaced into the indexed
// content so "which PR touched X" is semantically searchable; comment lines
// keep the legacy `${path}:${line} ${author}: ${body}` shape
// (indexing.py:113-116). Failed runs: sanitized log windows
// (indexing.py:145-171).
export function buildItemPayloads(input: {
  issues: IssueContentInput[];
  pullRequests: PrContentInput[];
  workflowRuns: RunContentInput[];
}): ItemPayload[] {
  const payloads: ItemPayload[] = [];

  for (const issue of input.issues) {
    const content = [issue.title, issue.body ?? ""].join("\n");
    const payload = itemPayload(
      "issue",
      issue.id,
      issue.number,
      issue.title,
      content,
      {
        number: issue.number,
        labels: issue.labels,
        state: issue.state,
        author: issue.author,
        assignees: issue.assignees,
        created_at: iso(issue.createdAt),
        updated_at: iso(issue.updatedAt),
        closed_at: iso(issue.closedAt),
      },
    );
    if (payload) payloads.push(payload);
  }

  for (const pr of input.pullRequests) {
    const filesText = pr.files
      .map((f) => `${f.status} ${f.filename}`)
      .join("\n");
    const commentsText = pr.reviewComments
      .map(
        (c) =>
          `${c.path ?? ""}:${c.line ?? c.originalLine ?? ""} ${c.author ?? ""}: ${c.body ?? ""}`,
      )
      .join("\n");
    const content = [
      pr.title,
      pr.body ?? "",
      "changed files:",
      filesText,
      "review comments:",
      commentsText,
    ].join("\n");
    const payload = itemPayload(
      "pull_request",
      pr.id,
      pr.number,
      pr.title,
      content,
      {
        number: pr.number,
        state: pr.state,
        author: pr.author,
        files: pr.files.map((f) => f.filename),
        base_branch: pr.baseBranch,
        head_branch: pr.headBranch,
        additions: pr.additions,
        deletions: pr.deletions,
        changed_files: pr.changedFiles,
        created_at: iso(pr.createdAt),
        updated_at: iso(pr.updatedAt),
        merged_at: iso(pr.mergedAt),
        // path-analog for the heuristic reranker's path hits (search.ts).
        path: `pull/${pr.baseBranch ?? ""}...${pr.headBranch ?? ""}`,
      },
    );
    if (payload) payloads.push(payload);
  }

  for (const run of input.workflowRuns) {
    // Legacy gate (indexing.py:147): only failed runs with non-empty logs.
    if (run.conclusion !== "failure" || !(run.logsText ?? "").trim()) continue;
    const { chunks, truncated } = ciLogChunks(run.logsText ?? "");
    chunks.forEach((logChunk, chunkIndex) => {
      const content = [run.name, logChunk].join("\n");
      const title =
        chunks.length === 1 ? run.name : `${run.name}#${chunkIndex + 1}`;
      const payload = itemPayload(
        "workflow_run",
        run.id,
        null,
        title,
        content,
        {
          status: run.status,
          conclusion: run.conclusion,
          html_url: run.htmlUrl,
          head_branch: run.headBranch,
          jobs: jobNames(run.jobs),
          created_at: iso(run.createdAt),
          updated_at: iso(run.updatedAt),
          chunk_index: chunkIndex,
          total_chunks: chunks.length,
          logs_truncated: truncated,
          secrets_redacted: true,
        },
        { index: chunkIndex, total: chunks.length, truncated },
      );
      if (payload) payloads.push(payload);
    });
  }

  return payloads;
}

// Chunk + stamp rows for one item. Issues/PRs go through the structure-aware
// chunker at the KB granularity (800/100, chunking.ts). CI log windows are
// ALREADY the legacy fixed-size chunks (indexing.py:43-52), so each window is
// one atomic row — re-splitting them at 800 chars would break the
// ≤8000×≤6 guarantee. Embedding input is `title\ncontent`, same as legacy
// (indexing.py:181-186); row ids follow the KB convention `${itemId}#${i}`
// so sibling expansion / per-parent caps / dedup scope work unchanged.
export function itemChunkRows(
  repoId: string,
  payload: ItemPayload,
): Array<{
  id: string;
  content: string;
  embedText: string;
  metadata: Record<string, unknown>;
}> {
  const source = contentSource(repoId, payload.sourceType, payload.itemId);
  const identity: Record<string, unknown> = {
    _source: source,
    repo_id: repoId,
    // doc_id = the item identity: this is what the retrieval pipeline uses to
    // scope dedup / parent caps to one GitHub item.
    doc_id: payload.itemId,
    item_id: payload.itemId,
    source_type: payload.sourceType,
    number: payload.number,
    item_title: payload.title,
    doc_name: payload.title,
    // path-analog default (PR payloads carry their own branch-range path).
    path: `items/${payload.sourceType}/${payload.number ?? payload.itemId}`,
    ...payload.metadata,
  };
  const idFor = (i: number) => `${payload.itemId}#${i}`;

  if (payload.sourceType === "workflow_run" && payload.logWindow) {
    const { index } = payload.logWindow;
    const chunk: Chunk = {
      content: payload.content,
      chunk_id: idFor(index),
      parent_id: payload.itemId,
      child_index: index,
      chunk_type: "log_window",
      section_path: [],
      section_title: null,
      page: null,
      start_line: null,
      end_line: null,
    };
    return [
      {
        id: idFor(index),
        content: payload.content,
        embedText: `${payload.title}\n${payload.content}`,
        metadata: chunkRowMetadata(chunk, identity, ["", idFor(index), ""]),
      },
    ];
  }

  // Issues/PRs: markdown-structured chunking (content is markdown-ish text);
  // the path-analog name selects the ".md" strategy in the chunker.
  const chunks = chunkDocument(
    payload.content,
    `items/${payload.sourceType}/${payload.number ?? 0}.md`,
    800,
    100,
  );
  const siblings = siblingIdsByParent(chunks, idFor);
  return chunks.map((chunk, i) => ({
    id: idFor(i),
    content: chunk.content,
    embedText: `${payload.title}\n${chunk.content}`,
    metadata: chunkRowMetadata(
      chunk,
      identity,
      siblings[i] ?? ["", idFor(i), ""],
    ),
  }));
}

// ---------------------------------------------------------------------------
// Full-repo build (indexing.py:71-204 orchestration)
// ---------------------------------------------------------------------------

const UPSERT_BATCH = 50;

export interface ContentIndexResult {
  repoId: string;
  itemCount: number;
  chunkCount: number;
  byType: Record<ContentSourceType, { items: number; chunks: number }>;
  durationMs: number;
}

export async function indexRepositoryContent(
  repoId: string,
): Promise<ContentIndexResult> {
  const started = Date.now();
  const repo = await prisma.repository.findUnique({ where: { id: repoId } });
  if (!repo) throw new Error(`Repository ${repoId} not found`);

  const issues = await prisma.issue.findMany({ where: { repoId } });
  const pullRequests = await prisma.pullRequest.findMany({
    where: { repoId },
    include: { files: true, reviewComments: true },
  });
  const workflowRuns = await prisma.workflowRun.findMany({
    where: { repoId },
    orderBy: { githubCreatedAt: "desc" },
  });

  const payloads = buildItemPayloads({
    issues: issues.map((i) => ({
      id: i.id,
      number: i.number,
      title: i.title,
      body: i.body,
      labels: i.labels,
      state: i.state,
      author: i.author,
      assignees: i.assignees,
      createdAt: i.githubCreatedAt,
      updatedAt: i.githubUpdatedAt,
      closedAt: i.githubClosedAt,
    })),
    pullRequests: pullRequests.map((p) => ({
      id: p.id,
      number: p.number,
      title: p.title,
      body: p.body,
      state: p.state,
      author: p.author,
      baseBranch: p.baseBranch,
      headBranch: p.headBranch,
      additions: p.additions,
      deletions: p.deletions,
      changedFiles: p.changedFiles,
      mergedAt: p.mergedAt,
      createdAt: p.githubCreatedAt,
      updatedAt: p.githubUpdatedAt,
      files: p.files,
      reviewComments: p.reviewComments,
    })),
    workflowRuns: workflowRuns.map((r) => ({
      id: r.id,
      name: r.name,
      headBranch: r.headBranch,
      status: r.status,
      conclusion: r.conclusion,
      htmlUrl: r.htmlUrl,
      jobs: r.jobs,
      logsText: r.logsText,
      createdAt: r.githubCreatedAt,
      updatedAt: r.githubUpdatedAt,
    })),
  });

  // Full rebuild semantics (legacy replace_documents over
  // SYNCED_REPO_SOURCE_TYPES): wipe this repo's item sources first.
  await deleteBySourcePrefix(contentRepoPrefix(repoId));

  const rows: Array<{
    id: string;
    content: string;
    embedText: string;
    metadata: Record<string, unknown>;
  }> = [];
  const byType: Record<ContentSourceType, { items: number; chunks: number }> = {
    issue: { items: 0, chunks: 0 },
    pull_request: { items: 0, chunks: 0 },
    workflow_run: { items: 0, chunks: 0 },
  };
  const itemIdsByType: Record<ContentSourceType, Set<string>> = {
    issue: new Set(),
    pull_request: new Set(),
    workflow_run: new Set(),
  };
  for (const payload of payloads) {
    const payloadRows = itemChunkRows(repoId, payload);
    byType[payload.sourceType].chunks += payloadRows.length;
    itemIdsByType[payload.sourceType].add(payload.itemId);
    rows.push(...payloadRows);
  }
  for (const type of CONTENT_SOURCE_TYPES) {
    byType[type].items = itemIdsByType[type].size;
  }

  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    await indexChunks(rows.slice(i, i + UPSERT_BATCH));
  }

  return {
    repoId,
    itemCount: payloads.length,
    chunkCount: rows.length,
    byType,
    durationMs: Date.now() - started,
  };
}

// Per-type stored-chunk counts for one repo (GET /api/devflow/content-index).
export async function countContentByType(
  repoId: string,
): Promise<Record<ContentSourceType, number>> {
  const counts = {} as Record<ContentSourceType, number>;
  await Promise.all(
    CONTENT_SOURCE_TYPES.map(async (type) => {
      counts[type] = await milvusCount(contentScopeFilter(repoId, type));
    }),
  );
  return counts;
}

// Delete every indexed item chunk of one repository. Repo-deletion paths
// should call this (shared collection, source-scoped cleanup only).
export async function cleanupRepoContentIndex(repoId: string): Promise<void> {
  await deleteBySourcePrefix(contentRepoPrefix(repoId));
}

// ---------------------------------------------------------------------------
// Similar-issue hit mapping (port of routes/issues.py:308-313 result shape)
// ---------------------------------------------------------------------------

export interface SimilarIssueHit {
  itemId: string;
  number: number;
  title: string;
  url: string;
  state: string;
  score: number;
  excerpt: string;
}

// Dedup by item (a multi-chunk issue can hit several times), drop the query
// issue itself, clip the excerpt. url is built from repo.fullName since the
// Issue row carries no html_url.
export function mapSimilarHits(
  docs: RetrievedDoc[],
  opts: { repoFullName: string; excludeItemId: string; limit: number },
): SimilarIssueHit[] {
  const hits: SimilarIssueHit[] = [];
  const seen = new Set<string>();
  for (const doc of docs) {
    const itemId = String(doc.metadata.item_id ?? "");
    if (itemId === "" || itemId === opts.excludeItemId || seen.has(itemId))
      continue;
    seen.add(itemId);
    const number = Number(doc.metadata.number ?? 0);
    hits.push({
      itemId,
      number,
      title: String(
        doc.metadata.item_title ?? doc.metadata.doc_name ?? "unknown",
      ),
      url: `https://github.com/${opts.repoFullName}/issues/${number}`,
      state: String(doc.metadata.state ?? ""),
      score: doc.score,
      excerpt: doc.content.slice(0, 300),
    });
    if (hits.length >= opts.limit) break;
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Deterministic PR review checklist
// (routes/pull_requests.py:530-533 exposed review_checklist: list[str] from
// the PR agent; services/llm/prompts.py:55-60 defines the judgment rules —
// P1: functional/security/data risk or failing CI, blocking; P2: insufficient
// test coverage, missed edge cases, unaddressed review comments, sensitive
// files without verification, blocking; never "looks good" alone: state the
// remaining manual checklist instead. Those rules are ported here WITHOUT any
// LLM dependency.)
// ---------------------------------------------------------------------------

export interface ChecklistInput {
  number: number;
  title: string;
  body: string | null;
  state: string;
  baseBranch: string | null;
  headBranch: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  files: Array<{ filename: string }>;
  reviewCommentCount: number;
  // Recent workflow runs of the repository (branch-matched on the server).
  runs: Array<{ name: string; status: string; conclusion: string | null }>;
}

export type ChecklistSeverity = "P1" | "P2" | "P3";

export interface ChecklistFinding {
  severity: ChecklistSeverity;
  title: string;
  evidence: string;
  blocking: boolean;
  action: string;
}

export interface ReviewChecklistResult {
  number: number;
  findings: ChecklistFinding[];
  checklist: string[];
  blocking: boolean;
}

const TEST_FILE_PATTERNS: ReadonlyArray<RegExp> = [
  /(^|\/)(__tests__|tests?|specs?)(\/|$)/i,
  /\.(test|spec)\.[a-z]+$/i,
  /(^|\/)test_[^/]+\.py$/i,
  /_test\.(go|py|rs)$/i,
];

// Source-ish files (something a test could reasonably cover).
const CODE_FILE_RE =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|c|h|cpp|cs|scala|swift|sql|sh)$/i;

interface SensitiveRule {
  label: string;
  re: RegExp;
  severity: ChecklistSeverity;
}

const SENSITIVE_RULES: ReadonlyArray<SensitiveRule> = [
  {
    label: "authentication/authorization code",
    re: /(^|\/)(auth|security|permission|crypto|credentials?)(\/|$|\.)/i,
    severity: "P1",
  },
  {
    label: "secret-bearing files",
    re: /(^|\/)\.env(\.|$)|\.(pem|key|p12|keystore)$|secret/i,
    severity: "P1",
  },
  {
    label: "database migrations",
    re: /(^|\/)migrations?(\/|$)|\.sql$/i,
    severity: "P2",
  },
  {
    label: "dependency manifests/lockfiles",
    re: /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|pyproject\.toml|requirements\.txt|Gemfile\.lock|composer\.lock)$/i,
    severity: "P2",
  },
  {
    label: "CI pipeline definitions",
    re: /(^|\/)\.github\/workflows\/|\.gitlab-ci\.yml$|jenkins/i,
    severity: "P2",
  },
  {
    label: "container build definitions",
    re: /(^|\/)dockerfile([^a-z0-9]|$)|docker-compose/i,
    severity: "P2",
  },
];

// Legacy severity weights: P1/P2 block merges (prompts.py:55-56,59).
const SEVERITY_ORDER: Record<ChecklistSeverity, number> = {
  P1: 0,
  P2: 1,
  P3: 2,
};

export function buildReviewChecklist(
  input: ChecklistInput,
): ReviewChecklistResult {
  const findings: ChecklistFinding[] = [];
  const filenames = input.files.map((f) => f.filename);

  // 1. Failing CI (branch-matched by the caller) → P1 blocking
  // (prompts.py:55).
  const branchRuns = input.runs;
  const failedRun = branchRuns.find((r) => r.conclusion === "failure");
  if (failedRun) {
    findings.push({
      severity: "P1",
      title: "Failing CI blocks the merge",
      evidence: `workflow "${failedRun.name}" concluded failure`,
      blocking: true,
      action: `Fix the failing CI run "${failedRun.name}" before requesting review.`,
    });
  } else if (branchRuns.length === 0) {
    findings.push({
      severity: "P3",
      title: "No CI status recorded",
      evidence: "no workflow runs found for this repository/branch",
      blocking: false,
      action: "Confirm the CI pipeline actually ran on the head branch.",
    });
  }

  // 2. Test coverage (prompts.py:56 P2 "测试覆盖不足").
  const touchedCode = filenames.filter((f) => CODE_FILE_RE.test(f));
  const touchedTests = filenames.some((f) =>
    TEST_FILE_PATTERNS.some((re) => re.test(f)),
  );
  if (touchedCode.length > 0 && !touchedTests) {
    findings.push({
      severity: "P2",
      title: "No test files changed",
      evidence: `${touchedCode.length} source file(s) changed without any test file`,
      blocking: true,
      action:
        "Add or update tests covering the changed behavior (unit tests for the touched modules, plus a regression case for the fixed bug).",
    });
  }

  // 3. Sensitive files need explicit verification (prompts.py:56 P2
  // "敏感文件缺少验证" / prompts.py:55 P1 for security surfaces).
  for (const rule of SENSITIVE_RULES) {
    const matched = filenames.filter((f) => rule.re.test(f));
    if (matched.length === 0) continue;
    findings.push({
      severity: rule.severity,
      title: `Sensitive area touched: ${rule.label}`,
      evidence: matched.slice(0, 5).join(", "),
      blocking: rule.severity !== "P3",
      action: `Manually verify the ${rule.label} change (${matched.length} file(s)) and record the verification in the PR thread.`,
    });
  }

  // 4. Breaking change markers.
  const text = `${input.title}\n${input.body ?? ""}`;
  const breaking =
    /breaking[\s-]*change/i.test(text) ||
    /^[a-z]+(\([^)]*\))?!:/i.test(input.title.trim());
  if (breaking) {
    findings.push({
      severity: "P1",
      title: "Breaking change",
      evidence: "BREAKING CHANGE marker or a conventional-commit `!` bump",
      blocking: true,
      action:
        "Confirm the breaking change is documented (changelog entry, migration steps) and downstream consumers are notified before merge.",
    });
  }

  // 5. Unresolved review comments (prompts.py:56 P2 "未处理 review comment").
  if (input.reviewCommentCount > 0 && input.state === "open") {
    findings.push({
      severity: "P2",
      title: "Review comments pending",
      evidence: `${input.reviewCommentCount} stored review comment(s)`,
      blocking: true,
      action: `Reply to or resolve all ${input.reviewCommentCount} review comment(s) before merging.`,
    });
  }

  // 6. Diff-size hint.
  const churn = input.additions + input.deletions;
  const effectiveFiles =
    filenames.length > 0 ? filenames.length : input.changedFiles;
  if (churn > 1_000 || effectiveFiles > 30) {
    findings.push({
      severity: "P3",
      title: "Large diff",
      evidence: `${effectiveFiles} file(s), +${input.additions}/-${input.deletions}`,
      blocking: false,
      action:
        "Consider splitting this PR into reviewable increments, or annotate the description with a guided reading order.",
    });
  }

  // 7. Missing description.
  if (!(input.body ?? "").trim()) {
    findings.push({
      severity: "P3",
      title: "Empty PR description",
      evidence: "no body",
      blocking: false,
      action: "Describe the motivation, what changed, and how it was tested.",
    });
  }

  findings.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
  const blocking = findings.some((f) => f.blocking);

  const checklist = findings.map((f) => f.action);
  // Legacy rule (prompts.py:60): never replace the review with "looks good";
  // when nothing fired, state the remaining manual confirmations instead.
  if (checklist.length === 0) {
    checklist.push(
      "No blocking findings from the deterministic checks — still review the diff manually and confirm the remaining P3 suggestions before merging.",
    );
  }
  return { number: input.number, findings, checklist, blocking };
}
