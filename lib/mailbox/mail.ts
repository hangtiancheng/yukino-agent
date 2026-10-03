import nodemailer from "nodemailer";
import { config } from "@/lib/config";
import { MailboxError } from "./http";

export async function sendMail(to: string, subject: string, text: string) {
  if (!config.smtp.host || !config.smtp.from) {
    throw new MailboxError(503, "邮件服务尚未配置，请联系管理员");
  }
  const transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    // STARTTLS is mandatory in production when not using implicit TLS.
    requireTLS: config.account.secureCookies && !config.smtp.secure,
    ...(config.smtp.user
      ? { auth: { user: config.smtp.user, pass: config.smtp.password } }
      : {}),
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
  try {
    const result = await transport.sendMail({
      from: config.smtp.from,
      to,
      subject,
      text,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    if (result.rejected.length) throw new Error("Recipient rejected");
  } catch {
    throw new MailboxError(503, "邮件发送失败，请稍后重试");
  } finally {
    transport.close();
  }
}
