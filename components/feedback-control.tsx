"use client";
import { useCallback, useEffect, useState } from "react";
import {
  Check,
  MessageSquareText,
  ThumbsDown,
  ThumbsUp,
  X,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type FeedbackTargetType =
  "chat_message" | "citation" | "diagnostic_step" | "diagnostic_report";
type FeedbackRating = "positive" | "negative";

interface FeedbackRecord {
  id: string;
  subjectId: string;
  rating: FeedbackRating;
  reason: string | null;
  comment: string | null;
  correction: string | null;
}

const listResponseSchema = {
  parse: async (resp: Response): Promise<FeedbackRecord[]> => {
    const json = (await resp.json()) as {
      message: string;
      data?: { items?: FeedbackRecord[] };
    };
    return json.data?.items ?? [];
  },
};

interface FeedbackControlProps {
  targetType: FeedbackTargetType;
  targetId: string;
  subjectId?: string;
  sessionId?: string;
  compact?: boolean;
}

export default function FeedbackControl({
  targetType,
  targetId,
  subjectId,
  sessionId,
  compact = false,
}: FeedbackControlProps) {
  const t = useTranslations("chat.feedback");
  const [current, setCurrent] = useState<FeedbackRecord | null>(null);
  const [pending, setPending] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [reason, setReason] = useState("");
  const [comment, setComment] = useState("");
  const [correction, setCorrection] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const params = new URLSearchParams({ targetType, targetId });
        const resp = await fetch(`/api/feedback?${params.toString()}`);
        const items = await listResponseSchema.parse(resp);
        if (cancelled) return;
        const wantedSubject = subjectId ?? "";
        const record =
          items.find((item) => item.subjectId === wantedSubject) ?? null;
        setCurrent(record);
        if (record) {
          setReason(record.reason ?? "");
          setComment(record.comment ?? "");
          setCorrection(record.correction ?? "");
        }
      } catch {
        if (!cancelled) setCurrent(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [targetType, targetId, subjectId]);

  const upsert = useCallback(
    async (rating: FeedbackRating) => {
      setPending(true);
      try {
        const resp = await fetch("/api/feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            targetType,
            targetId,
            ...(subjectId !== undefined ? { subjectId } : {}),
            ...(sessionId !== undefined ? { sessionId } : {}),
            rating,
            ...(reason.trim() !== "" ? { reason: reason.trim() } : {}),
            ...(comment.trim() !== "" ? { comment: comment.trim() } : {}),
            ...(correction.trim() !== ""
              ? { correction: correction.trim() }
              : {}),
          }),
        });
        const json = (await resp.json()) as {
          message: string;
          data?: FeedbackRecord;
        };
        if (json.message === "OK" && json.data) {
          setCurrent(json.data);
          if (rating === "negative") setExpanded(true);
        }
      } catch {
        // feedback is best-effort; never block the chat
      } finally {
        setPending(false);
      }
    },
    [targetType, targetId, subjectId, sessionId, reason, comment, correction],
  );

  const remove = useCallback(async () => {
    if (current === null) return;
    setPending(true);
    try {
      await fetch(`/api/feedback/${current.id}`, { method: "DELETE" });
      setCurrent(null);
      setExpanded(false);
      setReason("");
      setComment("");
      setCorrection("");
    } catch {
      // ignore
    } finally {
      setPending(false);
    }
  }, [current]);

  const saveDetails = useCallback(async () => {
    if (current === null) return;
    await upsert(current.rating);
    setExpanded(false);
  }, [current, upsert]);

  const iconSize = compact ? "size-3" : "size-3.5";

  return (
    <div className="mt-1 flex flex-col gap-1.5">
      <div className="flex items-center gap-0.5">
        <Button
          size="icon"
          variant="ghost"
          className={cn(
            "size-6 rounded-md",
            current?.rating === "positive" &&
              "text-primary bg-primary/10 hover:text-primary",
          )}
          title={t("helpful")}
          aria-pressed={current?.rating === "positive"}
          disabled={pending}
          onClick={() => void upsert("positive")}
        >
          <ThumbsUp className={iconSize} />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className={cn(
            "size-6 rounded-md",
            current?.rating === "negative" &&
              "text-destructive bg-destructive/10 hover:text-destructive",
          )}
          title={t("needsImprovement")}
          aria-pressed={current?.rating === "negative"}
          disabled={pending}
          onClick={() => void upsert("negative")}
        >
          <ThumbsDown className={iconSize} />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-6 rounded-md"
          title={t("details")}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          <MessageSquareText className={iconSize} />
        </Button>
        {current !== null && (
          <Button
            size="icon"
            variant="ghost"
            className="text-muted-foreground size-6 rounded-md"
            title={t("remove")}
            disabled={pending}
            onClick={() => void remove()}
          >
            <X className={iconSize} />
          </Button>
        )}
      </div>
      {expanded && (
        <div className="bg-card border-border flex max-w-md flex-col gap-1.5 rounded-lg border p-2">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value.slice(0, 80))}
            placeholder={t("reasonPlaceholder")}
            className="border-border bg-background placeholder:text-muted-foreground rounded-md border px-2 py-1 text-xs outline-none"
          />
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value.slice(0, 2000))}
            placeholder={t("commentPlaceholder")}
            rows={2}
            className="border-border bg-background placeholder:text-muted-foreground resize-y rounded-md border px-2 py-1 text-xs outline-none"
          />
          <textarea
            value={correction}
            onChange={(e) => setCorrection(e.target.value.slice(0, 4000))}
            placeholder={t("correctionPlaceholder")}
            rows={2}
            className="border-border bg-background placeholder:text-muted-foreground resize-y rounded-md border px-2 py-1 text-xs outline-none"
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="outline"
              className="h-6 gap-1 rounded-md px-2 text-xs"
              disabled={pending || current === null}
              onClick={() => void saveDetails()}
            >
              <Check className="size-3" />
              {t("save")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
