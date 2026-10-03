// POST /api/devflow/chat — SSE stream of the DevFlow tool-calling agent.
// Events: connected / message (text delta) / tool ({name,state,input?}) /
// done / error. Same framing conventions as /api/chat_stream.
import { DevflowChatSchema } from "@/lib/devflow/schemas";
import { devflowChatStream } from "@/lib/devflow/agents/chat";
import { CORS_HEADERS } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

export async function POST(request: Request) {
  const parsed = DevflowChatSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return Response.json(
      {
        message:
          "Invalid request: repoId and a non-empty messages array are required",
        data: null,
      },
      { status: 400, headers: CORS_HEADERS },
    );
  }
  const { repoId, messages } = parsed.data;

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
        for await (const ev of devflowChatStream(repoId, messages)) {
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
          } else {
            send("done", "Stream completed");
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
