"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, MailCheck, ShieldCheck } from "lucide-react";
import { z } from "zod/v4";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  accountViewSchema,
  emailSchema,
  type AccountView,
} from "@/lib/mailbox/schemas";
import { errorMessage, mailboxRequest, post } from "@/lib/mailbox/client";
import { cn } from "@/lib/utils";

type Mode = "login" | "register" | "reset" | "change";
const titles = {
  login: "登录你的信箱",
  register: "创建账号",
  reset: "忘记密码",
  change: "更新密码",
};
const subtitles = {
  login: "验证邮箱后，查看和管理与你有关的投诉。",
  register: "使用邮箱验证码注册，密码可以稍后设置。",
  reset: "验证邮箱后，为账号设置一个新密码。",
  change: "通过邮箱验证码或旧密码，验证你的身份。",
};
const loginResult = z.object({
  account: accountViewSchema,
  unreadCount: z.number(),
  reminder: z.string(),
});

export function AuthForm({
  mode,
  account,
}: {
  mode: Mode;
  account?: AccountView;
}) {
  const [email, setEmail] = useState(account?.email ?? "");
  const [method, setMethod] = useState<"code" | "password">("code");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [done, setDone] = useState(false);
  const usesCode = mode === "register" || mode === "reset" || method === "code";
  const setsPassword = mode !== "login";
  useEffect(() => {
    if (!cooldown) return;
    const timer = window.setTimeout(
      () => setCooldown((value) => value - 1),
      1000,
    );
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  async function send() {
    setError("");
    setNotice("");
    if (!emailSchema.safeParse(email).success) {
      setError("请先填写有效的邮箱地址");
      return;
    }
    setSending(true);
    try {
      await mailboxRequest(
        "/api/auth/code",
        z.null(),
        post({ email, purpose: mode }),
      );
      setCooldown(60);
      setNotice("验证码已发送，10 分钟内有效，请检查收件箱或垃圾邮件。");
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setSending(false);
    }
  }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    const desiredPassword = mode === "register" ? password : newPassword;
    if (
      setsPassword &&
      (mode !== "register" || desiredPassword) &&
      desiredPassword !== confirmation
    ) {
      setError("两次输入的密码不一致");
      return;
    }
    setBusy(true);
    try {
      if (mode === "login" || mode === "register") {
        const data = await mailboxRequest(
          `/api/auth/${mode}`,
          loginResult,
          post(
            mode === "register"
              ? { email, code, password }
              : method === "code"
                ? { email, method, code }
                : { email, method, password },
          ),
        );
        const next =
          new URLSearchParams(window.location.search).get("next") ??
          "/complaints/received";
        const destination =
          /^\/(complaints(?:[/?]|$)|account\/password(?:[?]|$))/.test(next) &&
          !next.includes("\\")
            ? next
            : "/complaints/received";
        const url = new URL(destination, window.location.origin);
        if (data.reminder === "failed")
          url.searchParams.set("reminder", "failed");
        window.location.assign(url.href);
      } else {
        await mailboxRequest(
          `/api/auth/${mode === "reset" ? "reset-password" : "change-password"}`,
          z.null(),
          post({ email, code, method, newPassword, oldPassword: password }),
        );
        setDone(true);
        setNotice("密码已更新，旧登录会话已失效。请重新登录。");
      }
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mx-auto grid max-w-4xl overflow-hidden rounded-2xl border shadow-sm md:grid-cols-[0.8fr_1fr]">
      <aside className="bg-primary/5 flex flex-col justify-between gap-10 border-b p-7 md:border-r md:border-b-0 md:p-9">
        <div>
          <MailCheck className="text-primary mb-6 size-9" strokeWidth={1.4} />
          <p className="text-primary mb-3 text-xs font-semibold tracking-widest">
            一封邮件，一份记录
          </p>
          <h1 className="text-3xl leading-tight font-semibold tracking-tight">
            {titles[mode]}
          </h1>
          <p className="text-muted-foreground mt-4 text-sm leading-7">
            {subtitles[mode]}
          </p>
        </div>
        <div className="text-muted-foreground flex gap-2 text-xs leading-6">
          <ShieldCheck className="mt-1 size-4 shrink-0" />
          <p>
            投诉正文仅向投诉人和对应被投诉人开放。所有被投诉人页面公开邮箱及投诉主题。
          </p>
        </div>
      </aside>
      <form onSubmit={submit} className="bg-card p-7 md:p-9">
        {done ? (
          <div className="space-y-5 py-10">
            <p role="status" className="text-primary leading-7">
              {notice}
            </p>
            <Link
              href="/login"
              className="bg-primary text-primary-foreground inline-flex rounded-lg px-5 py-2.5"
            >
              前往登录
            </Link>
          </div>
        ) : (
          <fieldset
            disabled={busy || sending}
            className="space-y-5 disabled:opacity-70"
          >
            {(mode === "login" ||
              (mode === "change" && account?.hasPassword)) && (
              <div
                className="bg-muted grid grid-cols-2 rounded-lg p-1"
                aria-label="验证方式"
              >
                {(["code", "password"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={method === value}
                    onClick={() => {
                      setMethod(value);
                      setError("");
                    }}
                    className={cn(
                      "rounded-md px-3 py-2 text-sm focus-visible:ring-2",
                      method === value
                        ? "bg-card font-medium shadow-sm"
                        : "text-muted-foreground",
                    )}
                  >
                    {value === "code"
                      ? "邮箱验证码"
                      : mode === "change"
                        ? "旧密码"
                        : "密码登录"}
                  </button>
                ))}
              </div>
            )}
            <label className="block space-y-2 text-sm">
              <span>邮箱地址</span>
              <Input
                className="h-11"
                name="email"
                type="email"
                autoComplete="email"
                required
                maxLength={254}
                readOnly={mode === "change"}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
              />
            </label>
            {usesCode && (
              <div className="space-y-2">
                <label htmlFor="email-code" className="text-sm">
                  邮箱验证码
                </label>
                <div className="flex gap-2">
                  <Input
                    id="email-code"
                    className="h-11 font-mono tracking-widest"
                    name="code"
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    required
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    placeholder="6 位验证码"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11"
                    disabled={cooldown > 0}
                    onClick={send}
                  >
                    {sending
                      ? "发送中…"
                      : cooldown > 0
                        ? `${cooldown} 秒后重发`
                        : "发送验证码"}
                  </Button>
                </div>
              </div>
            )}
            {((!usesCode && (mode === "login" || mode === "change")) ||
              mode === "register") && (
              <label className="block space-y-2 text-sm">
                <span>
                  {mode === "register"
                    ? "密码（可选）"
                    : mode === "change"
                      ? "旧密码"
                      : "密码"}
                </span>
                <Input
                  className="h-11"
                  name="password"
                  type="password"
                  autoComplete={
                    mode === "register" ? "new-password" : "current-password"
                  }
                  required={mode !== "register"}
                  minLength={mode === "register" ? 8 : undefined}
                  maxLength={128}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder={
                    mode === "register" ? "至少 8 位，也可留空" : "请输入密码"
                  }
                />
              </label>
            )}
            {(mode === "reset" || mode === "change") && (
              <label className="block space-y-2 text-sm">
                <span>新密码</span>
                <Input
                  className="h-11"
                  name="newPassword"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  maxLength={128}
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  placeholder="8–128 位"
                />
              </label>
            )}
            {setsPassword && (mode !== "register" || password.length > 0) && (
              <label className="block space-y-2 text-sm">
                <span>确认密码</span>
                <Input
                  className="h-11"
                  name="confirmation"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  maxLength={128}
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  placeholder="再次输入密码"
                />
              </label>
            )}
            {(mode === "login" ||
              mode === "register" ||
              (mode === "change" && !account?.hasPassword)) && (
              <p className="text-muted-foreground text-xs leading-5">
                未设置密码的账号只能使用邮箱验证码登录。
              </p>
            )}
            {error && (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            )}
            {notice && (
              <p role="status" className="text-primary text-sm leading-6">
                {notice}
              </p>
            )}
            <Button type="submit" className="h-11 w-full">
              {busy
                ? "正在处理…"
                : mode === "login"
                  ? "登录"
                  : mode === "register"
                    ? "注册并登录"
                    : "保存新密码"}
              <ArrowRight className="size-4" />
            </Button>
            <div className="text-muted-foreground flex justify-between gap-3 text-sm">
              {mode === "login" ? (
                <>
                  <Link
                    className="hover:text-primary underline underline-offset-4"
                    href="/register"
                  >
                    注册账号
                  </Link>
                  <Link
                    className="hover:text-primary underline underline-offset-4"
                    href="/forgot-password"
                  >
                    忘记密码？
                  </Link>
                </>
              ) : (
                <Link
                  className="hover:text-primary underline underline-offset-4"
                  href="/login"
                >
                  返回登录
                </Link>
              )}
            </div>
          </fieldset>
        )}
      </form>
    </div>
  );
}
