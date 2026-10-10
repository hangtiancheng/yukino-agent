import { prisma } from "@/lib/db";
import { buildReviewChecklist } from "@/lib/devflow/content-index";
import { errorMessage, fail, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const pr = await prisma.pullRequest.findUnique({
      where: { id },
      include: { files: true, reviewComments: true },
    });
    if (!pr) return fail(404, "prNotFound");

    const runs = await prisma.workflowRun.findMany({
      where: pr.headBranch
        ? { repoId: pr.repoId, headBranch: pr.headBranch }
        : { repoId: pr.repoId },
      orderBy: { githubCreatedAt: "desc" },
      take: 20,
    });

    const result = buildReviewChecklist({
      number: pr.number,
      title: pr.title,
      body: pr.body,
      state: pr.state,
      baseBranch: pr.baseBranch,
      headBranch: pr.headBranch,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changedFiles,
      files: pr.files.map((f) => ({ filename: f.filename })),
      reviewCommentCount: pr.reviewComments.length,
      runs: runs.map((r) => ({
        name: r.name,
        status: r.status,
        conclusion: r.conclusion,
      })),
    });
    return ok({ prId: pr.id, ...result });
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
