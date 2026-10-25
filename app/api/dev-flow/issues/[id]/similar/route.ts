import { prisma } from "@/lib/db";
import {
  contentScopeFilter,
  mapSimilarHits,
} from "@/lib/dev-flow/content-index";
import { errorMessage, fail, failRaw, ok } from "@/lib/dev-flow/http";
import { scopedRetrieve } from "@/lib/dev-flow/search";

export { OPTIONS } from "@/lib/dev-flow/http";

const SIMILAR_TOP_K = 5;

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const issue = await prisma.issue.findUnique({ where: { id } });
    if (!issue) {
      return await fail(404, "issueNotFound");
    }
    const repo = await prisma.repository.findUnique({
      where: { id: issue.repoId },
    });
    if (!repo) {
      return await fail(404, "repoNotFound");
    }

    const query = `${issue.title}\n${issue.body ?? ""}`;
    let docs;
    try {
      docs = await scopedRetrieve(
        query,
        SIMILAR_TOP_K + 1,
        contentScopeFilter(issue.repoId, "issue"),
      );
    } catch {
      return await fail(503, "vectorSearchUnavailable");
    }
    return ok(
      mapSimilarHits(docs, {
        repoFullName: repo.fullName,
        excludeItemId: issue.id,
        limit: SIMILAR_TOP_K,
      }),
    );
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
