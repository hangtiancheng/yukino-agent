"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Send, UserRoundX } from "lucide-react";
import { z } from "zod/v4";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { complaintSchema, type AccountView } from "@/lib/mailbox/schemas";
import { errorMessage, mailboxRequest, post } from "@/lib/mailbox/client";

export function ComposeComplaint({ account }: { account: AccountView }) {
  const router = useRouter();
  const [recipients, setRecipients] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [anonymous, setAnonymous] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const result = complaintSchema.safeParse({
      recipients: recipients.split(/[\s,;，；]+/).filter(Boolean),
      subject,
      body,
      anonymous,
    });
    if (!result.success) {
      setError(result.error.issues[0]?.message ?? "请检查填写内容");
      return;
    }
    setBusy(true);
    try {
      const data = await mailboxRequest(
        "/api/complaints",
        z.object({ id: z.string() }),
        post(result.data),
      );
      router.push(`/complaints/sent?selected=${encodeURIComponent(data.id)}`);
    } catch (error) {
      setError(errorMessage(error));
      setBusy(false);
    }
  }
  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-7">
        <p className="text-primary mb-2 text-xs font-semibold tracking-widest">
          写一封投诉
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          把事情说清楚。
        </h1>
        <p className="text-muted-foreground mt-3 text-sm leading-6">
          填写被投诉人的邮箱与具体经过，提交后可在「我投诉的」中查看。
        </p>
      </div>
      <form
        onSubmit={submit}
        className="bg-card overflow-hidden rounded-2xl border shadow-sm"
      >
        <fieldset disabled={busy}>
          <div className="space-y-5 border-b p-5 sm:p-7">
            <div className="text-muted-foreground text-sm">
              投诉人{" "}
              <span className="text-foreground ml-3 break-all">
                {anonymous ? "匿名投诉人" : account.email}
              </span>
            </div>
            <label className="block space-y-2 text-sm">
              <span>被投诉人邮箱</span>
              <Textarea
                className="min-h-20 resize-y"
                name="recipients"
                required
                maxLength={5200}
                value={recipients}
                onChange={(event) => setRecipients(event.target.value)}
                placeholder="person@example.com，another@example.com"
              />
              <span className="text-muted-foreground block text-xs">
                可填写多个邮箱，用逗号、分号或换行分隔，最多 20 个。
              </span>
            </label>
            <label className="block space-y-2 text-sm">
              <span>投诉邮件主题</span>
              <Input
                className="h-11"
                name="subject"
                required
                maxLength={200}
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
                placeholder="用一句话概括投诉事项"
              />
            </label>
          </div>
          <div className="space-y-3 p-5 sm:p-7">
            <label htmlFor="complaint-body" className="text-sm">
              投诉邮件正文
            </label>
            <Textarea
              id="complaint-body"
              className="min-h-64 resize-y leading-7"
              name="body"
              required
              maxLength={20000}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="请描述发生的事情、时间和具体影响…"
            />
            <p className="text-muted-foreground text-right font-mono text-xs">
              {body.length.toLocaleString()} / 20,000
            </p>
            <label className="bg-muted/50 flex cursor-pointer items-start gap-3 rounded-xl p-4">
              <input
                name="anonymous"
                type="checkbox"
                className="accent-primary mt-1 size-4"
                checked={anonymous}
                onChange={(event) => setAnonymous(event.target.checked)}
              />
              <span className="flex-1">
                <span className="flex items-center gap-2 text-sm font-medium">
                  <UserRoundX className="size-4" />
                  匿名投诉
                </span>
                <span className="text-muted-foreground mt-1 block text-xs leading-6">
                  隐藏你的邮箱，被投诉人和公开页面均显示「匿名投诉人」。你仍可在自己的信箱查看记录。
                </span>
              </span>
            </label>
            <p className="text-muted-foreground text-xs leading-6">
              提交后，被投诉人的邮箱、投诉主题及非匿名投诉人的邮箱会公开展示。正文仅向投诉人和对应被投诉人开放。
            </p>
            {error && (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            )}
            <div className="flex justify-end pt-2">
              <Button type="submit" className="h-11 px-6">
                <Send className="size-4" />
                {busy ? "正在提交…" : "提交投诉"}
              </Button>
            </div>
          </div>
        </fieldset>
      </form>
    </div>
  );
}
