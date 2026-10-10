export type AnalyzeStage = "context" | "rules" | "llm" | "merge";

export interface SseFrame {
  event: string;
  data: string;
}

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
  contextDetail: string;
  rulesDetail: string;
  llmDetail: (generationMode: string) => string;
  mergeDetail: (record: { id: string; result: TResult }) => string;
  run: () => Promise<{ id: string; result: TResult; createdAt: unknown }>;
}

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
