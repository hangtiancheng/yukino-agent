// GET /api/devflow/repos/[id]/recommendations — context-aware suggested chat
// questions (port of the legacy RecommendationAgent, pure rules, no LLM).
// `?exclude=` (repeatable) passes prior suggestions to rotate the set, like
// the legacy client's refresh flow.
import { getTranslations } from "next-intl/server";
import type { NextRequest } from "next/server";
import { z } from "zod/v4";
import { prisma } from "@/lib/db";
import { errorMessage, fail, failRaw, ok } from "@/lib/devflow/http";
import { buildRecommendations } from "@/lib/devflow/recommendations";

export { OPTIONS } from "@/lib/devflow/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const t = await getTranslations("devflow.recommendations");
    const { id } = await context.params;
    const repo = await prisma.repository.findUnique({ where: { id } });
    if (!repo) return fail(404, "repoNotFound");

    const params = request.nextUrl.searchParams;
    const parsed = z
      .object({
        exclude: z.array(z.string().max(300)).max(20).default([]),
        limit: z.coerce.number().int().min(1).max(5).default(5),
      })
      .safeParse({
        exclude: params.getAll("exclude"),
        limit: params.get("limit") ?? undefined,
      });
    if (!parsed.success) {
      return fail(400, "invalidRequest", {
        detail: parsed.error.issues.map((i) => i.message).join(", "),
      });
    }

    const [issues, pulls, runs] = await Promise.all([
      prisma.issue.findMany({
        where: { repoId: id },
        orderBy: { githubUpdatedAt: "desc" },
        take: 20,
        select: {
          number: true,
          title: true,
          state: true,
          githubUpdatedAt: true,
        },
      }),
      prisma.pullRequest.findMany({
        where: { repoId: id },
        orderBy: { githubUpdatedAt: "desc" },
        take: 20,
        select: {
          number: true,
          title: true,
          state: true,
          githubUpdatedAt: true,
        },
      }),
      prisma.workflowRun.findMany({
        where: { repoId: id },
        orderBy: { githubCreatedAt: "desc" },
        take: 20,
        select: { name: true, conclusion: true, githubCreatedAt: true },
      }),
    ]);

    const result = buildRecommendations(
      {
        issues: issues.map((i) => ({
          number: i.number,
          title: i.title,
          state: i.state,
          updatedAt: i.githubUpdatedAt,
        })),
        pulls: pulls.map((p) => ({
          number: p.number,
          title: p.title,
          state: p.state,
          updatedAt: p.githubUpdatedAt,
        })),
        runs: runs.map((r) => ({
          name: r.name,
          conclusion: r.conclusion,
          createdAt: r.githubCreatedAt,
        })),
        exclude: parsed.data.exclude,
        limit: parsed.data.limit,
      },
      (key, values) => t(key, values),
    );
    return ok(result);
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
