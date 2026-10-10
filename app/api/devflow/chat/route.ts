import { DevflowChatSchema } from "@/lib/devflow/schemas";
import { devflowChatStream } from "@/lib/devflow/agents/chat";
import { CORS_HEADERS, fail } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

export async function POST(request: Request) {
  const parsed = DevflowChatSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return fail(400, "chatInvalidRequest");
  }
  const { repoId, conversationId, message } = parsed.data;

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
      send("connected", JSON.stringify({ status: "connected", repoId }));
      try {
        for await (const ev of devflowChatStream(repoId, {
          conversationId,
          message,
        })) {
          if (ev.type === "text") {
            send("message", ev.content);
          } else if (ev.type === "tool") {
            send(
              "tool",
              JSON.stringify({
                name: ev.name,
                state: ev.state,
                ...(ev.state === "call" && ev.input !== undefined
                  ? { input: ev.input }
                  : {}),
              }),
            );
          } else if (ev.type === "error") {
            send(
              "error",
              JSON.stringify({
                message: ev.message,
                ...(ev.assistantMessageId
                  ? { assistantMessageId: ev.assistantMessageId }
                  : {}),
              }),
            );
          } else {
            send(
              "done",
              JSON.stringify({
                conversationId: ev.conversationId,
                userMessageId: ev.userMessageId,
                assistantMessageId: ev.assistantMessageId,
                ...(ev.citations && ev.citations.length > 0
                  ? { citations: ev.citations }
                  : {}),
              }),
            );
          }
        }
      } catch (e) {
        send("error", e instanceof Error ? e.message : String(e));
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
