import { getTranslations } from "next-intl/server";
import { z } from "zod/v4";
import { prisma } from "@/lib/db";
import { requireOncallAdmin } from "@/lib/ai/admin";
import { validateChatPrompt } from "@/lib/ai/prompts-skills";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-admin-token",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

const promptPostSchema = z.object({
  name: z.string(),
  content: z.string().optional(),
  enabled: z.boolean().optional(),
});

export async function GET() {
  const t = await getTranslations("api.oncall");
  try {
    const prompts = await prisma.chatPrompt.findMany({
      orderBy: { name: "asc" },
    });
    return Response.json(
      {
        message: "OK",
        data: {
          items: prompts.map((p) => ({
            id: p.id,
            name: p.name,
            content: p.content,
            enabled: p.enabled,
            createdAt: p.createdAt.toISOString(),
            updatedAt: p.updatedAt.toISOString(),
          })),
        },
      },
      { headers: CORS_HEADERS },
    );
  } catch (e) {
    return Response.json(
      {
        message: t("promptsUnavailable", {
          error: e instanceof Error ? e.message : String(e),
        }),
        data: null,
      },
      { status: 503, headers: CORS_HEADERS },
    );
  }
}

export async function POST(request: Request) {
  const t = await getTranslations("api.oncall");
  const admin = requireOncallAdmin(request);
  if (admin !== null) {
    return Response.json(
      {
        message: t(
          admin === "not_configured"
            ? "adminNotConfigured"
            : "adminUnauthorized",
        ),
        data: null,
      },
      { status: admin === "not_configured" ? 403 : 401, headers: CORS_HEADERS },
    );
  }
  const parsed = promptPostSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return Response.json(
      {
        message: t("invalidPromptBody", {
          error: parsed.error.issues.map((i) => i.message).join(", "),
        }),
        data: null,
      },
      { status: 400, headers: CORS_HEADERS },
    );
  }
  const { name, content, enabled } = parsed.data;
  const existing = await prisma.chatPrompt
    .findUnique({ where: { name: name.trim() } })
    .catch(() => null);
  const checked = validateChatPrompt(name, content ?? existing?.content ?? "");
  if (!checked.ok) {
    return Response.json(
      { message: t("promptValidation", { error: checked.error }), data: null },
      { status: 400, headers: CORS_HEADERS },
    );
  }
  try {
    const data = {
      name: checked.name,
      content: checked.content,
      ...(enabled !== undefined ? { enabled } : {}),
    };
    const record = existing
      ? await prisma.chatPrompt.update({ where: { id: existing.id }, data })
      : await prisma.chatPrompt.create({
          data: { ...data, enabled: enabled ?? true },
        });
    return Response.json(
      {
        message: "OK",
        data: {
          id: record.id,
          name: record.name,
          content: record.content,
          enabled: record.enabled,
          createdAt: record.createdAt.toISOString(),
          updatedAt: record.updatedAt.toISOString(),
        },
      },
      { headers: CORS_HEADERS },
    );
  } catch (e) {
    return Response.json(
      {
        message: t("promptsUnavailable", {
          error: e instanceof Error ? e.message : String(e),
        }),
        data: null,
      },
      { status: 503, headers: CORS_HEADERS },
    );
  }
}
