import { getTranslations } from "next-intl/server";
import type { Messages } from "next-intl";

export type ApiDevflowKey = keyof Messages["api"]["devflow"];

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function ok<T>(data: T, status = 200): Response {
  return Response.json(
    { message: "OK", data },
    { status, headers: CORS_HEADERS },
  );
}

export async function fail(
  status: number,
  key: ApiDevflowKey,
  args?: Record<string, string | number>,
): Promise<Response> {
  const t = await getTranslations("api.devflow");
  return Response.json(
    { message: args ? t(key, args) : t(key), data: null },
    { status, headers: CORS_HEADERS },
  );
}

export function failRaw(status: number, message: string): Response {
  return Response.json(
    { message, data: null },
    { status, headers: CORS_HEADERS },
  );
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
