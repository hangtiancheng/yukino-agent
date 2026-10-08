// POST /api/chat_stream — SSE stream with framing id / event / data and
// events connected, message, done, error.
import { getTranslations } from "next-intl/server";
import { z } from "zod/v4";
import { chatStream } from "@/lib/ai/pipelines/chat";

// P2-20 fix: add CORS_HEADERS + OPTIONS handler for preflight requests,
// matching the pattern used by all other API routes.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

const streamRequestSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
});

export async function POST(request: Request) {
  const parsed = streamRequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    const t = await getTranslations("api.oncall");
    return Response.json(
      { message: t("missingIdOrQuestion"), data: null },
      { status: 400 },
    );
  }
  const { id, question } = parsed.data;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: string) => {
        // SSE payloads must not contain raw newlines: emit one `data:` line
        // per text line (the client rejoins them with "\n"), otherwise
        // multi-line chunks break the framing and lines get dropped.
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
      // Send a connected event first.
      send("connected", JSON.stringify({ status: "connected", client_id: id }));
      try {
        for await (const ev of chatStream(id, question)) {
          if (ev.type === "a2ui") {
            // JSON.stringify output is single-line, so it survives the
            // line-splitting `send` framing as one data: line.
            send("a2ui", JSON.stringify(ev.messages));
          } else if (ev.type === "references") {
            // Grounding sources for this turn (single-line JSON array).
            send("references", JSON.stringify(ev.references));
          } else if (ev.type === "reasoning") {
            // Model reasoning delta (legacy reasoning.delta) — plain text
            // like message chunks, so the multi-line framing applies.
            send("reasoning", ev.content);
          } else if (ev.type === "tool") {
            // Tool-call lifecycle (legacy tool.call): single-line JSON.
            send(
              "tool",
              JSON.stringify({ id: ev.id, name: ev.name, state: ev.state }),
            );
          } else {
            send("message", ev.content);
          }
        }
        send("done", "Stream completed");
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
