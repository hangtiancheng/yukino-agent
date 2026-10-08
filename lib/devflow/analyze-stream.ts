// Shared SSE plumbing for the DevFlow analyze/stream routes.
//
// Legacy ports (DevFlow-AI/backend/app/api/routes):
//  - issues.py:243-268 _issue_analysis_sse (+ :299-305 route),
//  - pull_requests.py:414-450 _pr_analysis_sse (+ :493-499 route),
//  - ci.py:455-495 _ci_analysis_sse (+ :546 route):
//  trace events while the analysis runs → a final result → done, with an
//  `error` event on failure (legacy event names: trace/thinking_delta/
//  final/error).
//
// HONEST SCOPE NOTE (task spec "诚实标注"): legacy streamed fine-grained
// traces because it owned the context builder and the LLM call. This repo's
// lib/devflow/agents/analysis.ts exposes monolithic orchestrators
// (analyzeIssue / reviewPull / debugRun) that run rules → LLM → merge
// internally and are out of scope to modify, so the trace stream here is
// coarse-grained:
//  - "context" is genuinely observed (the target row is loaded before the
//    stream starts);
//  - "rules" states honestly that the rules/LLM/merge stages run as one
//    unit inside the orchestrator (stage boundaries are not observable);
//  - "llm" and "merge" report the OBSERVED provenance after the call
//    (result.generationMode, ownerValidation) rather than pretending to
//    run each stage.
// Legacy's `thinking_delta` stream (a second LLM pass narrating public
// reasoning) is NOT ported: it needs an extra model call the current
// analysis surface does not expose.

export type AnalyzeStage = "context" | "rules" | "llm" | "merge";

export interface SseFrame {
  event: string;
  data: string;
}

// Same framing as /api/devflow/chat (SSE payloads must not contain raw
// newlines: one `data:` line per text line). Legacy _encode_sse emitted only
// `event:`/`data:`; the `id:` line follows this repo's chat convention.
export function encodeSse(event: string, data: string): string {
  const dataLines = data
    .split("\n")
    .map((line) => `data: ${line}`)
    .join("\n");
  return `id: ${Date.now()}\nevent: ${event}\n${dataLines}\n\n`;
}

export function traceFrame(stage: AnalyzeStage, detail: string): SseFrame {
  return { event: "trace", data: JSON.stringify({ stage, detail }) };
}

export interface AnalyzeStreamHooks<
  TResult extends { generationMode?: string | undefined },
> {
  // Localized trace details prepared by the route (i18n lives in the route,
  // the sequence stays pure here).
  contextDetail: string;
  rulesDetail: string;
  llmDetail: (generationMode: string) => string;
  mergeDetail: (record: { id: string; result: TResult }) => string;
  // The monolithic orchestrator call (analyzeIssue / reviewPull / debugRun).
  run: () => Promise<{ id: string; result: TResult; createdAt: unknown }>;
}

// Pure frame sequence (smoke-tested without DB/LLM):
//   trace(context) → trace(rules) → [run] → trace(llm) → trace(merge) →
//   result → done
// When run() throws: trace(context) → trace(rules) → error.
export async function* analysisStreamFrames<
  TResult extends { generationMode?: string | undefined },
>(hooks: AnalyzeStreamHooks<TResult>): AsyncGenerator<SseFrame> {
  yield traceFrame("context", hooks.contextDetail);
  yield traceFrame("rules", hooks.rulesDetail);
  try {
    const record = await hooks.run();
    const generationMode = record.result.generationMode ?? "deterministic";
    yield traceFrame("llm", hooks.llmDetail(generationMode));
    yield traceFrame("merge", hooks.mergeDetail(record));
    yield { event: "result", data: JSON.stringify(record) };
    yield { event: "done", data: JSON.stringify({ id: record.id }) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    yield { event: "error", data: JSON.stringify({ message }) };
  }
}
