"use client";
import { memo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslations } from "next-intl";
import type {
  ChatMessage,
  ChatReference,
  ChatToolCall,
} from "@/hooks/use-chat";
import type { KnowledgeType } from "@/lib/ai/pipelines/knowledge-index";
import type { A2uiClientAction } from "@a2ui/web_core/v0_9";
import { A2uiView } from "@/components/a2ui-view";
import MdRender from "./md-render";
import { ChevronDown, FileText, Sparkles, Wrench } from "lucide-react";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import {
  Message,
  MessageAvatar,
  MessageContent,
} from "@/components/ui/message";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

interface MessageListProps {
  messages: ChatMessage[];
  isStreaming: boolean;
  onA2uiAction: (messageIndex: number, action: A2uiClientAction) => void;
}

export default function MessageList({
  messages,
  isStreaming,
  onA2uiAction,
}: MessageListProps) {
  return (
    <MessageScrollerProvider autoScroll>
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport>
          <MessageScrollerContent className="px-6 py-4">
            {messages.map((m, i) => (
              <MessageScrollerItem
                key={i}
                scrollAnchor={i === messages.length - 1}
              >
                <motion.div
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{
                    y: { type: "spring", visualDuration: 0.4, bounce: 0.18 },
                    opacity: { duration: 0.25, ease: "easeOut" },
                  }}
                >
                  <MessageItem
                    message={m}
                    index={i}
                    streaming={
                      isStreaming &&
                      i === messages.length - 1 &&
                      m.type === "assistant"
                    }
                    onA2uiAction={onA2uiAction}
                  />
                </motion.div>
              </MessageScrollerItem>
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}

function DetailSteps({ detail }: { detail: string[] }) {
  const t = useTranslations("chat");
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="text-muted-foreground rounded-full"
          >
            <ChevronDown
              data-icon="inline-start"
              className={cn(
                "transition-transform duration-300",
                open && "rotate-180",
              )}
            />
            {t("viewDetails", { count: detail.length })}
          </Button>
        }
      />
      <AnimatePresence initial={false}>
        {open && (
          <CollapsibleContent
            render={
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{
                  height: { duration: 0.32, ease: [0.23, 1, 0.32, 1] },
                  opacity: { duration: 0.2, ease: "easeOut" },
                }}
                className="overflow-hidden"
              />
            }
          >
            <div className="flex flex-col gap-2 pt-2">
              {detail.map((d, idx) => (
                <div
                  key={idx}
                  className="bg-card border-primary/40 flex items-start gap-2 rounded-lg border-l-2 py-2 pr-3 pl-3 text-xs"
                >
                  <Badge variant="outline" className="mt-px shrink-0">
                    {t("step", { index: idx + 1 })}
                  </Badge>
                  <MdRender
                    content={d}
                    className="text-muted-foreground max-w-none min-w-0 flex-1 text-xs leading-relaxed wrap-break-word"
                  />
                </div>
              ))}
            </div>
          </CollapsibleContent>
        )}
      </AnimatePresence>
    </Collapsible>
  );
}

const KNOWLEDGE_TYPE_KEYS: Record<
  KnowledgeType,
  "sop" | "document" | "diagnosticCase"
> = {
  sop: "sop",
  document: "document",
  "diagnostic-case": "diagnosticCase",
};

function References({ references }: { references: ChatReference[] }) {
  const t = useTranslations("chat");
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="text-muted-foreground text-xs">{t("sources")}</span>
      {references.map((ref, i) => (
        <Badge
          key={`${ref.source}-${i}`}
          variant="secondary"
          className="max-w-64 gap-1 font-normal"
          title={`${ref.source} · score ${ref.score.toFixed(3)}\n\n${ref.excerpt}`}
        >
          <FileText className="size-3 shrink-0" />
          {ref.knowledgeType && (
            <span className="text-muted-foreground shrink-0 text-[10px] tracking-wide">
              {t(`knowledgeTypes.${KNOWLEDGE_TYPE_KEYS[ref.knowledgeType]}`)}
            </span>
          )}
          <span className="truncate">{ref.title}</span>
        </Badge>
      ))}
    </div>
  );
}

const TOOL_STATE_KEYS: Record<
  ChatToolCall["state"],
  "call" | "result" | "error"
> = {
  call: "call",
  result: "result",
  error: "error",
};

function ToolCallBadges({ toolCalls }: { toolCalls: ChatToolCall[] }) {
  const t = useTranslations("chat");
  return (
    <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
      {toolCalls.map((tc) => (
        <Badge
          key={tc.id}
          variant={tc.state === "error" ? "destructive" : "outline"}
          className="gap-1 font-normal"
        >
          {tc.state === "call" ? (
            <Spinner className="size-3 shrink-0" />
          ) : (
            <Wrench className="size-3 shrink-0" />
          )}
          <span className="max-w-40 truncate">{tc.name}</span>
          <span className={tc.state === "error" ? "" : "text-muted-foreground"}>
            {t(`toolStates.${TOOL_STATE_KEYS[tc.state]}`)}
          </span>
        </Badge>
      ))}
    </div>
  );
}

function ReasoningDetails({
  reasoning,
  streaming,
}: {
  reasoning: string;
  streaming: boolean;
}) {
  const t = useTranslations("chat");
  return (
    <details className="mb-1.5">
      <summary className="text-muted-foreground hover:text-foreground w-fit cursor-pointer list-none text-xs select-none">
        {t("reasoning")}
      </summary>
      <div className="border-border bg-card mt-1 max-h-60 overflow-y-auto rounded-md border-l-2 py-2 pr-3 pl-3">
        <MdRender
          content={reasoning}
          streaming={streaming}
          className="text-muted-foreground max-w-none min-w-0 text-xs leading-relaxed"
        />
      </div>
    </details>
  );
}

const MessageItem = memo(function MessageItem({
  message,
  index,
  streaming,
  onA2uiAction,
}: {
  message: ChatMessage;
  index: number;
  streaming: boolean;
  onA2uiAction: (messageIndex: number, action: A2uiClientAction) => void;
}) {
  const t = useTranslations("chat");
  if (message.type === "user") {
    return (
      <Message align="end">
        <Bubble align="end" variant="default" className="max-w-[75%]">
          <BubbleContent className="shadow-soft rounded-2xl rounded-br-sm whitespace-pre-wrap">
            {message.content}
          </BubbleContent>
        </Bubble>
      </Message>
    );
  }
  return (
    <Message>
      <MessageAvatar className="from-primary to-chart-4 text-primary-foreground shadow-soft ring-primary/20 size-8 self-start bg-linear-to-br ring-1">
        <Sparkles className="size-4" />
      </MessageAvatar>
      <MessageContent>
        {message.detail && message.detail.length > 0 && (
          <DetailSteps detail={message.detail} />
        )}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <ToolCallBadges toolCalls={message.toolCalls} />
        )}
        {message.reasoning && message.reasoning !== "" && (
          <ReasoningDetails
            reasoning={message.reasoning}
            streaming={streaming && message.content === ""}
          />
        )}
        {message.pending ? (
          <div className="text-muted-foreground flex items-center gap-2 py-1">
            <Spinner />
            <span className="text-sm">{t("thinking")}</span>
          </div>
        ) : (
          <MdRender content={message.content} streaming={streaming} />
        )}
        {message.references && message.references.length > 0 && (
          <References references={message.references} />
        )}
        {message.a2ui && message.a2ui.length > 0 && (
          <A2uiView
            messages={message.a2ui}
            onRawAction={(action) => onA2uiAction(index, action)}
          />
        )}
      </MessageContent>
    </Message>
  );
});
