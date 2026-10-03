// Shared HTTP helpers for the DevFlow API routes: the project-wide
// { message, data } envelope plus CORS handling, matching the conventions of
// the existing /api/* routes.
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

export function fail(status: number, message: string): Response {
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
