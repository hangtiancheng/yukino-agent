import { z } from "zod/v4";

export async function mailboxRequest<T>(
  url: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const envelope = z
    .object({ message: z.string(), data: z.unknown() })
    .parse(await response.json());
  if (!response.ok) throw new Error(envelope.message);
  return schema.parse(envelope.data);
}
export const post = (data: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(data),
});
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "操作失败，请重试";
export const displayDate = (value: string) =>
  new Date(value).toLocaleString("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  });
