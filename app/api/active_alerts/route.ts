// GET /api/active_alerts — public active-alert panel feed.
// Port of the legacy provider-backed alert listing (agent_py
// api/app.py:1417-1434 GET /aiops/alerts/active; audit gap G4 — the whole
// panel endpoint was missing). Differences kept honest: the legacy route
// raised SYSTEM_UNAVAILABLE whenever the aggregated provider failed; here a
// PARTIAL provider failure still serves results and the per-source errors
// travel in `sourceErrors`, while a total failure keeps the legacy 503.
import { getTranslations } from "next-intl/server";
import { aggregateAlerts } from "@/lib/ai/alerts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET() {
  const t = await getTranslations("api.oncall");
  try {
    const { alerts, sourceErrors, anySourceOk } = await aggregateAlerts();
    if (!anySourceOk) {
      return Response.json(
        { message: t("alertsUnavailable"), data: null },
        { status: 503, headers: CORS_HEADERS },
      );
    }
    return Response.json(
      {
        message: "OK",
        data: {
          items: alerts,
          sourceErrors,
        },
      },
      { headers: CORS_HEADERS },
    );
  } catch (e) {
    return Response.json(
      {
        message: t("alertsUnavailable"),
        data: {
          sourceErrors: [
            {
              source: "aggregator",
              error: e instanceof Error ? e.message : String(e),
            },
          ],
        },
      },
      { status: 503, headers: CORS_HEADERS },
    );
  }
}
