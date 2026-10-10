import { prisma } from "@/lib/db";
import {
  WorkflowExecuteRequestSchema,
  executeWorkflow,
} from "@/lib/devflow/agents/workflow";
import { CORS_HEADERS, errorMessage, fail, failRaw } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

export async function POST(request: Request) {
  const parsed = WorkflowExecuteRequestSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return fail(400, "invalidRequest", {
      detail: parsed.error.issues.map((i) => i.message).join(", "),
    });
  }
  const { runId } = parsed.data;

  try {
    const run = await prisma.agentWorkflowRun.findUnique({
      where: { id: runId },
      select: { id: true, status: true },
    });
    if (!run) return fail(404, "workflowRunNotFound");
    if (run.status !== "running") return fail(409, "workflowRunNotRunnable");
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: string) => {
        const dataLines = data
          .split("\n")
          .map((line) => `data: ${line}`)
          .join("\n");
        controller.enqueue(
          encoder.encode(
            `id: ${Date.now()}\nevent: ${event}\n${dataLines}\n\n`,
          ),
        );
      };
      send("connected", JSON.stringify({ status: "connected", runId }));
      try {
        await executeWorkflow({
          runId,
          onEvent: (event) => {
            switch (event.type) {
              case "task_start":
                send("task_start", JSON.stringify(event));
                break;
              case "task_result":
                send("task_result", JSON.stringify(event));
                break;
              case "observation":
                send(
                  "observation",
                  JSON.stringify({
                    iteration: event.iteration,
                    isReplan: event.isReplan,
                    replannedClaims: event.replannedClaims,
                    observation: event.observation,
                  }),
                );
                break;
              case "memo":
                send(
                  "memo",
                  JSON.stringify({
                    answer: event.answer,
                    generationMode: event.generationMode,
                  }),
                );
                break;
              case "done":
                send("done", JSON.stringify(event));
                break;
            }
          },
        });
      } catch (e) {
        send("error", JSON.stringify({ message: errorMessage(e) }));
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
