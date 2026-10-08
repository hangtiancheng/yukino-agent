// POST /api/devflow/chat — SSE stream of the DevFlow tool-calling agent.
// Events: connected / message (text delta) / tool ({name,state,input?}) /
// done ({conversationId,userMessageId,assistantMessageId}) / error. The error
// frame is either the single-line JSON {message, assistantMessageId?} emitted
// after the agent persisted a failure turn (B-3), or the raw message of an
// unexpected throw. Same framing conventions as /api/chat_stream.
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
        // SSE payloads must not contain raw newlines: emit one `data:` line
        // per text line (the client rejoins them with "\n").
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
            // Single-line JSON survives the line-splitting framing.
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
            // JSON.stringify escapes newlines, so this stays single-line-safe.
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
                // Knowledge citations collected during the turn (also
                // persisted on the assistant message's meta for reloads).
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
