// /api/knowledge_docs/[name] — OnCall knowledge-base document operations
// (legacy knowledge documents API): GET = chunk preview (first 12 chunks,
// computed on the fly without touching Milvus), POST = re-index, DELETE =
// remove the file + its vectors. Mutations require ONCALL_ADMIN_TOKEN
// (fail-closed) because the surface is public.
import { unlink } from "node:fs/promises";
import path from "node:path";
import { getTranslations } from "next-intl/server";
import { config } from "@/lib/config";
import { requireOncallAdmin } from "@/lib/ai/admin";
import { quote } from "@/lib/milvus/client";
import { deleteByExpr } from "@/lib/milvus/client";
import {
  buildKnowledgeIndex,
  previewChunks,
} from "@/lib/ai/pipelines/knowledge-index";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-admin-token",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

type Ctx = { params: Promise<{ name: string }> };

// Resolve an untrusted document name to a path strictly inside FILE_DIR.
function resolveDoc(name: string): string | null {
  const dir = path.resolve(config.fileDir);
  const base = path.basename(name.replaceAll("\\", "/"));
  if (base === "" || base !== name) return null;
  const full = path.resolve(dir, base);
  if (!full.startsWith(dir + path.sep)) return null;
  return full;
}

async function fail(status: number, message: string) {
  return Response.json(
    { message, data: null },
    { status, headers: CORS_HEADERS },
  );
}

export async function GET(_request: Request, ctx: Ctx) {
  const t = await getTranslations("api.oncall");
  const { name } = await ctx.params;
  const full = resolveDoc(name);
  if (full === null) return fail(400, t("invalidRequest"));
  try {
    const preview = await previewChunks(full);
    return Response.json(
      { message: "OK", data: { name, ...preview } },
      { headers: CORS_HEADERS },
    );
  } catch {
    return fail(404, t("docNotFound"));
  }
}

export async function POST(request: Request, ctx: Ctx) {
  const t = await getTranslations("api.oncall");
  const admin = requireOncallAdmin(request);
  if (admin) {
    return fail(
      admin === "not_configured" ? 403 : 401,
      t(
        admin === "not_configured" ? "adminNotConfigured" : "adminUnauthorized",
      ),
    );
  }
  const { name } = await ctx.params;
  const full = resolveDoc(name);
  if (full === null) return fail(400, t("invalidRequest"));
  try {
    const chunks = await buildKnowledgeIndex(full);
    return Response.json(
      { message: "OK", data: { name, chunks } },
      { headers: CORS_HEADERS },
    );
  } catch (e) {
    return fail(
      500,
      t("indexFailed", { error: e instanceof Error ? e.message : String(e) }),
    );
  }
}

export async function DELETE(request: Request, ctx: Ctx) {
  const t = await getTranslations("api.oncall");
  const admin = requireOncallAdmin(request);
  if (admin) {
    return fail(
      admin === "not_configured" ? 403 : 401,
      t(
        admin === "not_configured" ? "adminNotConfigured" : "adminUnauthorized",
      ),
    );
  }
  const { name } = await ctx.params;
  const full = resolveDoc(name);
  if (full === null) return fail(400, t("invalidRequest"));
  try {
    await unlink(full);
  } catch {
    return fail(404, t("docNotFound"));
  }
  // Best-effort vector cleanup: Milvus may be down; the next startup index
  // will not resurrect a deleted file anyway.
  await deleteByExpr(`source == ${quote(name)}`).catch(() => undefined);
  return Response.json(
    { message: "OK", data: { deleted: name } },
    { headers: CORS_HEADERS },
  );
}
