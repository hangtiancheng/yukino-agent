import { z } from "zod/v4";
import { config } from "@/lib/config";

export class MailboxError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function json(data: unknown, message = "ok", status = 200) {
  return Response.json(
    { message, data },
    { status, headers: { "Cache-Control": "private, no-store" } },
  );
}

export function failure(error: unknown) {
  if (error instanceof MailboxError)
    return json(null, error.message, error.status);
  if (error instanceof z.ZodError)
    return json(null, error.issues[0]?.message ?? "输入格式不正确", 400);
  // Do not log account identifiers, submitted content, credentials, or database errors.
  console.error("[mailbox] request failed");
  return json(null, "服务暂时不可用，请稍后重试", 503);
}

export function assertSameOrigin(request: Request) {
  // All mutations require a browser Origin, including pre-login requests.
  const origin = request.headers.get("origin");
  if (origin !== new URL(config.account.appUrl).origin) {
    throw new MailboxError(403, "请求来源不受信任，请从本站重新操作");
  }
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    throw new MailboxError(415, "请求必须使用 JSON 格式");
  }
}

export async function body<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<T> {
  // Stream cap also bounds requests without a Content-Length header.
  const reader = request.body?.getReader();
  if (!reader) throw new MailboxError(400, "请求不能为空");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > 128000) {
      await reader.cancel();
      throw new MailboxError(413, "内容过长");
    }
    chunks.push(part.value);
  }
  let input: unknown;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new MailboxError(400, "请求格式不正确");
  }
  return schema.parse(input);
}
