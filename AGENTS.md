<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

- NEVER add MIT license header manually!

<!-- END:nextjs-agent-rules -->

# Yukino Agent

AI intelligent OnCall assistant.

## Tech stack

- Next.js 16 App Router + React 19 + TypeScript
- Vercel AI SDK v7 (`ai`): streamText / generateText (structured output via `output: Output.object({schema})`, result on `.output` — `generateObject` is deprecated) / tool / embed / embedMany
- LLM: OpenAI (OpenAI compatible) via `@ai-sdk/openai` createOpenAI
- Embedding: text-embedding-v4 via `@ai-sdk/openai-compatible`; selected by `EMBEDDING_PROVIDER` ("openai" only); batch requests capped at 10 inputs
- Vector DB: Redis Stack (`redis`, index=idx:biz, key prefix=biz:, VECTOR FLOAT32 + HNSW + COSINE); index dim is probed from the embedding provider at startup and the index is auto-recreated on dim mismatch
- MySQL: `knex` + `mysql2` (mysql_crud tool uses knex.raw for dynamic SQL)
- MCP: `@modelcontextprotocol/sdk` (SSE log tools)
- Monitoring: `prom-client` registry in `lib/metrics.ts`, fed by `POST /api/log` and exposed at `GET /api/metrics`. Covers every yukino-sentry report type except ScreenRecord, plus the Node/V8 metrics prom-client defaults omit (heap limit, heap-used ratio, detached contexts, array buffers, event loop utilization, page faults). Browser-supplied label values are capped at 50 distinct values (overflow becomes `other`). The registry is cached on `globalThis`; when you change the metric set you MUST bump `METRICS_VERSION`, otherwise a long-lived dev server keeps serving a cache whose new fields are `undefined` (typed as present, so tsc cannot catch it) and every `.inc()` throws TypeError. Alert rules live in `prometheus.rules.yml`; every alert name MUST have a matching heading in `data/docs/alert-handling-guide.md`, because the AI Ops pipeline resolves runbooks by alert name. The Go backend (`yukino.go/yukino_agent/internal/app/sentry_metrics_handler.go`) exposes byte-identical `yukino_sentry_*` names so one Prometheus and one rule file serve both jobs — change both bridges together. Verify with `npx tsx scripts/metrics-smoke.ts`.
- Startup: `instrumentation.ts` register() embeds every doc in `FILE_DIR` (./data/docs)
- Frontend: Tailwind v4 atomic classes + streamdown (streaming markdown + Shiki code highlighting)

## Directory layout

- `app/` — Next.js App Router (page / layout / api route)
- `lib/` — server-side logic (ai / redis / memory / config / api-schemas)
- `components/` — React components
- `hooks/` — React hooks

## Coding conventions

- Styles use only Tailwind v4 atomic classes; do not create custom CSS classes (no styles.css).
- Tool definitions follow a three-layer split: `lib/ai/tools/schemas.ts` (zod) → `operations.ts` (pure functions) → `index.ts` (AI SDK `tool` wrapper).
- API responses are wrapped as `{ message, data }`.
- Configuration is read via `.env` + `lib/config.ts`; no yaml.
- Strict typing: validate runtime-unknown data with zod (`safeParse`/`parse`); no unnecessary type assertions, no `@ts-ignore` / `eslint-disable`.

## A2UI integration (v0.9)

- The LLM optionally appends ONE `<a2ui-json>[...]</a2ui-json>` block (JSON array of A2UI v0.9 messages) after a markdown summary; prompt section + OnCall few-shot builders live in `lib/ai/a2ui/prompt.ts` (change UI examples there, the prompt updates itself).
- `lib/ai/a2ui/extract.ts`: `createA2uiStreamFilter()` strips blocks from the text stream (holds back partial-tag tails across chunks); validation is `A2uiMessageListSchema.safeParse` from `@a2ui/web_core/v0_9` only — do not reintroduce hand-rolled checks.
- **zod red line**: web_core bundles its own zod v3; never compose its schemas into app `zod/v4` combinators — app boundaries carry `unknown[]`, per-payload validation calls the web_core schema directly.
- `chatStream()` yields `ChatStreamEvent` (`text` / `a2ui` / `notice`); SSE emits them as `message` / `a2ui` events. `chat()` returns `{ answer, a2ui? }` and `/api/chat` puts it in `data.a2ui`. Invalid blocks get exactly one no-tools corrective retry (`lib/ai/a2ui/correct.ts`, model is a parameter), then degrade to an honest notice — never fabricate UI data. Memory keeps the raw tagged text so follow-up actions have context.
- AI Ops: after the replanner finishes, a post "UI-ify" pass (`uiifyReport` in `lib/ai/pipelines/plan-execute-replan/index.ts`, think model, no tools) optionally renders the report as a surface; `/api/ai_ops` returns it in `data.a2ui`. Its failure never discards the report.
- Client: `ChatMessage.a2ui?: unknown[]` (persisted in localStorage histories); `components/a2ui-view.tsx` owns a per-message `MessageProcessor([shadcnCatalog])` (surfaceIds are isolated per message; cross-message deleteSurface unsupported), validates each message with `A2uiMessageSchema.safeParse`, renders `<A2uiSurface>` under `MarkdownContext.Provider`.
- Surface actions are serialized as `[UI_ACTION] <name>\ncontext: <json>` and auto-sent through the normal chat send path.
- `reactStrictMode` is off: the MessageProcessor is a stateful external store and StrictMode's dev double-effect replays surfaces on re-subscription.
- Catalog (`catalog/`, 18 basic + 47 shadcn extension components) and `components/ui/` are ported from the a2ui repo — keep edits minimal.
- Verification: `/gallery` renders every extension component backend-free; `npx tsx scripts/a2ui-smoke.ts` checks the prompt examples, stream filter chunk-splits, and validation semantics.
