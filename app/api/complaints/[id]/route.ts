import { requireAccount } from "@/lib/mailbox/auth";
import { complaintDetail, markRead } from "@/lib/mailbox/complaints";
import { assertSameOrigin, failure, json } from "@/lib/mailbox/http";

type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, { params }: Context) {
  try {
    return json(
      await complaintDetail((await params).id, await requireAccount()),
    );
  } catch (error) {
    return failure(error);
  }
}
export async function PATCH(request: Request, { params }: Context) {
  try {
    assertSameOrigin(request);
    await markRead((await params).id, await requireAccount());
    return json(null, "已标记为已读");
  } catch (error) {
    return failure(error);
  }
}
