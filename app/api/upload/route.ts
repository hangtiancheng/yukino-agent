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

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
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

    let skipped = false;
    try {
      skipped = sha256(await readFile(target)) === sha256(buffer);
    } catch {}

    let chunks = 0;
    if (!skipped) {
      await writeFile(target, buffer);
      try {
        chunks = await buildKnowledgeIndex(target, knowledgeType);
      } catch (e) {
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
