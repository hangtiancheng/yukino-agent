import { getTranslations } from "next-intl/server";
import { z } from "zod/v4";
import { prisma } from "@/lib/db";
import { validateSkillMarkdown } from "@/lib/ai/prompts-skills";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

const skillPostSchema = z.object({
  fileName: z.string().optional(),
  content: z.string(),
});

function skillPayload(skill: {
  id: string;
  name: string;
  description: string;
  content: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    content: skill.content,
    enabled: skill.enabled,
    createdAt: skill.createdAt.toISOString(),
    updatedAt: skill.updatedAt.toISOString(),
  };
}

export async function GET() {
  const t = await getTranslations("api.oncall");
  try {
    const skills = await prisma.skillAsset.findMany({
      orderBy: { name: "asc" },
    });
    return Response.json(
      { message: "OK", data: { items: skills.map(skillPayload) } },
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

export async function POST(request: Request) {
  const t = await getTranslations("api.oncall");
  const parsed = skillPostSchema.safeParse(
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
  const result = validateSkillMarkdown(
    parsed.data.content,
    parsed.data.fileName,
  );
  if (!result.ok) {
    return Response.json(
      { message: t("skillValidation", { error: result.error }), data: null },
      { status: 400, headers: CORS_HEADERS },
    );
  }
  const { name, description, content } = result.skill;
  try {
    const existing = await prisma.skillAsset.findUnique({ where: { name } });
    const skill = existing
      ? await prisma.skillAsset.update({
          where: { id: existing.id },
          data: { description, content },
        })
      : await prisma.skillAsset.create({
          data: { name, description, content },
        });
    return Response.json(
      { message: "OK", data: skillPayload(skill) },
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
