import { getTranslations } from "next-intl/server";
import {
  debugRun,
  type AnalysisProvenance,
} from "@/lib/devflow/agents/analysis";
import { analysisStreamFrames, encodeSse } from "@/lib/devflow/analyze-stream";
import { CORS_HEADERS, errorMessage, failRaw } from "@/lib/devflow/http";
import type { CIDebug } from "@/lib/devflow/schemas";
import { prisma } from "@/lib/db";

export { OPTIONS } from "@/lib/devflow/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  let run: {
    name: string;
    status: string;
    conclusion: string | null;
    logsText: string | null;
    jobs: unknown;
  } | null = null;
  try {
    run = await prisma.workflowRun.findUnique({
      where: { id },
      select: {
        name: true,
        status: true,
        conclusion: true,
        logsText: true,
        jobs: true,
      },
    });
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
  if (!run) return failRaw(404, `Workflow run ${id} not found`);

  const t = await getTranslations("devflow.analyzeStream");
  const jobsCount = Array.isArray(run.jobs) ? run.jobs.length : 0;
  const logChars = (run.logsText ?? "").length;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const frame of analysisStreamFrames<
          CIDebug & AnalysisProvenance
        >({
          contextDetail: t("contextRun", {
            name: run.name,
            status: run.status,
            conclusion: run.conclusion ?? "-",
            jobs: jobsCount,
            logChars,
          }),
          rulesDetail: t("rulesNote"),
          llmDetail: (mode) =>
            mode === "llm" ? t("llmUsed") : t("llmSkipped"),
          mergeDetail: (record) =>
            record.result.generationMode === "llm"
              ? t("mergedLlm", { id: record.id })
              : t("mergedDeterministic", { id: record.id }),
          run: () => debugRun(id),
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
