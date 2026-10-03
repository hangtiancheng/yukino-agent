"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Inbox,
  Mail,
  PenLine,
  Send,
  Users,
  KeyRound,
  LogOut,
} from "lucide-react";
import { z } from "zod/v4";
import { Button } from "@/components/ui/button";
import { accountViewSchema } from "@/lib/mailbox/schemas";
import { errorMessage, mailboxRequest, post } from "@/lib/mailbox/client";
import { cn } from "@/lib/utils";

const sessionSchema = z.object({
  account: accountViewSchema.nullable(),
  unreadCount: z.number(),
});
const navigation = [
  { href: "/complaints", label: "所有被投诉人", icon: Users },
  { href: "/complaints/new", label: "写投诉", icon: PenLine },
  { href: "/complaints/sent", label: "我投诉的", icon: Send },
  { href: "/complaints/received", label: "被投诉的", icon: Inbox },
];
export function MailboxShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [session, setSession] = useState<z.infer<typeof sessionSchema> | null>(
    null,
  );
  const [reloadKey, setReloadKey] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);
  useEffect(() => {
    const reload = () => setReloadKey((key) => key + 1);
    window.addEventListener("mailbox:changed", reload);
    window.addEventListener("focus", reload);
    return () => {
      window.removeEventListener("mailbox:changed", reload);
      window.removeEventListener("focus", reload);
    };
  }, []);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const data = await mailboxRequest("/api/auth/session", sessionSchema);
        if (active) {
          setSession(data);
          setError("");
        }
        if (
          active &&
          new URLSearchParams(window.location.search).get("reminder") ===
            "failed"
        )
          setNotice(
            "登录成功，但邮箱提醒发送失败。你仍可在「被投诉的」中查看未读邮件。",
          );
      } catch (error) {
        if (active) setError(errorMessage(error));
      }
    })();
    return () => {
      active = false;
    };
  }, [pathname, reloadKey]);
  async function logout() {
    setLoggingOut(true);
    try {
      await mailboxRequest("/api/auth/logout", z.null(), post({}));
      window.location.assign("/login");
    } catch (error) {
      setError(errorMessage(error));
      setLoggingOut(false);
    }
  }
  return (
    <div lang="zh-CN" className="bg-background text-foreground min-h-svh pb-28">
      <header className="bg-card border-b">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-5 sm:px-8">
          <Link
            href="/complaints"
            className="flex items-center gap-3 rounded-lg focus-visible:ring-2"
          >
            <span className="bg-primary text-primary-foreground flex size-10 items-center justify-center rounded-xl">
              <Mail className="size-5" />
            </span>
            <span>
              <span className="block text-lg font-semibold tracking-tight">
                投诉信箱
              </span>
              <span className="text-muted-foreground block font-mono text-[10px] tracking-[0.18em]">
                YUKINO MAILBOX
              </span>
            </span>
          </Link>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            {session?.account ? (
              <>
                <span
                  className="text-muted-foreground max-w-52 truncate"
                  title={session.account.email}
                >
                  {session.account.email}
                </span>
                <Link
                  href="/account/password"
                  className="hover:text-primary inline-flex items-center gap-1.5 rounded focus-visible:ring-2"
                >
                  <KeyRound className="size-4" />
                  更新密码
                </Link>
                <Button variant="ghost" onClick={logout} disabled={loggingOut}>
                  <LogOut />
                  退出
                </Button>
              </>
            ) : session ? (
              <>
                <Link
                  href="/login"
                  className="hover:text-primary rounded focus-visible:ring-2"
                >
                  登录
                </Link>
                <Link
                  href="/register"
                  className="bg-primary text-primary-foreground rounded-lg px-4 py-2 focus-visible:ring-2"
                >
                  注册账号
                </Link>
              </>
            ) : (
              <span className="text-muted-foreground text-xs">
                正在读取账号…
              </span>
            )}
          </div>
        </div>
      </header>
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <nav
          aria-label="投诉信箱"
          className="flex gap-1 overflow-x-auto border-b py-3"
        >
          {navigation.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              aria-current={pathname === href ? "page" : undefined}
              className={cn(
                "flex shrink-0 items-center gap-2 rounded-lg px-3 py-2.5 text-sm transition-colors focus-visible:ring-2",
                pathname === href
                  ? "bg-primary/10 text-primary font-semibold"
                  : "text-muted-foreground hover:bg-muted",
              )}
            >
              <Icon className="size-4" />
              {label}
              {href === "/complaints/received" && !!session?.unreadCount && (
                <span className="bg-primary text-primary-foreground rounded-full px-1.5 text-xs">
                  {session.unreadCount}
                </span>
              )}
            </Link>
          ))}
        </nav>
        {error && (
          <p role="alert" className="text-destructive mt-4 text-sm">
            {error}
            <button
              className="ml-3 underline"
              onClick={() => setReloadKey((key) => key + 1)}
            >
              重试
            </button>
          </p>
        )}
        {notice && (
          <p role="status" className="bg-muted mt-4 rounded-lg p-3 text-sm">
            {notice}
          </p>
        )}
        {!!session?.unreadCount && (
          <Link
            href="/complaints/received"
            className="bg-primary/5 text-primary mt-5 flex items-center gap-2 rounded-xl border px-4 py-3 text-sm"
          >
            <Inbox className="size-4" />
            你有 {session.unreadCount} 封未读投诉邮件，点击查看。
          </Link>
        )}
        <main className="py-8 sm:py-10">{children}</main>
      </div>
    </div>
  );
}
