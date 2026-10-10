"use client";
import { motion } from "motion/react";
import { BookSearch, LifeBuoy, Search, Snowflake } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ChatMessage, Mode } from "@/hooks/use-chat";
import type { A2uiClientAction } from "@a2ui/web_core/v0_9";
import MessageList from "./msg-list";
import ChatInput from "./chat-input";

const SUGGESTION_KEYS = [
  { key: "suggestionOncall", icon: LifeBuoy },
  { key: "suggestionRunbook", icon: BookSearch },
  { key: "suggestionIncident", icon: Search },
] as const;

interface ChatContainerProps {
  messages: ChatMessage[];
  isStreaming: boolean;
  mode: Mode;
  onModeChange: (m: Mode) => void;
  onSend: (text: string) => void;
  onA2uiAction: (messageIndex: number, action: A2uiClientAction) => void;
  onUpload: (file: File) => void;
}

export default function ChatContainer({
  messages,
  isStreaming,
  mode,
  onModeChange,
  onSend,
  onA2uiAction,
  onUpload,
}: ChatContainerProps) {
  const t = useTranslations("chat");
  const centered = messages.length === 0;
  return (
    <div
      className={`flex flex-1 flex-col overflow-hidden ${
        centered ? "items-center justify-center" : ""
      }`}
    >
      {centered ? (
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{
            y: { type: "spring", visualDuration: 0.5, bounce: 0.2 },
            opacity: { duration: 0.3, ease: "easeOut" },
          }}
          className="flex w-full max-w-2xl flex-col items-center px-6 pb-8 text-center"
        >
          <span className="from-primary to-chart-2 text-primary-foreground shadow-lift ring-primary/25 flex size-14 items-center justify-center rounded-2xl bg-linear-to-br ring-1">
            <Snowflake className="size-7" strokeWidth={1.6} />
          </span>
          <h1 className="text-foreground mt-5 text-2xl font-semibold tracking-tight">
            {t("greeting")}
          </h1>
          <p className="text-muted-foreground mt-2 max-w-md text-sm leading-relaxed">
            {t("heroSubtitle")}
          </p>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-2">
            {SUGGESTION_KEYS.map(({ key, icon: Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => onSend(t(key))}
                className="border-border/80 bg-card/80 text-muted-foreground hover:border-primary/40 hover:bg-accent/60 hover:text-foreground shadow-soft inline-flex cursor-pointer items-center gap-2 rounded-full border px-3.5 py-2 text-left text-[13px] transition-colors"
              >
                <Icon className="text-primary size-3.5 shrink-0" />
                <span>{t(key)}</span>
              </button>
            ))}
          </div>
        </motion.div>
      ) : (
        <MessageList
          messages={messages}
          isStreaming={isStreaming}
          onA2uiAction={onA2uiAction}
        />
      )}
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{
          y: { type: "spring", visualDuration: 0.5, bounce: 0.15 },
          opacity: { duration: 0.3, ease: "easeOut" },
        }}
        className="w-full px-6 pb-5"
      >
        <ChatInput
          isStreaming={isStreaming}
          mode={mode}
          onModeChange={onModeChange}
          onSend={onSend}
          onUpload={onUpload}
        />
      </motion.div>
    </div>
  );
}
