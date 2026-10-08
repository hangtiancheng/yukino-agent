// Shared HTTP helpers for the DevFlow API routes: the project-wide
// { message, data } envelope plus CORS handling, matching the conventions of
// the existing /api/* routes.
//
// Error messages are localized like every other surface: `fail()` takes an
// api.devflow catalog key and renders it in the request's locale (yukino_locale
// cookie → Accept-Language, resolved by i18n/request.ts). `failRaw()` is the
// explicit escape hatch for dynamic technical diagnostics (exception text,
// GitHub API details) that have no catalog entry.
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

// Normalize unknown throwables into a client-safe message.
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
