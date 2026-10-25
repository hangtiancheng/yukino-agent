import { generateWeeklyReport } from "@/lib/dev-flow/agents/report";
import { errorMessage, fail, failRaw, ok } from "@/lib/dev-flow/http";
import { WeeklyReportSchema } from "@/lib/dev-flow/schemas";

export { OPTIONS } from "@/lib/dev-flow/http";

export async function POST(request: Request) {
  try {
    const parsed = WeeklyReportSchema.safeParse(await request.json());
    if (!parsed.success) {
      return await fail(400, "invalidRequest", {
        detail: parsed.error.issues.map((i) => i.message).join(", "),
      });
    }
    const result = await generateWeeklyReport(parsed.data);
    return ok(result);
  } catch (e) {
    const message = errorMessage(e);
    return failRaw(message.includes("not found") ? 404 : 500, message);
  }
}
