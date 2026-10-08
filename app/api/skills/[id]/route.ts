// PATCH  /api/skills/[id] — toggle `enabled` and/or replace the SKILL.md body
// (frontmatter re-validated; the name stays the row's own).
// DELETE /api/skills/[id] — remove the asset.
// Enabled state drives the load_skill catalog (Yukino.md #19: only enabled
// skills are exposed to the model), so this is the admin review gate.
import { getTranslations } from "next-intl/server";
import { z } from "zod/v4";
import { prisma } from "@/lib/db";
import { validateSkillMarkdown } from "@/lib/ai/prompts-skills";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

interface RouteContext {
  params: Promise<{ id: string }>;
}

const skillPatchSchema = z.object({
  enabled: z.boolean().optional(),
  content: z.string().optional(),
});

export async function PATCH(request: Request, context: RouteContext) {
  const t = await getTranslations("api.oncall");
  const { id } = await context.params;
  const parsed = skillPatchSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return Response.json(
      {
        message: t("invalidSkillBody", {
          error: parsed.error.issues.map((i) => i.message).join(", "),
        }),
        data: null,
      },
      { status: 400, headers: CORS_HEADERS },
    );
  }
  const { enabled, content } = parsed.data;
  if (enabled === undefined && content === undefined) {
    return Response.json(
      {
        message: t("invalidSkillBody", { error: "nothing to update" }),
        data: null,
      },
      { status: 400, headers: CORS_HEADERS },
    );
  }
  let validated: { name: string; description: string } | null = null;
  if (content !== undefined) {
    const result = validateSkillMarkdown(content);
    if (!result.ok) {
      return Response.json(
        { message: t("skillValidation", { error: result.error }), data: null },
        { status: 400, headers: CORS_HEADERS },
      );
    }
    validated = {
      name: result.skill.name,
      description: result.skill.description,
    };
  }
  try {
    const existing = await prisma.skillAsset.findUnique({ where: { id } });
    if (existing === null) {
      return Response.json(
        { message: t("skillNotFound"), data: null },
        { status: 404, headers: CORS_HEADERS },
      );
    }
    if (validated !== null && validated.name !== existing.name) {
      // Identity comes from the row; re-naming via a content rewrite would
      // silently fork the catalog. Honest refusal instead.
      return Response.json(
        {
          message: t("skillValidation", {
            error: `SKILL.md name "${validated.name}" does not match this asset ("${existing.name}").`,
          }),
          data: null,
        },
        { status: 400, headers: CORS_HEADERS },
      );
    }
    const skill = await prisma.skillAsset.update({
      where: { id },
      data: {
        ...(enabled !== undefined ? { enabled } : {}),
        ...(content !== undefined ? { content: content.trim() } : {}),
        ...(validated !== null ? { description: validated.description } : {}),
      },
    });
    return Response.json(
      {
        message: "OK",
        data: {
          id: skill.id,
          name: skill.name,
          description: skill.description,
          content: skill.content,
          enabled: skill.enabled,
        },
      },
      { headers: CORS_HEADERS },
    );
  } catch (e) {
    return Response.json(
      {
        message: t("skillsUnavailable", {
          error: e instanceof Error ? e.message : String(e),
        }),
        data: null,
      },
      { status: 503, headers: CORS_HEADERS },
    );
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const t = await getTranslations("api.oncall");
  const { id } = await context.params;
  try {
    const existing = await prisma.skillAsset.findUnique({ where: { id } });
    if (existing === null) {
      return Response.json(
        { message: t("skillNotFound"), data: null },
        { status: 404, headers: CORS_HEADERS },
      );
    }
    await prisma.skillAsset.delete({ where: { id } });
    return Response.json(
      { message: "OK", data: { id, deleted: true } },
      { headers: CORS_HEADERS },
    );
  } catch (e) {
    return Response.json(
      {
        message: t("skillsUnavailable", {
          error: e instanceof Error ? e.message : String(e),
        }),
        data: null,
      },
      { status: 503, headers: CORS_HEADERS },
    );
  }
}
