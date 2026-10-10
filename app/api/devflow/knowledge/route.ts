import { prisma } from "@/lib/db";
import {
  addKnowledgeDocument,
  extractText,
  getKnowledgeConfig,
  listKnowledgeDocuments,
} from "@/lib/devflow/rag";
import { errorMessage, fail, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const repoId = url.searchParams.get("repoId");
    if (!repoId) return fail(400, "repoIdQueryRequired");
    const docs = await listKnowledgeDocuments(repoId);
    return ok(
      docs.map((doc) => ({
        id: doc.id,
        name: doc.name,
        sourceType: doc.sourceType,
        status: doc.status,
        charCount: doc.charCount,
        chunkCount: doc.chunkCount,
        errorMessage: doc.errorMessage,
        createdAt: doc.createdAt,
      })),
    );
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const repoId = form.get("repoId");
    const file = form.get("file");
    if (typeof repoId !== "string" || !repoId) {
      return fail(400, "repoIdFormRequired");
    }
    if (!(file instanceof File)) {
      return fail(400, "fileFieldRequired");
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return fail(413, "fileTooLarge");
    }
    const repo = await prisma.repository.findUnique({ where: { id: repoId } });
    if (!repo) return fail(404, "repoNotFound");

    const buffer = Buffer.from(await file.arrayBuffer());
    let content: string;
    try {
      content = await extractText(file.name, buffer);
    } catch (e) {
      return failRaw(415, errorMessage(e));
    }
    if (!content.trim()) {
      return fail(422, "fileEmptyAfterExtraction");
    }

    const chunkConfig = await getKnowledgeConfig(repoId);
    const result = await addKnowledgeDocument({
      repoId,
      name: file.name,
      content,
      sourceType: "upload",
      chunkSize: chunkConfig.chunkSize,
      chunkOverlap: chunkConfig.chunkOverlap,
    });
    return ok(result, result.status === "skipped" ? 200 : 201);
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
