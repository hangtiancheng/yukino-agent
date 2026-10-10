import { sentryMetrics } from "@/lib/metrics";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET() {
  const body = await sentryMetrics.registry.metrics();
  return new Response(body, {
    headers: {
      "Content-Type": sentryMetrics.registry.contentType,
      ...CORS_HEADERS,
    },
  });
}
