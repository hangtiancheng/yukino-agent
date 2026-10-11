<div align="center">

# Yukino Agent

**An AI OnCall assistant — RAG chat, interactive A2UI surfaces, and a plan-execute-replan AI Ops pipeline for alert analysis, all with first-party Prometheus monitoring.**

Built on Next.js 16 + AI SDK, with Milvus for hybrid vector search (dense + native BM25, RRF-fused) and the A2UI shadcn catalog inlined from the a2ui repo (`catalog/` + `components/ui/`) for LLM-generated UI.

![Next.js](https://img.shields.io/badge/Next.js-16-000000?logo=next.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Milvus](https://img.shields.io/badge/Milvus-vector_DB-00A1E0?logo=milvus&logoColor=white)
![Prometheus](https://img.shields.io/badge/Prometheus-monitoring-E6522C?logo=prometheus&logoColor=white)
![License: MIT](https://img.shields.io/badge/License-MIT-f5a623.svg)

</div>

---

## setup

### Milvus (Vector DB)

Requires Milvus Standalone 2.5+ / 3.x (gRPC :19530). One collection carries
both the dense FloatVector path (AUTOINDEX + COSINE) and a native BM25
full-text path fused with RRF.

**Docker (recommended)** — the official single-container embed bundle
(ships etcd + MinIO inside):

```bash
curl -sfL https://raw.githubusercontent.com/milvus-io/milvus/master/scripts/standalone_embed.sh -o standalone_embed.sh
bash standalone_embed.sh start
```

See the [Milvus standalone docs](https://milvus.io/docs/install_standalone-docker.md)
for other deployment options. `MILVUS_URI` defaults to `http://localhost:19530`.

### Prometheus & Grafana (monitoring, optional)

Scrape config and alert rules live in the repo as `prometheus.yml` and `prometheus.rules.yml`.

**Homebrew (macOS)**

```bash
brew install prometheus grafana
cp prometheus.rules.yml /opt/homebrew/etc/prometheus.rules.yml
brew services start prometheus
brew services start grafana
```

The Homebrew config at `/opt/homebrew/etc/prometheus.yml` matches the repo copy except that it targets `127.0.0.1` instead of `host.docker.internal` and points `rule_files` at `/opt/homebrew/etc/prometheus.rules.yml`.

Prometheus runs without `--web.enable-lifecycle`, so `POST /-/reload` returns 403 — apply rule changes with `brew services restart prometheus`.

Prometheus port: `9090`. Grafana port: `3000` (`3000` under Docker is the Next.js dev server). Credentials: admin / pass.

## APIs

- `POST /api/chat` — non-streaming chat
- `POST /api/chat_stream` — SSE streaming chat
- `POST /api/a2ui_action` — resolve an A2UI surface action into in-place update messages
- `POST /api/upload` — upload a file (.txt/.md) to the knowledge base
- `POST /api/ai_ops` — AI Ops plan-execute-replan
- `POST /api/log` — yukino-sentry report endpoint (the SDK `dsn`)
- `GET /api/metrics` — Prometheus exposition endpoint

## Notes

- On first use, upload a doc file via the "..." menu so the RAG knowledge base has content; otherwise retrieval returns empty. Uploads land in `FILE_DIR` and are indexed immediately (re-indexed on every startup).
- Hybrid search (dense + BM25, RRF-fused) runs inside Milvus; setting `RERANK_API_KEY` adds a second-stage rerank via the Aliyun DashScope text-rerank endpoint (see `.env.example`). Unfiltered retrieval excludes `devflow:*` sources so DevFlow repo knowledge never leaks into OnCall answers.
- Finished AI Ops reports are persisted back into the knowledge base as diagnostic case documents, so future chats and diagnoses retrieve past incidents.
- Tool definitions follow a three-layer split: `schemas.ts` (zod) → `operations.ts` (pure functions) → `index.ts` (AI SDK `tool` wrapper).

---

## Migration from `.legacy`

This repo consolidates two Python projects — `.legacy/agent_py-release-2026-09-08`
(the OnCall backend + Vue frontend) and `.legacy/DevFlow-AI` (the DevFlow FastAPI
backend + Next.js frontend) — into one Next.js 16 + AI SDK app. The port is
feature-complete except for the deliberate divergences listed below.

Restored on top of the initial port:

- DevFlow progressive context compression (`lib/devflow/context-compression.ts`,
  a port of `context_compression.py` + `ProgressiveContextManager`): token-pressure
  stages, token-budgeted history windowing, LLM compaction into persisted
  compact-boundary messages with session-memory / extractive fallbacks, key-fact
  preservation, and a failure circuit breaker.
- AI Ops tool-call audits — every plan-step tool call lands in `ToolCallAudit`
  under session `aiops:<runId>` (legacy `aiops_tool_call_audits`), readable via
  `GET /api/tool_audits?session=aiops:<runId>`.
- AI Ops run event timeline — `AiOpsRun.events` persists a truncated
  PlanExecuteEvent trail (plan / step start / step output / replans), the
  lightweight successor of the legacy evidence-chain tables, rendered in the ops
  panel run history.
- DevFlow chat memory tools — the legacy memory MCP server's stdio tools are now
  in-process chat tools: `search_evidence` (semantic recall over the repo KB AND
  the synced GitHub content index; successor of `devflow_search_evidence`),
  `read_conversation_transcript` (verbatim transcript reading that reaches past
  the context window; successor of `devflow_get_thread_context`) and the existing
  `memory_recall` / `memory_propose`. Each recall audits a `RecallEvent` row.

Deliberate divergences:

OnCall (from `agent_py`):

- **Auth & tenancy removed** — legacy had user accounts, bearer sessions and
  per-user scoping; both surfaces here are public and single-tenant.
- **Server-side chat sessions → client-side** — legacy persisted chat sessions
  per user; histories now live in browser localStorage (client session ids still
  anchor tool audits and feedback). Consequently the legacy memory-mode selector
  (`every_30_turns` / `context_70_percent` / `manual` compaction) and the
  context-usage API are replaced by the automatic rolling summary
  (`MEMORY_SUMMARY_ENABLED`).
- **Background job runtime removed** — legacy queued document indexing through a
  worker pool with cancel/retry; uploads and startup indexing run synchronously,
  and `POST /api/knowledge_docs/[name]` offers manual re-index.
- **Single knowledge base** — legacy supported multiple knowledge bases per user;
  here one `FILE_DIR`-backed KB serves OnCall (DevFlow keeps per-repo KBs in
  Milvus as before).
- **Chunking strategy fixed** — legacy exposed per-document strategy selection
  (fixed-character / markdown-heading / paragraph / legacy-word); the OnCall KB
  always uses the heading-aware chunker now.
- **Evidence-chain tables replaced** — legacy `aiops_diagnostic_steps` /
  `aiops_diagnostic_evidence` / report-evidence links / graph checkpoints become
  `AiOpsRun.events` + `ToolCallAudit` (see above).
- **Project configuration** — legacy's shared/protected project config becomes
  plain `.env` + `lib/config.ts`.

DevFlow (from `DevFlow-AI`):

- **Evaluation suites not ported** — the agent/RAG eval runner (incl. the ragas
  integration) and its UI depend on the Python eval ecosystem; retrieval quality
  is covered here by the retrieval-test runs on the Knowledge page instead.
- **Single embedding contract** — legacy let each repo KB pick its own embedding
  provider / model / dimensions (`GET /api/rag/models` + a per-KB embedding
  contract with validation); here one global embedding config
  (`EMBEDDING_PROVIDER` + `lib/config.ts`) serves the whole app, so the per-KB
  model catalog and embedding-contract validation are gone. Retrieval method /
  rerank / topK / score threshold / chunk size + overlap stay per-repo
  configurable via `GET|PUT /api/devflow/knowledge/config`.
- **PR worktree snapshots removed** — `worktree_manager` (snapshot / worktree /
  cleanup endpoints) is replaced by the read-only managed-clone design
  (`lib/devflow/workspace.ts`).
- **MCP stdio surfaces removed** — the legacy memory MCP server and the skills
  `mcp-status` probe are replaced by in-process tools (the memory tools are
  listed under "Restored" above; `mcp-status` is moot because DevFlow tools run
  in-process, not over stdio).
- **EvidenceItem table removed** — legacy rebuilt a keyword evidence index from
  chat history; the Milvus GitHub content index (semantic search over synced
  issues / PRs / CI logs) supersedes it in
  `GET /api/devflow/repos/:id/memory/search`.
- **Streaming-only chat** — legacy also exposed a non-streaming `POST /api/chat`;
  the port streams SSE exclusively.
- **`thinking_delta` second-LLM stream not ported** (documented in
  `lib/devflow/analyze-stream.ts`).

---

## Monitoring

Pipeline: yukino-sentry browser SDK → `POST /api/log` → `lib/metrics.ts` (prom-client) → `GET /api/metrics` → Prometheus.

`lib/metrics.ts` covers every SDK report type except ScreenRecord (errors and framework crashes, resource failures, HTTP, web vitals, navigation and resource timing, long tasks, browser memory, clicks, exposure, white screen, page views and dwell, custom events) plus Node/V8 runtime metrics that prom-client defaults omit — `heap_size_limit`, heap-used ratio, detached contexts, code and bytecode size, array buffers, event loop utilization, page faults and context switches.

Browser-supplied label values are capped at 50 distinct values each, collapsing to `other`, so a bad deploy cannot explode the series count.

Alert rules are in `prometheus.rules.yml`. Alert names are a contract: the AI Ops pipeline calls `query_prometheus_alerts` and then `query_internal_docs` with the alert name, so every rule needs a matching heading in `data/docs/alert-handling-guide.md`.

```bash
promtool check rules prometheus.rules.yml
```

`lib/metrics.ts` caches its registry on `globalThis`, so editing it requires a dev-server restart rather than relying on HMR.

## Prompts

### Chat System Prompt

source: `lib/ai/pipelines/chat.ts` L54-81

```md
# Role: Conversational Assistant

## Core capabilities

- Context understanding and conversation
- Search the web for information

## Interaction guidelines

- Before replying, ensure you:
  - Fully understand the user's needs and questions; confirm with the user if anything is unclear
  - Consider the most appropriate solution approach
    ${logTopicLine}
- When providing help:
  - Use clear and concise language
  - Provide practical examples when appropriate
  - Reference documentation when helpful
  - Suggest improvements or next steps when applicable
- If a request is beyond your capabilities:
  - Clearly state your limitations and, if possible, suggest alternative approaches
- For complex or compound questions, think step by step and avoid giving low-quality answers directly.

## Output requirements:

- Readable and well-structured, with line breaks when needed
- Output markdown only
  ${A2UI_PROMPT_SECTION}

## Context information

- Current date: {date}
- Relevant documents: |-
  ==== Documents start ====
  {documents}
  ==== Documents end ====
```

### A2UI Prompt Section

source: `lib/ai/a2ui/prompt.ts`

Embedded into the chat system prompt and the uiify system prompt. Assembled by `generateSystemPrompt("direct-json", ...)` from `lib/a2ui/prompt` (inlined from the a2ui repo) against the shadcn catalog (with `removeStrictValidation` applied): role + SDK workflow rules + app-specific rules + the full A2UI JSON schema contract (server-to-client, common types, catalog) + 3 few-shot examples (alert list, metrics report, silence form) generated by builder functions.

```md
## Interactive UI (A2UI v0.9)

Besides markdown you can render interactive UI surfaces with the A2UI v0.9 protocol.

## Workflow Description:

<SDK DEFAULT_WORKFLOW_RULES: blocks wrapped in <a2ui-json> tags, JSON must
validate against the schema, root component first, parents before children>

- WHEN: only when the answer presents structured data — alert lists, tabular/SQL query results, metric series or trends, or a form the user should fill and confirm. For explanations, how-tos and casual conversation, answer in plain markdown WITHOUT any A2UI block.
- HOW: write a brief markdown summary first (1-3 sentences), then append exactly ONE UI block. The block content is a JSON array of A2UI messages, with no prose inside the tags.
- Message order: createSurface first, then updateComponents, then updateDataModel. Every surface must define a component with id "root".
- createSurface needs a surfaceId that is unique per reply (kebab-case, e.g. "alerts-overview-3") and catalogId "${A2UI_CATALOG_ID}".
- Data binding: {"path":"/x"} reads the surface data model (absolute path). Inside a List item template use relative paths like {"path":"name"}. List template binding: "children":{"componentId":"<template-id>","path":"/items"}.
- Buttons fire actions: "action":{"event":{"name":"<action_name>","context":{...}}} where context values are literals or {"path"} bindings (bindings also work inside list templates and carry current form values).
- Copy real data (tool results, documents) verbatim into updateDataModel — NEVER invent values. If there is no real data, do not render a surface.
- Text and data values render as PLAIN TEXT: never put markdown syntax (**bold**, _italics_, backticked code, [links]) inside component text, table cells or data model values.
- Actions are handled out of band: when the user triggers a component action, a separate request updates that surface in place. Do not describe or simulate action handling in your text replies.

---BEGIN A2UI JSON SCHEMA---

### Server To Client Schema: ... (compact JSON)

### Common Types Schema: ... (compact JSON)

### Catalog Schema: ... (full shadcn catalog, compact JSON)

---END A2UI JSON SCHEMA---

### Examples:

---BEGIN ALERT_LIST_EXAMPLE--- ... ---END ALERT_LIST_EXAMPLE---
---BEGIN METRICS_REPORT_EXAMPLE--- ... ---END METRICS_REPORT_EXAMPLE---
---BEGIN FORM_EXAMPLE--- ... ---END FORM_EXAMPLE---
```

### A2UI Action Update (System + User)

source: `lib/ai/a2ui/prompt.ts` (`A2UI_ACTION_SYSTEM_PROMPT`, `buildA2uiActionPrompt`) + `lib/ai/a2ui/action.ts`

Surface actions are NOT sent as user chat messages. `A2uiView` reports the raw action (`onRawAction`), the client POSTs `{ action, a2ui }` (the action payload plus the owning surface's full message list) to `POST /api/a2ui_action`, and the model replies with ONLY updateComponents/updateDataModel messages for the SAME surfaceId. The client appends them to that message's `a2ui` array, so the surface updates in place. The pipeline runs with tools (max 10 steps), reuses the corrective retry, and drops any message that is not an in-place update for the acting surface. The system prompt is assembled by `generateSystemPrompt` with `allowedMessages: ["UpdateComponentsMessage", "UpdateDataModelMessage"]`, so the embedded schema contract cannot even express createSurface/deleteSurface, plus one builder-generated few-shot example (silence form status update).

### AI Ops Alert Analysis Query

source: `lib/ai/pipelines/plan-execute-replan/index.ts` L45-64

Default task query for the plan-execute-replan pipeline, fed into the planner and replanner.

```md
1. You are an intelligent service alert analysis assistant. First, call the tool query_prometheus_alerts to retrieve all active alerts.
2. For each alert, call the tool query_internal_docs by alert name to retrieve the corresponding handling procedure.
3. Strictly follow the internal documentation for queries and analysis; do not use any information outside the documentation.
4. For any time-related parameters, first call the tool get_current_time to obtain the current time, then pass parameters according to the tool's time requirements.
5. For log queries, first use the log tool to retrieve relevant log information; parameters must include the region and log topic.
6. Summarize and analyze the information retrieved for each alert, then generate an alert operations analysis report in Chinese (中文) in the following format:

告警分析报告
---

# 告警处理详情

## 活跃告警列表

## 告警归因 N (第 N 个告警)

## 处理流程 N (第 N 个告警)

## 结论
```

### Planner Prompt

source: `lib/ai/pipelines/plan-execute-replan/index.ts` L139

Inline prompt for the planner step. Uses structured output (`Output.object` with `planSchema`) to get `{steps: string[]}`.

```md
Break down the following task into concrete steps.

Task:
${query}
```

### Replanner Prompt

source: `lib/ai/pipelines/plan-execute-replan/index.ts` L162-166

Inline prompt for the replanning step. Uses structured output with `replanSchema` to get `{done, remaining, summary}`.

```md
You are a replanning agent reviewing execution progress toward an objective. Analyze the completed steps and their outcomes to decide whether the objective is fully achieved or further action is required.

Task:
${query}

Original Plan:
${JSON.stringify({ steps: plan })}

Completed steps:
${plan.map((s, idx) => `${idx + 1}. ${s}`).join("\n")}

Results so far:
${detail.join("\n")}

Based on the progress above, determine whether the task is complete. If it is, provide a comprehensive final report in the summary field. If more work is needed, list only the remaining steps.
```

### UI-ify Report (System + User)

source: `lib/ai/pipelines/plan-execute-replan/index.ts` L88-101

Post-processing pass that converts a finished alert report into an A2UI surface. No tools, think model.

System:

```md
You render A2UI surfaces for an OnCall assistant.
${A2UI_PROMPT_SECTION}
```

User:

```md
Below is an alert operations analysis report. If it presents structured data worth visualizing (alert lists, metric series, tabular results), reply with ONLY one A2UI block wrapped between ${A2UI_OPEN_TAG} and ${A2UI_CLOSE_TAG}.

Rules:

- The report is the ONLY source: visualize facts it states, copied verbatim — NEVER invent data.
- Do not visualize intermediate execution chatter (e.g. current-time lookups) and never repeat the same data twice.
- Never render empty tables or placeholder rows like "(none)" or "—".
- Titles must be short noun phrases, not sentences; omit a Table caption when a heading already labels it.
- If the report has nothing structured to render (e.g. zero active alerts, prose-only conclusions), reply with the single word NONE.

Report:

${result}
```

### A2UI Corrective Retry

source: `lib/ai/a2ui/correct.ts` L28-31

Sent as a user message when the LLM's A2UI block fails validation. Replays conversation context and asks for a corrected block only. Reuses the caller's system prompt.

```md
Your A2UI block was invalid: ${params.error}. Reply with ONLY the corrected JSON array of A2UI v0.9 messages wrapped between ${A2UI_OPEN_TAG} and ${A2UI_CLOSE_TAG} — no other text.
```

### Step Executor (Implicit)

source: `lib/ai/pipelines/plan-execute-replan/executor.ts` L41

The executor passes each plan step string directly as the `prompt` to `generateText()` with tools (`stopWhen: isStepCount(10)`). No additional instruction wrapper — the step text produced by the planner IS the prompt.

### Prompt Architecture

```
Chat Pipeline (lib/ai/pipelines/chat.ts)
  +-- SYSTEM_PROMPT (L54-81)
  |     +-- embeds A2UI_PROMPT_SECTION (from a2ui/prompt.ts)
  |     +-- injects {date} and {documents} via buildSystemPrompt()
  +-- correctA2uiBlock corrective prompt (from a2ui/correct.ts)

A2UI Action Pipeline (lib/ai/a2ui/action.ts + app/api/a2ui_action)
  +-- A2UI_ACTION_SYSTEM_PROMPT (from a2ui/prompt.ts)
  +-- buildA2uiActionPrompt: action payload + surface messages as user prompt
  +-- correctA2uiBlock corrective prompt (from a2ui/correct.ts)

Plan-Execute-Replan Pipeline (lib/ai/pipelines/plan-execute-replan/)
  +-- AI_OPS_QUERY task prompt (index.ts L45-64)
  +-- Planner: "Break down the following task..." (index.ts L139)
  +-- Executor: raw step text as prompt (executor.ts L41)
  +-- Replanner: "You are a replanning agent..." (index.ts L162-166)
  +-- uiifyReport: system + user (index.ts L88-101)
  +-- correctA2uiBlock corrective prompt (from a2ui/correct.ts)

Shared A2UI Module (lib/ai/a2ui/)
  +-- A2UI_PROMPT_SECTION — generateSystemPrompt("direct-json", ...) from
  |   lib/a2ui/prompt: rules + full schema contract + 3 examples
  +-- A2UI_ACTION_SYSTEM_PROMPT — generateSystemPrompt with allowedMessages
  |   pruned to UpdateComponents/UpdateDataModel + 1 example
  +-- Corrective retry prompt (correct.ts L28-31)
```

```js
javascript: v = document.querySelector("video");
v.style.rotate = "-90deg";
v.style.scale = v.offsetWidth / v.offsetHeight;
```
