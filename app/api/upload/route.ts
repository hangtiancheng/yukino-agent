// POST /api/upload — saves a .txt/.md/.markdown document into the knowledge
// base directory (config.fileDir) and indexes it into Milvus immediately, so
// it is retrievable without a server restart. Port of the legacy knowledge
// document upload (agent_py /knowledge-bases/{id}/documents), reduced to the
// public single-library design: no per-user KB, no background index task —
// startup re-indexing (indexDataDir) keeps the file durable across restarts.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getTranslations } from "next-intl/server";
import { config } from "@/lib/config";
import {
  buildKnowledgeIndex,
  isKnowledgeType,
  type KnowledgeType,
} from "@/lib/ai/pipelines/knowledge-index";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// Matches the client-side guard in hooks/use-chat.ts.
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
// Must match SUPPORTED_EXTENSIONS in knowledge-index.ts so an uploaded file
// is also re-indexed by the startup indexDataDir() pass. PDF/DOCX originals
// are stored as-is; text extraction happens inside buildKnowledgeIndex
// (unpdf/mammoth with the legacy size caps) so restarts re-index identically.
const SUPPORTED_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".pdf",
  ".docx",
]);
const BINARY_EXTENSIONS = new Set([".pdf", ".docx"]);

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

// The file name is user input and becomes a path inside FILE_DIR: reduce it to
// a basename and strip anything outside word chars, dots, hyphens and CJK, so
// no traversal or shell-hostile names can reach the filesystem. The (already
// allowlisted) extension is preserved verbatim.
function safeFileName(rawName: string): string {
  const base = path.basename(rawName.replaceAll("\\", "/"));
  const ext = path.extname(base).toLowerCase();
  const stem = base
    .slice(0, base.length - ext.length)
    .replace(/[^\w\-\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${stem === "" ? "document" : stem}${ext}`;
}

export async function POST(request: Request) {
  const t = await getTranslations("api.oncall");
  const fail = (status: number, message: string) =>
    Response.json({ message, data: null }, { status, headers: CORS_HEADERS });

  try {
    // A non-multipart body throws inside formData(); surface it as the same
    // 400 "no file uploaded" as a missing/invalid file field.
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return fail(400, t("noFileUploaded"));
    }
    const file = form.get("file");
    if (!(file instanceof File)) {
      return fail(400, t("noFileUploaded"));
    }
    // Optional client-side classification hint (legacy knowledgeType metadata);
    // anything outside the allowlist falls back to the indexer heuristics.
    const rawType = form.get("knowledgeType");
    const knowledgeType: KnowledgeType | undefined = isKnowledgeType(rawType)
      ? rawType
      : undefined;
    const ext = path.extname(file.name).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      return fail(400, t("unsupportedFileType", { name: file.name }));
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return fail(413, t("fileTooLarge"));
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    if (!BINARY_EXTENSIONS.has(ext)) {
      // Binary guard: a NUL byte or invalid UTF-8 would be indexed as garbage.
      // PDF/DOCX skip this — they are extracted by buildKnowledgeIndex.
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      } catch {
        return fail(415, t("notATextFile"));
      }
    }

    const dir = path.resolve(config.fileDir);
    await mkdir(dir, { recursive: true });
    const name = safeFileName(file.name);
    const target = path.join(dir, name);

    // Same name + identical content → skip the (paid) re-embedding; same name
    // + different content → overwrite and re-index. buildKnowledgeIndex
    // deletes the old chunks for this source first, so both are idempotent.
    let skipped = false;
    try {
      skipped = sha256(await readFile(target)) === sha256(buffer);
    } catch {
      // Target does not exist yet.
    }

    let chunks = 0;
    if (!skipped) {
      await writeFile(target, buffer);
      try {
        chunks = await buildKnowledgeIndex(target, knowledgeType);
      } catch (e) {
        // The file survives on disk and the next startup re-indexes it; the
        // caller still learns that retrieval is not ready yet.
        return fail(
          500,
          t("indexFailed", {
            error: e instanceof Error ? e.message : String(e),
          }),
        );
      }
    }

    return Response.json(
      { message: "OK", data: { name, chunks, skipped, knowledgeType } },
      { headers: CORS_HEADERS },
    );
  } catch (e) {
    console.error("[/api/upload] error:", e);
    return fail(500, t("internalError"));
  }
}
