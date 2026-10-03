import { prisma } from "@/lib/db";
import type { MailboxAccount, Prisma } from "@/generated/prisma/client";
import { MailboxError } from "./http";

const selection = {
  id: true,
  subject: true,
  body: true,
  anonymous: true,
  createdAt: true,
  authorId: true,
  author: { select: { email: true } },
  recipients: { select: { email: true, readAt: true } },
} satisfies Prisma.ComplaintSelect;

function visible(
  row: Prisma.ComplaintGetPayload<{ select: typeof selection }>,
  account: MailboxAccount,
) {
  return {
    id: row.id,
    subject: row.subject,
    body: row.body,
    anonymous: row.anonymous,
    authorEmail:
      row.anonymous && row.authorId !== account.id ? null : row.author.email,
    recipients: row.recipients.map((recipient) => recipient.email),
    createdAt: row.createdAt.toISOString(),
    readAt:
      row.recipients
        .find((recipient) => recipient.email === account.email)
        ?.readAt?.toISOString() ?? null,
  };
}
export async function listComplaints(
  account: MailboxAccount,
  view: "sent" | "received",
  page: number,
) {
  const where =
    view === "sent"
      ? { authorId: account.id }
      : { recipients: { some: { email: account.email } } };
  const [rows, total] = await prisma.$transaction([
    prisma.complaint.findMany({
      where,
      select: selection,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 20,
      skip: (page - 1) * 20,
    }),
    prisma.complaint.count({ where }),
  ]);
  // The list never includes message bodies; fetching a detail does not mark it read.
  return {
    items: rows.map((row) => {
      const { body, ...summary } = visible(row, account);
      void body;
      return summary;
    }),
    total,
    page,
  };
}
export async function complaintDetail(id: string, account: MailboxAccount) {
  const row = await prisma.complaint.findFirst({
    where: {
      id,
      OR: [
        { authorId: account.id },
        { recipients: { some: { email: account.email } } },
      ],
    },
    select: selection,
  });
  if (!row) throw new MailboxError(404, "邮件不存在或无权访问");
  return visible(row, account);
}
export async function markRead(id: string, account: MailboxAccount) {
  const result = await prisma.complaintRecipient.updateMany({
    where: { complaintId: id, email: account.email, readAt: null },
    data: { readAt: new Date() },
  });
  if (
    !result.count &&
    !(await prisma.complaintRecipient.findUnique({
      where: { complaintId_email: { complaintId: id, email: account.email } },
    }))
  ) {
    throw new MailboxError(404, "邮件不存在或无权访问");
  }
}

export async function publicComplaints(page: number) {
  // Explicit public projection: no body, authorId, or hidden anonymous identity.
  const [rows, total] = await prisma.$transaction([
    prisma.complaintRecipient.findMany({
      orderBy: [{ email: "asc" }, { complaintId: "desc" }],
      skip: (page - 1) * 20,
      take: 20,
      select: {
        email: true,
        complaint: {
          select: {
            id: true,
            subject: true,
            anonymous: true,
            createdAt: true,
            author: { select: { email: true } },
          },
        },
      },
    }),
    prisma.complaintRecipient.count(),
  ]);
  const grouped = new Map<
    string,
    {
      email: string;
      complaints: {
        id: string;
        subject: string;
        authorEmail: string | null;
        createdAt: string;
      }[];
    }
  >();
  for (const row of rows) {
    const group = grouped.get(row.email) ?? {
      email: row.email,
      complaints: [],
    };
    group.complaints.push({
      id: row.complaint.id,
      subject: row.complaint.subject,
      authorEmail: row.complaint.anonymous ? null : row.complaint.author.email,
      createdAt: row.complaint.createdAt.toISOString(),
    });
    grouped.set(row.email, group);
  }
  return { items: [...grouped.values()], total, page };
}
