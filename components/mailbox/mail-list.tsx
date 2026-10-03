"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Inbox, ArrowUpRight, X, MailOpen } from "lucide-react";
import { z } from "zod/v4";
import { Button } from "@/components/ui/button";
import {
  complaintViewSchema,
  publicRecipientSchema,
  type ComplaintView,
  type PublicRecipient,
} from "@/lib/mailbox/schemas";
import {
  displayDate,
  errorMessage,
  mailboxRequest,
} from "@/lib/mailbox/client";
import { cn } from "@/lib/utils";

export function Pagination({
  page,
  total,
  busy,
  change,
}: {
  page: number;
  total: number;
  busy: boolean;
  change: (page: number) => void;
}) {
  return (
    <div className="mt-5 flex flex-wrap items-center justify-between gap-3 text-sm">
      <span className="text-muted-foreground">
        第 {page} / {Math.max(1, Math.ceil(total / 20))} 页 · 共 {total} 条记录
      </span>
      <div className="flex gap-2">
        <Button
          variant="outline"
          disabled={busy || page <= 1}
          onClick={() => change(page - 1)}
        >
          上一页
        </Button>
        <Button
          variant="outline"
          disabled={busy || page * 20 >= total}
          onClick={() => change(page + 1)}
        >
          下一页
        </Button>
      </div>
    </div>
  );
}

