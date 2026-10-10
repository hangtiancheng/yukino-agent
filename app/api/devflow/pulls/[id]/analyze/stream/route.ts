import { getTranslations } from "next-intl/server";
import {
  reviewPull,
  type AnalysisProvenance,
} from "@/lib/devflow/agents/analysis";
import { analysisStreamFrames, encodeSse } from "@/lib/devflow/analyze-stream";
import { CORS_HEADERS, errorMessage, failRaw } from "@/lib/devflow/http";
import type { PRReview } from "@/lib/devflow/schemas";
import { prisma } from "@/lib/db";

export { OPTIONS } from "@/lib/devflow/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  let pr: {
    number: number;
    title: string;
    state: string;
    _count: { files: number; reviewComments: number };
  } | null = null;
  try {
    pr = await prisma.pullRequest.findUnique({
      where: { id },
      select: {
        number: true,
        title: true,
        state: true,
        _count: { select: { files: true, reviewComments: true } },
      },
    });
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
  if (!pr) return failRaw(404, `Pull request ${id} not found`);

  const t = await getTranslations("devflow.analyzeStream");
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const frame of analysisStreamFrames<
          PRReview & AnalysisProvenance
        >({
          contextDetail: t("contextPull", {
            number: pr.number,
            title: pr.title,
            files: pr._count.files,
            comments: pr._count.reviewComments,
          }),
          rulesDetail: t("rulesNote"),
          llmDetail: (mode) =>
            mode === "llm" ? t("llmUsed") : t("llmSkipped"),
          mergeDetail: (record) =>
            record.result.generationMode === "llm"
              ? t("mergedLlm", { id: record.id })
              : t("mergedDeterministic", { id: record.id }),
          run: () => reviewPull(id),
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
