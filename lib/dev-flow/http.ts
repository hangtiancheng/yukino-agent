import type { Messages } from "next-intl";
import { getTranslations } from "next-intl/server";

export type ApiDevFlowKey = keyof Messages["api"]["devFlow"];

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function ok(data: unknown, status = 200): Response {
  return Response.json(
    { message: "OK", data },
    { status, headers: CORS_HEADERS },
  );
}

export async function fail(
  status: number,
  key: ApiDevFlowKey,
  args?: Record<string, string | number>,
): Promise<Response> {
  const t = await getTranslations("api.devFlow");
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
  if (e instanceof Error) {
    return e.message;
  }
  return String(e);
}
