// POST /api/devflow/issues/:id/analyze/stream — SSE-streamed Issue Triage.
// Legacy port: issues.py:299-305 analyze_issue_stream / :243-268
// _issue_analysis_sse (trace events → final result → error). Same input
// semantics as the synchronous POST /api/devflow/issues/:id/analyze: an
// unknown issue returns the JSON 404 envelope before the stream starts
// (sync-route parity), while mid-analysis failures emit an `error` event
// (legacy parity). Event framing follows this repo's chat SSE conventions
// (trace / result / done / error). Documented divergences from legacy:
// (1) trace granularity is coarse — the rules/LLM/merge stages run as one
// unit inside analysis.ts's orchestrator; (2) legacy's `thinking_delta`
// second-LLM-pass reasoning stream is NOT ported — see the HONEST SCOPE
// NOTE in lib/devflow/analyze-stream.ts.
import { getTranslations } from "next-intl/server";
import {
  analyzeIssue,
  type AnalysisProvenance,
} from "@/lib/devflow/agents/analysis";
import { analysisStreamFrames, encodeSse } from "@/lib/devflow/analyze-stream";
import { CORS_HEADERS, errorMessage, failRaw } from "@/lib/devflow/http";
import type { IssueAnalysis } from "@/lib/devflow/schemas";
import { prisma } from "@/lib/db";

export { OPTIONS } from "@/lib/devflow/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  let issue: {
    number: number;
    title: string;
    state: string;
    labels: string[];
    assignees: string[];
  } | null = null;
  try {
    issue = await prisma.issue.findUnique({
      where: { id },
      select: {
        number: true,
        title: true,
        state: true,
        labels: true,
        assignees: true,
      },
    });
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
  if (!issue) return failRaw(404, `Issue ${id} not found`);

  const t = await getTranslations("devflow.analyzeStream");
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const frame of analysisStreamFrames<
          IssueAnalysis & AnalysisProvenance
        >({
          contextDetail: t("contextIssue", {
            number: issue.number,
            title: issue.title,
            state: issue.state,
            labels: issue.labels.length,
            assignees: issue.assignees.length,
          }),
          rulesDetail: t("rulesNote"),
          llmDetail: (mode) =>
            mode === "llm" ? t("llmUsed") : t("llmSkipped"),
          mergeDetail: (record) =>
            record.result.generationMode === "llm"
              ? t("mergedLlm", { id: record.id })
              : t("mergedDeterministic", { id: record.id }),
          run: () => analyzeIssue(id),
        })) {
          controller.enqueue(
            encoder.encode(encodeSse(frame.event, frame.data)),
          );
        }
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...CORS_HEADERS,
    },
  });
}
