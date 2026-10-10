import { createHmac, timingSafeEqual } from "crypto";
import { config } from "@/lib/config";
import { prisma } from "@/lib/db";
import { syncRepository } from "@/lib/devflow/sync";
import { errorMessage, fail, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

const SYNC_EVENTS = new Set([
  "issues",
  "pull_request",
  "workflow_run",
  "push",
  "check_suite",
  "check_run",
]);

function verifySignature(body: Buffer, signature: string | null): boolean {
  const secret = config.github.webhookSecret;
  if (!secret) return true;
  if (!signature || !signature.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const actual = signature.slice("sha256=".length);
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(actual, "utf8");
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

export async function POST(request: Request) {
  try {
    const raw = Buffer.from(await request.arrayBuffer());
    const signature = request.headers.get("x-hub-signature-256");
    if (!verifySignature(raw, signature)) {
      return fail(401, "invalidWebhookSignature");
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      return fail(400, "invalidJsonBody");
    }

    const repository = (
      payload as { repository?: { full_name?: unknown } } | null
    )?.repository;
    const fullName =
      repository && typeof repository.full_name === "string"
        ? repository.full_name
        : null;
    if (!fullName) {
      return ok({
        accepted: false,
        reason: "payload.repository.full_name is missing",
      });
    }

    const repo = await prisma.repository.findUnique({ where: { fullName } });
    if (!repo) {
      return ok({ accepted: false, reason: `${fullName} is not connected` });
    }

    const event = request.headers.get("x-github-event");
    if (event && SYNC_EVENTS.has(event)) {
      const limit = config.devflow.autoSync.limit;
      void syncRepository(repo.id, { limit }).catch((e) =>
        console.warn(
          `[devflow:webhook] sync failed for ${fullName}:`,
          e instanceof Error ? e.message : String(e),
        ),
      );
      return ok({
        accepted: true,
        event,
        repoId: repo.id,
        action: "sync_scheduled",
      });
    }

    return ok({ accepted: true, event, repoId: repo.id, action: "ignored" });
  } catch (e) {
    return failRaw(500, errorMessage(e));
  }
}
