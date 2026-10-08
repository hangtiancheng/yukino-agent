// POST /api/devflow/knowledge/search — retrieval test over a repo's KB.
// `scope` selects the source slice (knowledge base / synced GitHub content
// items / project docs), `docId` narrows a KB scope to one document and
// `sourceType` post-filters chunk metadata — the minimal set of the legacy
// routes/search.py metadata_filters. Defaults keep the old behavior.
import { z } from "zod/v4";
import { quote } from "@/lib/milvus/client";
import { KnowledgeSearchSchema } from "@/lib/devflow/schemas";
import {
  kbFilter,
  kbSource,
  searchKnowledge,
  getKnowledgeConfig,
} from "@/lib/devflow/rag";
import { contentScopeFilter } from "@/lib/devflow/content-index";
import { projectFilter } from "@/lib/devflow/project-index";
import { errorMessage, fail, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

const SearchBodySchema = KnowledgeSearchSchema.extend({
  docId: z.string().min(1).optional(),
  scope: z.enum(["kb", "item", "project"]).optional(),
  sourceType: z.string().min(1).max(80).optional(),
});

// Was topK explicitly provided? If not, the per-repo KnowledgeBaseConfig
// default applies (legacy knowledge_base_config).
const TopKProbeSchema = z.object({ topK: z.number().optional() });

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();
    const parsed = SearchBodySchema.safeParse(body);
    if (!parsed.success) {
      return fail(400, "invalidRequest", {
        detail: parsed.error.issues.map((i) => i.message).join(", "),
      });
    }
    const { repoId, query, docId, scope, sourceType } = parsed.data;
    const probe = TopKProbeSchema.safeParse(body);
    const providedTopK = probe.success && probe.data.topK !== undefined;
    const topK = providedTopK
      ? parsed.data.topK
      : (await getKnowledgeConfig(repoId)).topK;

    let filter: string;
    if ((scope ?? "kb") === "kb") {
      filter = docId
        ? `source == ${quote(kbSource(repoId, docId))}`
        : kbFilter(repoId);
    } else {
      if (docId) {
        return fail(400, "invalidRequest", {
          detail: "docId is only supported with the kb scope",
        });
      }
      filter =
        scope === "item" ? contentScopeFilter(repoId) : projectFilter(repoId);
    }

    const started = Date.now();
    const hits = await searchKnowledge(repoId, query, topK, {
      filter,
      sourceType,
    });
    return ok({
      query,
      durationMs: Date.now() - started,
      hits: hits.map((hit) => ({
        docId: hit.docId,
        docName: hit.docName,
        chunkIndex: hit.chunkIndex,
        score: Number(hit.score.toFixed(4)),
        content: hit.content,
        sectionTitle: hit.sectionTitle,
        sourceType: hit.sourceType,
      })),
    });
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
