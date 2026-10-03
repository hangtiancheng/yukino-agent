import { publicComplaints } from "@/lib/mailbox/complaints";
import { failure, json } from "@/lib/mailbox/http";
import { paginationSchema } from "@/lib/mailbox/schemas";
export async function GET(request: Request) {
  try {
    const { page } = paginationSchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    return json(await publicComplaints(page));
  } catch (error) {
    return failure(error);
  }
}
