import { z } from "zod/v4";
import { prisma } from "@/lib/db";
import { addMemoryNote } from "@/lib/devflow/rag";
import { errorMessage, fail, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

const NoteSchema = z.object({
  repoId: z.string().min(1),
  title: z.string().max(300).default(""),
  content: z.string().max(20_000).default(""),
});

export async function POST(request: Request) {
  try {
    const parsed = NoteSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return fail(400, "invalidRequest", {
        detail: parsed.error.issues.map((i) => i.message).join(", "),
      });
    }
    const repo = await prisma.repository.findUnique({
      where: { id: parsed.data.repoId },
    });
    if (!repo) return fail(404, "repoNotFound");
    const result = await addMemoryNote(parsed.data);
    return ok(result, result.status === "skipped" ? 200 : 201);
  } catch (e) {
    const message = errorMessage(e);
    return failRaw(message.includes("must be provided") ? 400 : 500, message);
  }
}
