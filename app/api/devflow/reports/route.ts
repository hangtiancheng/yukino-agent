// POST /api/devflow/reports — generate the weekly engineering report.
import { WeeklyReportSchema } from "@/lib/devflow/schemas";
import { generateWeeklyReport } from "@/lib/devflow/agents/report";
import { errorMessage, fail, ok } from "@/lib/devflow/http";

export { OPTIONS } from "@/lib/devflow/http";

export async function POST(request: Request) {
  try {
    const parsed = WeeklyReportSchema.safeParse(await request.json());
    if (!parsed.success) {
      return fail(
        400,
        `Invalid request: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
      );
    }
    const result = await generateWeeklyReport(parsed.data);
    return ok(result);
  } catch (e) {
    const message = errorMessage(e);
    return fail(message.includes("not found") ? 404 : 500, message);
  }
}
