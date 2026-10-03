// POST /api/devflow/knowledge/ask — evidence-grounded QA with citations.
import { KnowledgeAskSchema } from "@/lib/devflow/schemas";
import { askKnowledge } from "@/lib/devflow/rag";
import { errorMessage, fail, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

export async function POST(request: Request) {
  try {
    const parsed = KnowledgeAskSchema.safeParse(await request.json());
    if (!parsed.success) {
      return fail(
        400,
        `Invalid request: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
      );
    }
    const { repoId, question, topK } = parsed.data;
    const result = await askKnowledge(repoId, question, topK);
    return ok(result);
  } catch (e) {
    return fail(500, errorMessage(e));
  }
}
