// GET /api/devflow/issues/:id/similar — semantically similar issues in the
// same repo (port of routes/issues.py:308-313, which queried the synced
// GitHub-content vectors with the issue title+body over the "issue" source
// type). Requires the content index (POST /api/devflow/content-index) to
// have run; when the vector backend is unavailable the endpoint says so
// honestly instead of pretending to have results.
import { prisma } from "@/lib/db";
import {
  contentScopeFilter,
  mapSimilarHits,
} from "@/lib/devflow/content-index";
import { scopedRetrieve } from "@/lib/devflow/search";
import { errorMessage, fail, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

// issues.py:313 uses limit=5.
const SIMILAR_TOP_K = 5;

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const issue = await prisma.issue.findUnique({ where: { id } });
    if (!issue) return fail(404, "issueNotFound");
    const repo = await prisma.repository.findUnique({
      where: { id: issue.repoId },
    });
    if (!repo) return fail(404, "repoNotFound");

    const query = `${issue.title}\n${issue.body ?? ""}`;
    let docs;
    try {
      // One extra candidate so excluding the query issue itself can still
      // yield 5 distinct issues (mapSimilarHits dedups per item).
      docs = await scopedRetrieve(
        query,
        SIMILAR_TOP_K + 1,
        contentScopeFilter(issue.repoId, "issue"),
      );
    } catch {
      return fail(503, "vectorSearchUnavailable");
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
