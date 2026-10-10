import { getTranslations } from "next-intl/server";
import { z } from "zod/v4";
import { prisma } from "@/lib/db";
import { requireOncallAdmin } from "@/lib/ai/admin";
import { validateChatPrompt } from "@/lib/ai/prompts-skills";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-admin-token",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

interface RouteContext {
  params: Promise<{ id: string }>;
}

const promptPatchSchema = z.object({
  name: z.string().optional(),
  content: z.string().optional(),
  enabled: z.boolean().optional(),
});

function adminFailure(
  admin: "not_configured" | "unauthorized",
): Promise<Response> {
  return (async () => {
    const t = await getTranslations("api.oncall");
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
  })();
}

export async function PATCH(request: Request, context: RouteContext) {
  const t = await getTranslations("api.oncall");
  const admin = requireOncallAdmin(request);
  if (admin !== null) return adminFailure(admin);
  const { id } = await context.params;
  const parsed = promptPatchSchema.safeParse(
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
  if (name === undefined && content === undefined && enabled === undefined) {
    return Response.json(
      {
        message: t("invalidPromptBody", { error: "nothing to update" }),
        data: null,
      },
      { status: 400, headers: CORS_HEADERS },
    );
  }
  try {
    const existing = await prisma.chatPrompt.findUnique({ where: { id } });
    if (existing === null) {
      return Response.json(
        { message: t("promptNotFound"), data: null },
        { status: 404, headers: CORS_HEADERS },
      );
    }
    let nextName: string | undefined;
    let nextContent: string | undefined;
    if (name !== undefined || content !== undefined) {
      const checked = validateChatPrompt(
        name ?? existing.name,
        content ?? existing.content,
      );
      if (!checked.ok) {
        return Response.json(
          {
            message: t("promptValidation", { error: checked.error }),
            data: null,
          },
          { status: 400, headers: CORS_HEADERS },
        );
      }
      nextName = checked.name;
      nextContent = checked.content;
    }
    const record = await prisma.chatPrompt.update({
      where: { id },
      data: {
        ...(nextName !== undefined ? { name: nextName } : {}),
        ...(nextContent !== undefined ? { content: nextContent } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
      },
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

export async function DELETE(request: Request, context: RouteContext) {
  const t = await getTranslations("api.oncall");
  const admin = requireOncallAdmin(request);
  if (admin !== null) return adminFailure(admin);
  const { id } = await context.params;
  try {
    const existing = await prisma.chatPrompt.findUnique({ where: { id } });
    if (existing === null) {
      return Response.json(
        { message: t("promptNotFound"), data: null },
        { status: 404, headers: CORS_HEADERS },
      );
    }
    await prisma.chatPrompt.delete({ where: { id } });
    return Response.json(
      { message: "OK", data: { deleted: id } },
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
