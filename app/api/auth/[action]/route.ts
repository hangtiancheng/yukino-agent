import { prisma } from "@/lib/db";
import {
  accountView,
  consumeCode,
  createSession,
  destroySession,
  requireAccount,
  sendCode,
  sessionAccount,
  throttle,
  unreadReminder,
} from "@/lib/mailbox/auth";
import { hashPassword, verifyPassword } from "@/lib/mailbox/crypto";
import {
  assertSameOrigin,
  body,
  failure,
  json,
  MailboxError,
} from "@/lib/mailbox/http";
import {
  changeSchema,
  loginSchema,
  registerSchema,
  resetSchema,
  sendCodeSchema,
} from "@/lib/mailbox/schemas";

export const runtime = "nodejs";
type Context = { params: Promise<{ action: string }> };

export async function GET(_request: Request, { params }: Context) {
  try {
    if ((await params).action !== "session")
      throw new MailboxError(404, "页面不存在");
    const account = await sessionAccount();
    const unreadCount = account
      ? await prisma.complaintRecipient.count({
          where: { email: account.email, readAt: null },
        })
      : 0;
    return json({
      account: account ? accountView(account) : null,
      unreadCount,
    });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request, { params }: Context) {
  try {
    assertSameOrigin(request);
    const { action } = await params;
    await throttle("auth-global", "all", 300, 60);
    switch (action) {
      case "code": {
        const input = await body(request, sendCodeSchema);
        if (input.purpose === "change") {
          const account = await requireAccount();
          if (input.email !== account.email)
            throw new MailboxError(403, "只能验证当前账号的邮箱");
        }
        await sendCode(input.email, input.purpose);
        return json(null, "验证码已发送，10 分钟内有效");
      }
      case "register": {
        const input = await body(request, registerSchema);
        await throttle("register", input.email, 10, 900);
        await consumeCode(input.email, "register", input.code);
        if (
          await prisma.mailboxAccount.findUnique({
            where: { email: input.email },
          })
        )
          throw new MailboxError(409, "该邮箱已注册，请直接登录");
        const account = await prisma.mailboxAccount.create({
          data: {
            email: input.email,
            passwordHash: input.password
              ? await hashPassword(input.password)
              : null,
          },
        });
        await createSession(account);
        return json(
          { account: accountView(account), ...(await unreadReminder(account)) },
          "注册成功",
        );
      }
      case "login": {
        const input = await body(request, loginSchema);
        await throttle("login", input.email, 10, 900);
        const account = await prisma.mailboxAccount.findUnique({
          where: { email: input.email },
        });
        if (input.method === "code")
          await consumeCode(input.email, "login", input.code);
        else if (
          !(await verifyPassword(input.password, account?.passwordHash ?? null))
        ) {
          throw new MailboxError(
            401,
            "邮箱或密码不正确；未设置密码请使用验证码登录",
          );
        }
        if (!account) throw new MailboxError(401, "登录失败，请确认邮箱已注册");
        await createSession(account);
        return json(
          { account: accountView(account), ...(await unreadReminder(account)) },
          "登录成功",
        );
      }
      case "reset-password": {
        const input = await body(request, resetSchema);
        await throttle("password-reset", input.email, 10, 900);
        await consumeCode(input.email, "reset", input.code);
        const account = await prisma.mailboxAccount.findUnique({
          where: { email: input.email },
        });
        if (!account) throw new MailboxError(400, "该邮箱尚未注册");
        await prisma.$transaction(async (tx) => {
          await tx.mailboxAccount.update({
            where: { id: account.id },
            data: {
              passwordHash: await hashPassword(input.newPassword),
              authVersion: { increment: 1 },
            },
          });
          await tx.mailboxSession.deleteMany({
            where: { accountId: account.id },
          });
        });
        await destroySession();
        return json(null, "密码已重置，请使用新密码登录");
      }
      case "change-password": {
        const account = await requireAccount();
        const input = await body(request, changeSchema);
        if (input.email !== account.email)
          throw new MailboxError(403, "只能更新当前账号的密码");
        await throttle("password-change", account.id, 10, 900);
        if (input.method === "code")
          await consumeCode(input.email, "change", input.code);
        else if (
          !(await verifyPassword(input.oldPassword, account.passwordHash))
        )
          throw new MailboxError(
            400,
            "旧密码不正确；未设置密码请使用邮箱验证码",
          );
        const passwordHash = await hashPassword(input.newPassword);
        await prisma.$transaction(async (tx) => {
          const result = await tx.mailboxAccount.updateMany({
            where: { id: account.id, authVersion: account.authVersion },
            data: { passwordHash, authVersion: { increment: 1 } },
          });
          if (!result.count)
            throw new MailboxError(409, "账号验证状态已改变，请重新登录");
          await tx.mailboxSession.deleteMany({
            where: { accountId: account.id },
          });
        });
        await destroySession();
        return json(null, "密码已更新，请重新登录");
      }
      case "logout":
        await destroySession();
        return json(null, "已退出登录");
      default:
        throw new MailboxError(404, "页面不存在");
    }
  } catch (error) {
    return failure(error);
  }
}
