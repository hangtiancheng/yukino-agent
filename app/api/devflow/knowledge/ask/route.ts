import { z } from "zod/v4";
import { KnowledgeAskSchema } from "@/lib/devflow/schemas";
import {
  askKnowledge,
  askKnowledgeExtractive,
  getKnowledgeConfig,
} from "@/lib/devflow/rag";
import { errorMessage, fail, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

const TopKProbeSchema = z.object({ topK: z.number().optional() });

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();
    const parsed = KnowledgeAskSchema.safeParse(body);
    if (!parsed.success) {
      return fail(400, "invalidRequest", {
        detail: parsed.error.issues.map((i) => i.message).join(", "),
      });
    }
    const { repoId, question } = parsed.data;
    const probe = TopKProbeSchema.safeParse(body);
    const providedTopK = probe.success && probe.data.topK !== undefined;
    const topK = providedTopK
      ? parsed.data.topK
      : (await getKnowledgeConfig(repoId)).topK;

    try {
      const result = await askKnowledge(repoId, question, topK);
      return ok(result);
    } catch (e) {
      try {
        const fallback = await askKnowledgeExtractive(repoId, question, topK);
        return ok({ ...fallback, degraded: errorMessage(e) });
      } catch {
        return failRaw(500, errorMessage(e));
      }
    }
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
