"use client";
import { memo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { ChatMessage } from "@/hooks/use-chat";
import type { A2uiClientAction } from "@a2ui/web_core/v0_9";
import { A2uiView } from "@/components/a2ui-view";
import MdRender from "./md-render";
import { ChevronDown, Sparkles } from "lucide-react";
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
  /** Receives raw A2UI surface actions to resolve into in-place surface updates. */
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
            View details ({detail.length} steps)
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
                    Step {idx + 1}
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

// P1-6 fix: wrap MessageItem in memo so streaming chunks (which only change
// the last message) don't re-render every message in the list.
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
  if (message.type === "user") {
    return (
      <Message align="end">
        <Bubble align="end" variant="secondary" className="max-w-[75%]">
          <BubbleContent className="rounded-2xl rounded-br-sm whitespace-pre-wrap">
            {message.content}
          </BubbleContent>
        </Bubble>
      </Message>
    );
  }
  return (
    <Message>
      <MessageAvatar className="from-primary to-chart-4 text-primary-foreground size-8 self-start bg-linear-to-br">
        <Sparkles className="size-4" />
      </MessageAvatar>
      <MessageContent>
        {message.detail && message.detail.length > 0 && (
          <DetailSteps detail={message.detail} />
        )}
        {message.pending ? (
          <div className="text-muted-foreground flex items-center gap-2 py-1">
            <Spinner />
            <span className="text-sm">Thinking...</span>
          </div>
        ) : (
          <MdRender content={message.content} streaming={streaming} />
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
