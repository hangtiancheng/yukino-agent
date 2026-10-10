import { z } from "zod/v4";
import { prisma } from "@/lib/db";
import { errorMessage, fail, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

const BodySchema = z.object({ repoId: z.string().min(1) });

export async function POST(request: Request) {
  try {
    const parsed = BodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return fail(400, "invalidRequest", {
        detail: parsed.error.issues.map((i) => i.message).join(", "),
      });
    }
    const repo = await prisma.repository.findUnique({
      where: { id: parsed.data.repoId },
    });
    if (!repo) return fail(404, "repoNotFound");
    const [openIssues, openPrs, failedCi, mergedPrs7d] = await Promise.all([
      prisma.issue.count({ where: { repoId: repo.id, state: "open" } }),
      prisma.pullRequest.count({ where: { repoId: repo.id, state: "open" } }),
      prisma.workflowRun.count({
        where: { repoId: repo.id, conclusion: "failure" },
      }),
      prisma.pullRequest.count({
        where: {
          repoId: repo.id,
          mergedAt: { gte: new Date(Date.now() - 7 * 24 * 3600 * 1000) },
        },
      }),
    ]);
    const risks: string[] = [];
    if (failedCi > 0)
      risks.push("Failed CI runs present — investigate before merging.");
    if (openPrs > 10)
      risks.push(
        "Large open-PR backlog — review throughput may be a bottleneck.",
      );
    return ok({
      repoId: repo.id,
      summary:
        risks.length > 0
          ? "Repo health has items to watch; see risks."
          : "Repo health looks normal.",
      metrics: {
        open_issues: openIssues,
        open_prs: openPrs,
        failed_ci_runs: failedCi,
        merged_prs_7d: mergedPrs7d,
      },
      risks,
    });
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
