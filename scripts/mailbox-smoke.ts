/**
 * Real HTTP + PostgreSQL + local SMTP regression suite.
 * See docs/mailbox.md. Refuses non-local services or a non-test database.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SMTPServer } from "smtp-server";
import { z } from "zod/v4";
import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { executeOncallSql } from "@/lib/ai/tools/postgres";
import { digestToken } from "@/lib/mailbox/crypto";
import {
  accountViewSchema,
  complaintViewSchema,
  publicRecipientSchema,
} from "@/lib/mailbox/schemas";

const origin = new URL(config.account.appUrl).origin;
const local = new Set(["localhost", "127.0.0.1", "[::1]"]);
const database = new URL(config.database.url);
assert.equal(
  process.env.MAILBOX_SMOKE,
  "1",
  "Set MAILBOX_SMOKE=1 for the isolated test environment",
);
assert(
  local.has(new URL(origin).hostname) &&
    local.has(database.hostname) &&
    local.has(config.smtp.host),
);
assert(
  database.pathname.endsWith("/mailbox_test"),
  "Use a dedicated database named mailbox_test",
);
assert(config.smtp.port > 1024 && !config.smtp.secure && !config.smtp.user);

const messages: { to: string[]; text: string }[] = [];
let rejectMail = false;
const smtp = new SMTPServer({
  authOptional: true,
  disabledCommands: ["STARTTLS"],
  onData(stream, session, done) {
    let raw = "";
    stream.on("data", (chunk: Buffer) => {
      raw += chunk.toString();
    });
    stream.on("end", () => {
      if (rejectMail) {
        done(new Error("Deliberate SMTP rejection"));
        return;
      }
      const body = raw.split("\r\n\r\n").slice(1).join("\r\n\r\n");
      const text = /Content-Transfer-Encoding: base64/i.test(
        raw.split("\r\n\r\n")[0],
      )
        ? Buffer.from(body, "base64").toString("utf8")
        : Buffer.from(
            body
              .replace(/=\r\n/g, "")
              .replace(/=([a-f0-9]{2})/gi, (_, hex: string) =>
                String.fromCharCode(Number.parseInt(hex, 16)),
              ),
            "binary",
          ).toString("utf8");
      messages.push({
        to: session.envelope.rcptTo.map((recipient) => recipient.address),
        text,
      });
      done();
    });
  },
});
await new Promise<void>((resolve, reject) => {
  smtp.on("error", reject);
  smtp.listen(config.smtp.port, "127.0.0.1", resolve);
});
const prefix = `smoke-${randomUUID().slice(0, 8)}`;
const emails = ["alice", "bob", "carol", "outsider", "locked", "late"].map(
  (name) => `${prefix}-${name}@example.test`,
);
const [
  aliceEmail,
  bobEmail,
  carolEmail,
  outsiderEmail,
  lockedEmail,
  lateEmail,
] = emails;
const password = "Mailbox-test-password-1";
const loginResult = z.object({
  account: accountViewSchema,
  unreadCount: z.number(),
  reminder: z.string(),
});
const sessionResult = z.object({
  account: accountViewSchema.nullable(),
  unreadCount: z.number(),
});
const listResult = z.object({
  items: z.array(complaintViewSchema),
  total: z.number(),
});
const envelope = z.object({ data: z.unknown(), message: z.string() });
let checks = 0;
class Client {
  cookie = "";
  async request(
    path: string,
    data?: unknown,
    status = 200,
    method = data === undefined ? "GET" : "POST",
    requestOrigin = origin,
  ) {
    const response = await fetch(new URL(path, origin), {
      method,
      headers: {
        Origin: requestOrigin,
        "Content-Type": "application/json",
        Cookie: this.cookie,
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const result = envelope.parse(await response.json());
    assert.equal(
      response.status,
      status,
      `${method} ${path}: ${result.message}`,
    );
    for (const cookie of response.headers.getSetCookie())
      if (cookie.startsWith("yukino_mailbox_session="))
        this.cookie = cookie.split(";")[0];
    if (path.endsWith("/login") && status === 200) {
      const header = response.headers.getSetCookie().at(-1) ?? "";
      assert.match(header, /HttpOnly/i);
      assert.match(header, /SameSite=Lax/i);
    }
    checks++;
    return result.data;
  }
}
const publicClient = new Client();
const alice = new Client();
const bob = new Client();
const carol = new Client();
const outsider = new Client();
async function code(email: string, purpose: string) {
  // Move only this fixture's issued timestamp to test multiple flows without sleeping.
  await prisma.mailboxCode.updateMany({
    where: { email },
    data: { createdAt: new Date(Date.now() - 61000) },
  });
  await publicClient.request("/api/auth/code", { email, purpose });
  const message = messages
    .filter((message) => message.to.includes(email))
    .at(-1);
  const code = message?.text.match(/\b\d{6}\b/)?.[0];
  assert(code, "SMTP must receive the actual verification code");
  assert(
    !JSON.stringify(
      await prisma.mailboxCode.findMany({ where: { email } }),
    ).includes(`"${code}"`),
    "Codes must not be stored in plaintext",
  );
  return code;
}
async function register(client: Client, email: string, withPassword = true) {
  const otp = await code(email, "register");
  const result = loginResult.parse(
    await client.request("/api/auth/register", {
      email,
      code: otp,
      password: withPassword ? password : "",
    }),
  );
  assert.equal(result.account.hasPassword, withPassword);
  return result;
}
try {
  // Public OnCall must not provide a SQL bypass around mailbox authorization.
  await assert.rejects(
    executeOncallSql('SELECT * FROM "Complaint"', "query", ""),
    /unavailable/,
  );
  await assert.rejects(
    executeOncallSql('SELECT * FROM "Complaint"', "query", config.database.url),
    /cannot reuse/,
  );
  const sqlFixture = `${prefix.replaceAll("-", "_")}_oncall`;
  const isolatedUrl = new URL(config.database.url);
  isolatedUrl.username = sqlFixture;
  isolatedUrl.password = "local-oncall-test-password";
  isolatedUrl.pathname = `/${sqlFixture}`;
  await prisma.$executeRawUnsafe(
    `CREATE ROLE "${sqlFixture}" LOGIN PASSWORD 'local-oncall-test-password'`,
  );
  try {
    await prisma.$executeRawUnsafe(
      `CREATE DATABASE "${sqlFixture}" OWNER "${sqlFixture}"`,
    );
    try {
      assert.deepEqual(
        await executeOncallSql("SELECT 42 AS value", "query", isolatedUrl.href),
        [{ value: 42 }],
      );
      await assert.rejects(
        executeOncallSql(
          'SELECT * FROM "Complaint"',
          "query",
          isolatedUrl.href,
        ),
        /does not exist/,
      );
      await assert.rejects(
        executeOncallSql("SELECT 1; SELECT 2", "query", isolatedUrl.href),
        /multiple commands/,
      );
      await prisma.$executeRawUnsafe(`ALTER ROLE "${sqlFixture}" CREATEROLE`);
      await assert.rejects(
        executeOncallSql("SELECT 1", "query", isolatedUrl.href),
        /non-administrative/,
      );
      await prisma.$executeRawUnsafe(`ALTER ROLE "${sqlFixture}" NOCREATEROLE`);
      await executeOncallSql(
        'CREATE TABLE "MailboxAccount" (id int)',
        "query",
        isolatedUrl.href,
      );
      await assert.rejects(
        executeOncallSql(
          'SELECT * FROM "MailboxAccount"',
          "query",
          isolatedUrl.href,
        ),
        /without mailbox tables/,
      );
    } finally {
      await prisma.$executeRawUnsafe(`DROP DATABASE "${sqlFixture}"`);
    }
  } finally {
    await prisma.$executeRawUnsafe(`DROP ROLE "${sqlFixture}"`);
  }
  await publicClient.request("/api/complaints?view=sent", undefined, 401);
  await publicClient.request(
    "/api/complaints",
    { recipients: [bobEmail], subject: "x", body: "y", anonymous: false },
    401,
  );
  await publicClient.request(
    "/api/auth/code",
    { email: aliceEmail, purpose: "register" },
    403,
    "POST",
    "https://untrusted.example",
  );
  await publicClient.request(
    "/api/auth/code",
    { email: "bad-address", purpose: "register" },
    400,
  );
  for (const path of [
    "/complaints/new",
    "/complaints/sent",
    "/complaints/received",
    "/account/password",
  ]) {
    const response = await fetch(new URL(path, origin), { redirect: "manual" });
    assert.equal(response.status, 307);
    assert.match(response.headers.get("location") ?? "", /^\/login\?next=/);
    checks++;
  }
  for (const path of [
    "/login",
    "/register",
    "/forgot-password",
    "/complaints",
    "/",
    "/devflow",
  ]) {
    assert.equal((await fetch(new URL(path, origin))).status, 200, path);
    checks++;
  }
  const lockedCode = await code(lockedEmail, "register");
  await publicClient.request(
    "/api/auth/code",
    { email: lockedEmail, purpose: "login" },
    429,
  );
  for (let i = 0; i < 5; i++)
    await publicClient.request(
      "/api/auth/register",
      { email: lockedEmail, code: "000000" },
      400,
    );
  await publicClient.request(
    "/api/auth/register",
    { email: lockedEmail, code: lockedCode },
    400,
  );
  const expiredCode = await code(outsiderEmail, "login");
  await prisma.mailboxCode.updateMany({
    where: { email: outsiderEmail },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  await publicClient.request(
    "/api/auth/login",
    { email: outsiderEmail, method: "code", code: expiredCode },
    400,
  );
  await register(alice, aliceEmail);
  await register(bob, bobEmail, false);
  await register(carol, carolEmail);
  await register(outsider, outsiderEmail);
  const concurrentCode = await code(outsiderEmail, "login");
  const concurrentStatuses = await Promise.all(
    [1, 2, 3].map(async () => {
      const response = await fetch(new URL("/api/auth/login", origin), {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({
          email: outsiderEmail,
          method: "code",
          code: concurrentCode,
        }),
      });
      return response.status;
    }),
  );
  assert.deepEqual(
    concurrentStatuses.sort(),
    [200, 400, 400],
    "Only one concurrent request may consume a code",
  );
  checks += 3;
  const create = z.object({ id: z.string() });
  const secretBody = `Private complaint body ${prefix} <script>alert('unsafe')</script>`;
  const first = create.parse(
    await alice.request(
      "/api/complaints",
      {
        recipients: [bobEmail, bobEmail.toUpperCase(), carolEmail, lateEmail],
        anonymous: true,
        subject: `匿名测试 ${prefix}`,
        body: secretBody,
      },
      201,
    ),
  );
  const publicData = await publicClient.request("/api/complaints/public");
  const serialized = JSON.stringify(publicData);
  assert(
    !serialized.includes(aliceEmail) &&
      !serialized.includes(secretBody) &&
      !serialized.includes("authorId") &&
      !serialized.includes('"body"'),
  );
  z.object({ items: z.array(publicRecipientSchema), total: z.number() }).parse(
    publicData,
  );
  assert.equal(
    await prisma.complaintRecipient.count({ where: { complaintId: first.id } }),
    3,
  );
  await outsider.request(`/api/complaints/${first.id}`, undefined, 404);
  await outsider.request(`/api/complaints/${first.id}`, {}, 404, "PATCH");
  await publicClient.request(`/api/complaints/${first.id}`, undefined, 401);
  const detail = complaintViewSchema.parse(
    await bob.request(`/api/complaints/${first.id}`),
  );
  assert.equal(detail.authorEmail, null);
  assert.equal(detail.body, secretBody);
  assert.equal(
    complaintViewSchema.parse(
      await alice.request(`/api/complaints/${first.id}`),
    ).authorEmail,
    aliceEmail,
  );
  assert.equal(
    sessionResult.parse(await bob.request("/api/auth/session")).unreadCount,
    1,
  );
  await bob.request(`/api/complaints/${first.id}`, {}, 200, "PATCH");
  assert.equal(
    sessionResult.parse(await bob.request("/api/auth/session")).unreadCount,
    0,
  );
  assert.equal(
    sessionResult.parse(await carol.request("/api/auth/session")).unreadCount,
    1,
  );
  const second = create.parse(
    await alice.request(
      "/api/complaints",
      {
        recipients: [bobEmail],
        anonymous: false,
        subject: `署名测试 ${prefix}`,
        body: "Another private body",
      },
      201,
    ),
  );
  assert(
    JSON.stringify(
      await publicClient.request("/api/complaints/public"),
    ).includes(aliceEmail),
  );
  assert.equal(
    listResult.parse(await bob.request("/api/complaints?view=received")).total,
    2,
  );
  const sent = listResult.parse(
    await alice.request("/api/complaints?view=sent"),
  );
  assert.equal(sent.total, 2);
  assert(sent.items.every((item) => item.body === undefined));
  await bob.request("/api/auth/logout", {});
  await bob.request(
    "/api/auth/login",
    { email: bobEmail, method: "password", password },
    401,
  );
  const bobCode = await code(bobEmail, "login");
  const login = loginResult.parse(
    await bob.request("/api/auth/login", {
      email: bobEmail,
      method: "code",
      code: bobCode,
    }),
  );
  assert.equal(login.unreadCount, 1);
  assert.equal(login.reminder, "sent");
  assert(
    messages.some(
      (message) =>
        message.to.includes(bobEmail) && message.text.includes("1 封未读"),
    ),
  );
  await publicClient.request(
    "/api/auth/login",
    { email: bobEmail, method: "code", code: bobCode },
    400,
  );
  const bobSession = bob.cookie;
  const resetCode = await code(bobEmail, "reset");
  await bob.request(
    "/api/auth/login",
    { email: bobEmail, method: "code", code: resetCode },
    400,
  );
  await publicClient.request("/api/auth/reset-password", {
    email: bobEmail,
    code: resetCode,
    newPassword: `${password}-reset`,
  });
  assert.equal(
    sessionResult.parse(await bob.request("/api/auth/session")).account,
    null,
  );
  await bob.request("/api/auth/login", {
    email: bobEmail,
    method: "password",
    password: `${password}-reset`,
  });
  assert.notEqual(bob.cookie, bobSession);
  await bob.request(
    "/api/auth/change-password",
    {
      email: aliceEmail,
      method: "password",
      oldPassword: password,
      newPassword: password,
    },
    403,
  );
  await bob.request(
    "/api/auth/change-password",
    {
      email: bobEmail,
      method: "password",
      oldPassword: password,
      newPassword: password,
    },
    400,
  );
  await bob.request("/api/auth/change-password", {
    email: bobEmail,
    method: "password",
    oldPassword: `${password}-reset`,
    newPassword: `${password}-changed`,
  });
  assert.equal(
    sessionResult.parse(await bob.request("/api/auth/session")).account,
    null,
  );
  await bob.request(
    "/api/auth/login",
    { email: bobEmail, method: "password", password: `${password}-reset` },
    401,
  );
  await bob.request("/api/auth/login", {
    email: bobEmail,
    method: "password",
    password: `${password}-changed`,
  });
  await prisma.mailboxCode.updateMany({
    where: { email: aliceEmail },
    data: { createdAt: new Date(Date.now() - 61000) },
  });
  await alice.request("/api/auth/code", {
    email: aliceEmail,
    purpose: "change",
  });
  const aliceChangeCode = messages
    .filter((message) => message.to.includes(aliceEmail))
    .at(-1)
    ?.text.match(/\b\d{6}\b/)?.[0];
  assert(aliceChangeCode);
  await alice.request("/api/auth/change-password", {
    email: aliceEmail,
    method: "code",
    code: aliceChangeCode,
    newPassword: `${password}-new`,
  });
  await alice.request(
    "/api/auth/login",
    { email: aliceEmail, method: "password", password },
    401,
  );
  await alice.request("/api/auth/login", {
    email: aliceEmail,
    method: "password",
    password: `${password}-new`,
  });
  // Account registered after receiving a complaint must discover that complaint.
  const late = new Client();
  const lateResult = await register(late, lateEmail, false);
  assert.equal(lateResult.unreadCount, 1);
  assert.equal(
    listResult.parse(await late.request("/api/complaints?view=received")).total,
    1,
  );
  // SMTP rejection must not turn a successful password login into an auth failure.
  rejectMail = true;
  await prisma.mailboxAccount.updateMany({
    where: { email: bobEmail },
    data: { lastReminderAt: null },
  });
  const degraded = loginResult.parse(
    await bob.request("/api/auth/login", {
      email: bobEmail,
      method: "password",
      password: `${password}-changed`,
    }),
  );
  assert.equal(degraded.reminder, "failed");
  assert.equal(degraded.unreadCount, 1);
  await publicClient.request(
    "/api/auth/code",
    { email: `${prefix}-failed@example.test`, purpose: "register" },
    503,
  );
  assert.equal(
    await prisma.mailboxCode.count({
      where: { email: `${prefix}-failed@example.test` },
    }),
    0,
  );
  rejectMail = false;
  const stale = new Client();
  stale.cookie = bob.cookie;
  await bob.request("/api/auth/logout", {});
  assert.equal(
    sessionResult.parse(await stale.request("/api/auth/session")).account,
    null,
  );
  // Expired sessions and rate limits are enforced server-side.
  await prisma.mailboxSession.updateMany({
    where: { tokenHash: digestToken(carol.cookie.split("=")[1]) },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  await carol.request("/api/complaints?view=received", undefined, 401);
  for (let i = 0; i < 10; i++)
    await publicClient.request(
      "/api/auth/login",
      { email: `${prefix}-missing@example.test`, method: "password", password },
      401,
    );
  await publicClient.request(
    "/api/auth/login",
    { email: `${prefix}-missing@example.test`, method: "password", password },
    429,
  );
  assert(second.id);
  await alice.request(
    "/api/complaints",
    { recipients: [], anonymous: false, subject: "Invalid", body: "Invalid" },
    400,
  );
  const aliceAccount = sessionResult.parse(
    await alice.request("/api/auth/session"),
  ).account;
  assert(aliceAccount);
  // Seed enough fixture rows to exercise both private and public pagination.
  for (let i = 0; i < 21; i++)
    await prisma.complaint.create({
      data: {
        authorId: aliceAccount.id,
        anonymous: true,
        subject: `Page fixture ${i}`,
        body: "Pagination private body",
        recipients: { create: [{ email: bobEmail }] },
      },
    });
  const pageOne = listResult.parse(
    await alice.request("/api/complaints?view=sent&page=1"),
  );
  const pageTwo = listResult.parse(
    await alice.request("/api/complaints?view=sent&page=2"),
  );
  assert.equal(pageOne.items.length, 20);
  assert.equal(pageTwo.items.length, 3);
  assert.equal(
    new Set([...pageOne.items, ...pageTwo.items].map((item) => item.id)).size,
    23,
  );
  const publicPage = z.object({
    items: z.array(publicRecipientSchema),
    total: z.number(),
  });
  const publicOne = publicPage.parse(
    await publicClient.request("/api/complaints/public?page=1"),
  );
  const publicTwo = publicPage.parse(
    await publicClient.request("/api/complaints/public?page=2"),
  );
  assert.equal(publicOne.items.flatMap((item) => item.complaints).length, 20);
  assert.equal(
    publicTwo.items.flatMap((item) => item.complaints).length,
    publicTwo.total - 20,
  );
  console.log(
    `Mailbox smoke passed: ${checks} HTTP/page checks, plus SMTP, privacy, persistence, and session assertions.`,
  );
} finally {
  await prisma.complaint.deleteMany({
    where: { author: { email: { in: emails } } },
  });
  await prisma.mailboxAccount.deleteMany({ where: { email: { in: emails } } });
  await prisma.mailboxCode.deleteMany({ where: { email: { in: emails } } });
  await prisma.$disconnect();
  await new Promise<void>((resolve) => smtp.close(resolve));
}
