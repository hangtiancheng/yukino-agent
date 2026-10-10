import {
  recordInvalidReportBatch,
  recordReportBatch,
  reportBatchSchema,
} from "@/lib/metrics";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = JSON.parse(await request.text());
  } catch {
    recordInvalidReportBatch();
    return Response.json(
      { message: "invalid JSON body", data: null },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  const parsed = reportBatchSchema.safeParse(body);
  if (!parsed.success) {
    recordInvalidReportBatch();
    return Response.json(
      { message: "invalid report batch", data: null },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  recordReportBatch(parsed.data);
  return Response.json(
    { message: "OK", data: { received: parsed.data.length } },
    { headers: CORS_HEADERS },
  );
}
