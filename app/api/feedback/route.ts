import { getTranslations } from "next-intl/server";
import { prisma } from "@/lib/db";
import {
  FeedbackListQuerySchema,
  FeedbackUpsertSchema,
  type FeedbackView,
} from "@/lib/ai/feedback";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

function toView(row: {
  id: string;
  sessionId: string;
  targetType: string;
  targetId: string;
  subjectId: string;
  rating: string;
  reason: string | null;
  comment: string | null;
  correction: string | null;
  createdAt: Date;
  updatedAt: Date;
}): FeedbackView {
  return {
    id: row.id,
    sessionId: row.sessionId,
    targetType: row.targetType,
    targetId: row.targetId,
    subjectId: row.subjectId,
    rating: row.rating,
    reason: row.reason,
    comment: row.comment,
    correction: row.correction,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function GET(request: Request) {
  const t = await getTranslations("api.oncall");
  const parsed = FeedbackListQuerySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!parsed.success) {
    return Response.json(
      { message: t("invalidFeedbackQuery"), data: null },
      { status: 400, headers: CORS_HEADERS },
    );
  }
  try {
    const rows = await prisma.userFeedback.findMany({
      where: {
        targetType: parsed.data.targetType,
        targetId: parsed.data.targetId,
      },
      orderBy: { updatedAt: "desc" },
    });
    return Response.json(
      { message: "OK", data: { items: rows.map(toView) } },
      { headers: CORS_HEADERS },
    );
  } catch (e) {
    console.error("[/api/feedback] list failed:", e);
    return Response.json(
      { message: t("feedbackUnavailable"), data: null },
      { status: 503, headers: CORS_HEADERS },
    );
  }
}

export async function POST(request: Request) {
  const t = await getTranslations("api.oncall");
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { message: t("invalidJsonBody"), data: null },
      { status: 400, headers: CORS_HEADERS },
    );
  }
  const parsed = FeedbackUpsertSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { message: t("invalidFeedbackBody"), data: null },
      { status: 400, headers: CORS_HEADERS },
    );
  }
  const input = parsed.data;
  try {
    const row = await prisma.userFeedback.upsert({
      where: {
        targetType_targetId_subjectId: {
          targetType: input.targetType,
          targetId: input.targetId,
          subjectId: input.subjectId ?? "",
        },
      },
      create: {
        targetType: input.targetType,
        targetId: input.targetId,
        subjectId: input.subjectId ?? "",
        sessionId: input.sessionId ?? "",
        rating: input.rating,
        reason: input.reason ?? null,
        comment: input.comment ?? null,
        correction: input.correction ?? null,
      },
      update: {
        rating: input.rating,
        reason: input.reason ?? null,
        comment: input.comment ?? null,
        correction: input.correction ?? null,
        ...(input.sessionId !== undefined
          ? { sessionId: input.sessionId }
          : {}),
      },
    });
    return Response.json(
      { message: "OK", data: toView(row) },
      { headers: CORS_HEADERS },
    );
  } catch (e) {
    console.error("[/api/feedback] upsert failed:", e);
    return Response.json(
      { message: t("feedbackUnavailable"), data: null },
      { status: 503, headers: CORS_HEADERS },
    );
  }
}
