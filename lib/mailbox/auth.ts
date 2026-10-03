import { randomBytes, randomInt } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import type { MailboxAccount } from "@/generated/prisma/client";
import { digestCode, digestToken } from "./crypto";
import { MailboxError } from "./http";
import { sendMail } from "./mail";
import type { CodePurpose } from "./schemas";

const COOKIE = "yukino_mailbox_session";
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const cookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  secure: config.account.secureCookies,
  path: "/",
} as const;
export const accountView = (account: MailboxAccount) => ({
  id: account.id,
  email: account.email,
  hasPassword: !!account.passwordHash,
});

export async function throttle(
  scope: string,
  identity: string,
  limit: number,
  seconds: number,
) {
  const bucket = Math.floor(Date.now() / (seconds * 1000));
  const key = digestToken(`${scope}:${identity}:${bucket}`);
  const row = await prisma.mailboxThrottle.upsert({
    where: { key },
    create: { key, expiresAt: new Date((bucket + 1) * seconds * 1000) },
    update: { count: { increment: 1 } },
  });
  if (row.count > limit)
    throw new MailboxError(429, "操作过于频繁，请稍后重试");
}

export async function sendCode(email: string, purpose: CodePurpose) {
  const code = randomInt(100000, 1000000).toString();
  const digest = digestCode(email, purpose, code);
  await throttle("code-global", "all", 100, 3600);
  await throttle("code-email", email, 5, 3600);
  // A conditional upsert under an advisory lock prevents concurrent re-sends.
  const issued = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`code:${email}`}, 0))::text`;
    const recent = await tx.mailboxCode.findFirst({
      where: { email, createdAt: { gt: new Date(Date.now() - 60000) } },
    });
    if (recent) throw new MailboxError(429, "请等待 60 秒后再发送验证码");
    return tx.mailboxCode.upsert({
      where: { email_purpose: { email, purpose } },
      create: {
        email,
        purpose,
        digest,
        expiresAt: new Date(Date.now() + 600000),
      },
      update: {
        digest,
        expiresAt: new Date(Date.now() + 600000),
        createdAt: new Date(),
        attempts: 0,
        consumedAt: null,
      },
    });
  });
  const names = {
    register: "注册",
    login: "登录",
    reset: "重置密码",
    change: "更新密码",
  };
  try {
    await sendMail(
      email,
      `Yukino ${names[purpose]}验证码`,
      `你的${names[purpose]}验证码是：${code}\n\n10 分钟内有效，仅能使用一次。请勿将验证码提供给他人。\n如果不是你本人操作，请忽略此邮件。`,
    );
  } catch (error) {
    await prisma.mailboxCode.deleteMany({ where: { id: issued.id, digest } });
    throw error;
  }
}

export async function consumeCode(
  email: string,
  purpose: CodePurpose,
  code: string,
) {
  const digest = digestCode(email, purpose, code);
  // Return false instead of throwing inside the transaction: failed attempts must commit.
  const valid = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`code:${email}`}, 0))::text`;
    const row = await tx.mailboxCode.findUnique({
      where: { email_purpose: { email, purpose } },
    });
    if (
      !row ||
      row.consumedAt ||
      row.expiresAt <= new Date() ||
      row.attempts >= 5
    )
      return false;
    const matches = row.digest === digest;
    await tx.mailboxCode.update({
      where: { id: row.id },
      data: {
        attempts: { increment: 1 },
        ...(matches ? { consumedAt: new Date() } : {}),
      },
    });
    return matches;
  });
  if (!valid)
    throw new MailboxError(400, "验证码错误、过期或已使用，请重新获取");
}

export async function sessionAccount() {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const session = await prisma.mailboxSession.findUnique({
    where: { tokenHash: digestToken(token) },
    include: { account: true },
  });
  if (
    !session ||
    session.expiresAt <= new Date() ||
    session.authVersion !== session.account.authVersion
  )
    return null;
  return session.account;
}
export async function requireAccount() {
  const account = await sessionAccount();
  if (!account) throw new MailboxError(401, "请先登录");
  return account;
}
export async function requirePageAccount(path: string) {
  const account = await sessionAccount();
  if (!account) redirect(`/login?next=${encodeURIComponent(path)}`);
  return accountView(account);
}
export async function createSession(account: MailboxAccount) {
  await destroySession();
  const token = randomBytes(32).toString("hex");
  await prisma.mailboxSession.create({
    data: {
      tokenHash: digestToken(token),
      accountId: account.id,
      authVersion: account.authVersion,
      expiresAt: new Date(Date.now() + SESSION_SECONDS * 1000),
    },
  });
  (await cookies()).set(COOKIE, token, {
    ...cookieOptions,
    maxAge: SESSION_SECONDS,
  });
  // Opportunistic cleanup of expired security records; not needed for correctness.
  await Promise.all([
    prisma.mailboxSession.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    }),
    prisma.mailboxThrottle.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    }),
    prisma.mailboxCode.deleteMany({ where: { expiresAt: { lt: new Date() } } }),
  ]).catch(() => {});
}
export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token)
    await prisma.mailboxSession.deleteMany({
      where: { tokenHash: digestToken(token) },
    });
  jar.set(COOKIE, "", { ...cookieOptions, maxAge: 0 });
}

export async function unreadReminder(account: MailboxAccount) {
  const unreadCount = await prisma.complaintRecipient.count({
    where: { email: account.email, readAt: null },
  });
  if (!unreadCount) return { unreadCount, reminder: "none" };
  const claimTime = new Date();
  const claimed = await prisma.mailboxAccount.updateMany({
    where: {
      id: account.id,
      OR: [
        { lastReminderAt: null },
        { lastReminderAt: { lt: new Date(Date.now() - 3600000) } },
      ],
    },
    data: { lastReminderAt: claimTime },
  });
  if (!claimed.count) return { unreadCount, reminder: "recently_sent" };
  try {
    await sendMail(
      account.email,
      `你有 ${unreadCount} 封未读投诉邮件`,
      `你的 Yukino 投诉信箱有 ${unreadCount} 封未读邮件。\n登录查看：${new URL("/complaints/received", config.account.appUrl).href}\n\n此提醒不包含投诉正文或投诉人身份。`,
    );
    return { unreadCount, reminder: "sent" };
  } catch {
    await prisma.mailboxAccount.updateMany({
      where: { id: account.id, lastReminderAt: claimTime },
      data: { lastReminderAt: null },
    });
    return { unreadCount, reminder: "failed" };
  }
}
