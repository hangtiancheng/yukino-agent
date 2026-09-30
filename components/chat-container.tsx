"use client";
import { motion } from "motion/react";
import { BotMessageSquare } from "lucide-react";
import type { ChatMessage, Mode } from "@/hooks/use-chat";
import type { A2uiClientAction } from "@a2ui/web_core/v0_9";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import MessageList from "./msg-list";
import ChatInput from "./chat-input";

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
          className="w-full max-w-xl px-6"
        >
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon" className="bg-accent text-primary">
                <BotMessageSquare />
              </EmptyMedia>
              <EmptyTitle className="text-xl">
                Hello! I am the Yukino Agent OnCall assistant
              </EmptyTitle>
            </EmptyHeader>
          </Empty>
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
