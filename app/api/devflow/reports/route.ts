import { WeeklyReportSchema } from "@/lib/devflow/schemas";
import { generateWeeklyReport } from "@/lib/devflow/agents/report";
import { errorMessage, fail, failRaw, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

export async function POST(request: Request) {
  try {
    const parsed = WeeklyReportSchema.safeParse(await request.json());
    if (!parsed.success) {
      return fail(400, "invalidRequest", {
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
