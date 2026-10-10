import { prisma } from "@/lib/db";
import { errorMessage, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const url = new URL(request.url);
    const state = url.searchParams.get("state");
    const q = url.searchParams.get("q")?.toLowerCase() ?? "";

    const issues = await prisma.issue.findMany({
      where: {
        repoId: id,
        ...(state ? { state } : {}),
        ...(q
          ? {
              OR: [
                { title: { contains: q, mode: "insensitive" } },
                { body: { contains: q, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      orderBy: { githubUpdatedAt: "desc" },
      take: 200,
    });

    const analyses = await prisma.analysisResult.findMany({
      where: {
        targetType: "issue",
        targetId: { in: issues.map((i) => i.id) },
      },
      orderBy: { createdAt: "desc" },
      select: { targetId: true, id: true, createdAt: true },
    });
    const latestByIssue = new Map<string, { id: string; createdAt: Date }>();
    for (const a of analyses) {
      if (!latestByIssue.has(a.targetId)) {
        latestByIssue.set(a.targetId, { id: a.id, createdAt: a.createdAt });
      }
    }

    return ok(
      issues.map((issue) => ({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: issue.labels,
        author: issue.author,
        assignees: issue.assignees,
        githubCreatedAt: issue.githubCreatedAt,
        githubUpdatedAt: issue.githubUpdatedAt,
        latestAnalysis: latestByIssue.get(issue.id) ?? null,
      })),
    );
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
