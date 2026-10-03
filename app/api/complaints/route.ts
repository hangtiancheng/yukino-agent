import { z } from "zod/v4";
import { prisma } from "@/lib/db";
import { requireAccount, throttle } from "@/lib/mailbox/auth";
import { listComplaints } from "@/lib/mailbox/complaints";
import { assertSameOrigin, body, failure, json } from "@/lib/mailbox/http";
import { complaintSchema, paginationSchema } from "@/lib/mailbox/schemas";

export async function GET(request: Request) {
  try {
    const account = await requireAccount();
    const params = Object.fromEntries(new URL(request.url).searchParams);
    const { page } = paginationSchema.parse(params);
    const view = z.enum(["sent", "received"]).parse(params.view);
    return json(await listComplaints(account, view, page));
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const account = await requireAccount();
    const input = await body(request, complaintSchema);
    await throttle("complaint-create", account.id, 20, 3600);
    const complaint = await prisma.complaint.create({
      data: {
        authorId: account.id,
        anonymous: input.anonymous,
        subject: input.subject,
        body: input.body,
        recipients: { create: input.recipients.map((email) => ({ email })) },
      },
      select: { id: true },
    });
    return json(complaint, "投诉已提交", 201);
  } catch (error) {
    return failure(error);
  }
}
