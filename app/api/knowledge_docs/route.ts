// GET /api/knowledge_docs — OnCall knowledge-base document management list
// (port of the legacy agent_py knowledge documents API, reduced to the
// single public library: FILE_DIR is the document store, Milvus the index).
// Reads are public; mutations live on the [name] routes behind the admin
// token. Per-file chunk counts come from a Milvus count filter so a stale
// index (file present, vectors missing) is visible.
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { getTranslations } from "next-intl/server";
import { config } from "@/lib/config";
import { count as milvusCount, quote } from "@/lib/milvus/client";
import { classifyKnowledgeType } from "@/lib/ai/pipelines/knowledge-index";
import { readFile } from "node:fs/promises";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const SUPPORTED_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".pdf",
  ".docx",
]);

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET() {
  const t = await getTranslations("api.oncall");
  try {
    const dir = path.resolve(config.fileDir);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return Response.json(
        { message: "OK", data: { items: [] } },
        { headers: CORS_HEADERS },
      );
    }
    const files = entries.filter((name) =>
      SUPPORTED_EXTENSIONS.has(path.extname(name).toLowerCase()),
    );
    const items = await Promise.all(
      files.slice(0, 500).map(async (name) => {
        const full = path.join(dir, name);
        const info = await stat(full).catch(() => null);
        // classification uses a bounded head sample; full text is unnecessary
        const head = await readFile(full, "utf8")
          .then((s) => s.slice(0, 4000))
          .catch(() => "");
        const chunks = await milvusCount(`source == ${quote(name)}`).catch(
          () => null,
        );
        return {
          name,
          bytes: info?.size ?? 0,
          updatedAt: info?.mtime.toISOString() ?? null,
          knowledgeType: classifyKnowledgeType(name, head),
          chunks,
        };
      }),
    );
    items.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    return Response.json(
      { message: "OK", data: { items } },
      { headers: CORS_HEADERS },
    );
  } catch (e) {
    console.error("[/api/knowledge_docs] error:", e);
    return Response.json(
      { message: t("internalError"), data: null },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