export function MailList({ view }: { view: "sent" | "received" }) {
  const [items, setItems] = useState<ComplaintView[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ComplaintView | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    let active = true;
    void (async () => {
      setBusy(true);
      setError("");
      try {
        const result = await mailboxRequest(
          `/api/complaints?view=${view}&page=${page}`,
          z.object({ items: z.array(complaintViewSchema), total: z.number() }),
        );
        if (active) {
          setItems(result.items);
          setTotal(result.total);
        }
        const requested = new URLSearchParams(window.location.search).get(
          "selected",
        );
        if (active && requested && page === 1) setSelected(requested);
      } catch (error) {
        if (active) setError(errorMessage(error));
      } finally {
        if (active) setBusy(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [view, page, reloadKey]);
  useEffect(() => {
    if (!selected) return;
    let active = true;
    void (async () => {
      setDetailBusy(true);
      setDetail(null);
      setDetailError("");
      try {
        const result = await mailboxRequest(
          `/api/complaints/${encodeURIComponent(selected)}`,
          complaintViewSchema,
        );
        if (!active) return;
        setDetail(result);
        if (view === "received" && !result.readAt) {
          await mailboxRequest(
            `/api/complaints/${encodeURIComponent(selected)}`,
            z.null(),
            { method: "PATCH", body: "{}" },
          );
          window.dispatchEvent(new Event("mailbox:changed"));
          if (active)
            setItems((items) =>
              items.map((item) =>
                item.id === selected
                  ? { ...item, readAt: new Date().toISOString() }
                  : item,
              ),
            );
        }
      } catch (error) {
        if (active) setDetailError(errorMessage(error));
      } finally {
        if (active) setDetailBusy(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [selected, view, reloadKey]);
  return (
    <>
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-primary mb-2 text-xs font-semibold tracking-widest">
            {view === "sent" ? "发件记录" : "收件记录"}
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">
            {view === "sent" ? "我投诉的" : "被投诉的"}
          </h1>
          <p className="text-muted-foreground mt-3 text-sm">
            {view === "sent"
              ? "你提交过的每一封投诉邮件，都保存在这里。"
              : "发给你当前登录邮箱的投诉邮件。打开详情后标记为已读。"}
          </p>
        </div>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => setReloadKey((key) => key + 1)}
        >
          刷新邮件
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-destructive mb-4 text-sm">
          {error}
        </p>
      )}
      <div
        className={cn(
          "grid gap-5",
          selected && "lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]",
        )}
      >
        <section aria-label="邮件列表" className="min-w-0">
          <div
            className="bg-card overflow-hidden rounded-xl border"
            aria-busy={busy}
          >
            {busy ? (
              <p role="status" className="text-muted-foreground p-8 text-sm">
                正在读取邮件…
              </p>
            ) : !items.length ? (
              <div className="px-6 py-16 text-center">
                <Inbox
                  className="text-primary mx-auto mb-4 size-8"
                  strokeWidth={1.3}
                />
                <p className="font-medium">
                  {error ? "暂时无法读取邮件" : "这里还没有投诉邮件"}
                </p>
                <p className="text-muted-foreground mt-2 text-sm">
                  {view === "sent" ? (
                    <Link
                      href="/complaints/new"
                      className="underline underline-offset-4"
                    >
                      写第一封投诉
                    </Link>
                  ) : (
                    "发给你的投诉会显示在这里。"
                  )}
                </p>
              </div>
            ) : (
              items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={selected === item.id}
                  onClick={() => setSelected(item.id)}
                  className={cn(
                    "hover:bg-muted/50 flex w-full gap-3 border-b p-5 text-left last:border-b-0 focus-visible:ring-2 focus-visible:ring-inset",
                    selected === item.id && "bg-primary/5",
                  )}
                >
                  <span
                    className={cn(
                      "mt-2 size-2 shrink-0 rounded-full",
                      view === "received" && !item.readAt
                        ? "bg-primary"
                        : "bg-transparent",
                    )}
                    aria-label={
                      view === "received" && !item.readAt ? "未读" : undefined
                    }
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <h2 className="truncate text-sm font-semibold">
                        {item.subject}
                      </h2>
                      <ArrowUpRight className="text-muted-foreground size-4 shrink-0" />
                    </div>
                    <p className="text-muted-foreground mt-2 truncate text-xs">
                      {view === "sent"
                        ? `被投诉人：${item.recipients.join("、")}`
                        : `投诉人：${item.authorEmail ?? "匿名投诉人"}`}
                    </p>
                    <div className="text-muted-foreground mt-3 flex flex-wrap gap-3 text-xs">
                      <time dateTime={item.createdAt}>
                        {displayDate(item.createdAt)}
                      </time>
                      {item.anonymous && <span>匿名投诉</span>}
                      {view === "received" && (
                        <span>{item.readAt ? "已读" : "未读"}</span>
                      )}
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
          <Pagination
            page={page}
            total={total}
            busy={busy}
            change={(page) => {
              setPage(page);
              setSelected(null);
            }}
          />
        </section>
        {selected && (
          <section
            aria-label="邮件详情"
            className="bg-card min-w-0 self-start overflow-hidden rounded-xl border shadow-sm"
          >
            <div className="flex items-center justify-between border-b px-5 py-3">
              <span className="text-muted-foreground flex items-center gap-2 text-xs">
                <MailOpen className="size-4" />
                邮件详情
              </span>
              <Button
                variant="ghost"
                size="icon"
                aria-label="关闭邮件详情"
                onClick={() => setSelected(null)}
              >
                <X />
              </Button>
            </div>
            {detailBusy && (
              <p role="status" className="text-muted-foreground p-6 text-sm">
                正在读取详情…
              </p>
            )}
            {detailError && (
              <div role="alert" className="text-destructive p-5 text-sm">
                {detailError}
                <Button
                  variant="outline"
                  className="ml-3"
                  onClick={() => setReloadKey((key) => key + 1)}
                >
                  重试
                </Button>
              </div>
            )}
            {detail && (
              <article>
                <div className="space-y-3 border-b p-6">
                  <h2 className="text-xl leading-8 font-semibold break-words">
                    {detail.subject}
                  </h2>
                  <dl className="text-muted-foreground space-y-2 text-xs leading-6">
                    <div>
                      <dt className="inline">投诉人：</dt>
                      <dd className="text-foreground inline break-all">
                        {detail.authorEmail ?? "匿名投诉人"}
                        {detail.anonymous && detail.authorEmail
                          ? "（对外匿名）"
                          : ""}
                      </dd>
                    </div>
                    <div>
                      <dt className="inline">被投诉人：</dt>
                      <dd className="text-foreground inline break-all">
                        {detail.recipients.join("、")}
                      </dd>
                    </div>
                    <div>
                      <dt className="inline">提交时间：</dt>
                      <dd className="inline">
                        {displayDate(detail.createdAt)}
                      </dd>
                    </div>
                  </dl>
                </div>
                <div className="p-6 text-sm leading-8 break-words whitespace-pre-wrap">
                  {detail.body}
                </div>
              </article>
            )}
          </section>
        )}
      </div>
    </>
  );
}

export function PublicComplaints() {
  const [items, setItems] = useState<PublicRecipient[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    let active = true;
    void (async () => {
      setBusy(true);
      setError("");
      try {
        const result = await mailboxRequest(
          `/api/complaints/public?page=${page}`,
          z.object({
            items: z.array(publicRecipientSchema),
            total: z.number(),
          }),
        );
        if (active) {
          setItems(result.items);
          setTotal(result.total);
        }
      } catch (error) {
        if (active) setError(errorMessage(error));
      } finally {
        if (active) setBusy(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [page, reloadKey]);
  return (
    <>
      <div className="mb-8 flex flex-wrap items-end justify-between gap-5">
        <div>
          <p className="text-primary mb-2 text-xs font-semibold tracking-widest">
            公开记录
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">
            所有被投诉人
          </h1>
          <p className="text-muted-foreground mt-3 max-w-xl text-sm leading-7">
            查看被投诉人、非匿名投诉人及投诉邮件主题。此页面公开可见，不展示邮件正文；投诉内容为提交人的陈述。
          </p>
        </div>
        <Link
          href="/complaints/new"
          className="bg-primary text-primary-foreground inline-flex items-center gap-2 rounded-lg px-5 py-3 text-sm focus-visible:ring-2"
        >
          写投诉
          <ArrowUpRight className="size-4" />
        </Link>
      </div>
      {error && (
        <div role="alert" className="text-destructive mb-5 text-sm">
          {error}
          <Button
            variant="outline"
            className="ml-3"
            onClick={() => setReloadKey((key) => key + 1)}
          >
            重试
          </Button>
        </div>
      )}
      <div className="space-y-4" aria-busy={busy}>
        {busy ? (
          <p
            role="status"
            className="text-muted-foreground rounded-xl border p-10 text-sm"
          >
            正在读取公开记录…
          </p>
        ) : !items.length ? (
          <div className="bg-card rounded-xl border px-6 py-20 text-center">
            <Inbox
              className="text-primary mx-auto mb-4 size-9"
              strokeWidth={1.3}
            />
            <h2 className="font-medium">
              {error ? "暂时无法读取公开记录" : "暂无公开投诉记录"}
            </h2>
            <p className="text-muted-foreground mt-3 text-sm">
              投诉提交后，被投诉人的邮箱及邮件主题将展示在这里。
            </p>
          </div>
        ) : (
          items.map((item) => (
            <section
              key={item.email}
              className="bg-card overflow-hidden rounded-xl border"
            >
              <header className="bg-muted/40 flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-5 py-4">
                <span className="text-muted-foreground text-xs">被投诉人</span>
                <h2 className="font-mono text-sm font-medium break-all">
                  {item.email}
                </h2>
              </header>
              <div className="divide-y">
                {item.complaints.map((complaint) => (
                  <div
                    key={complaint.id}
                    className="grid gap-3 px-5 py-5 sm:grid-cols-[minmax(0,1fr)_minmax(0,0.7fr)]"
                  >
                    <div>
                      <h3 className="text-sm leading-6 font-medium break-words">
                        {complaint.subject}
                      </h3>
                      <time
                        className="text-muted-foreground mt-2 block text-xs"
                        dateTime={complaint.createdAt}
                      >
                        {displayDate(complaint.createdAt)}
                      </time>
                    </div>
                    <div className="text-muted-foreground text-xs leading-6">
                      <span className="block">投诉人</span>
                      <span className="text-foreground break-all">
                        {complaint.authorEmail ?? "匿名投诉人"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))
        )}
      </div>
      <Pagination page={page} total={total} busy={busy} change={setPage} />
    </>
  );
}
