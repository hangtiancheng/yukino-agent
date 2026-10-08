"use client";

import { useCallback } from "react";
import { useTranslations } from "next-intl";
import { useChat, type ChatMessage } from "@/hooks/use-chat";
import { SidebarProvider } from "@/components/ui/sidebar";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import Sidebar from "@/components/sidebar";
import ChatContainer from "@/components/chat-container";
import AIOpsBtn from "@/components/ai-ops-btn";
import ActiveAlertsPanel, {
  type AiOpsReportPayload,
} from "@/components/active-alerts-panel";
import LoadingOverlay from "@/components/loading-overlay";
import { LanguageSwitcher } from "@/components/language-switcher";

export default function Home() {
  const t = useTranslations("chat");
  // P1-6 fix: destructure individual fields so useCallback dependencies can
  // be granular — handleAIOps only rebuilds when isStreaming changes, not
  // when messages or other unrelated state changes.
  const {
    isStreaming,
    messages,
    sessionId,
    mode,
    setMode,
    histories,
    overlay,
    showNotification,
    newChat,
    loadChatHistory,
    deleteChatHistory,
    sendMessage,
    sendA2uiAction,
    triggerAIOps,
    uploadFile,
    addMessage,
  } = useChat();

  const handleAIOps = useCallback(async () => {
    if (isStreaming) {
      showNotification(t("notifications.waitForOperation"), "warning");
      return;
    }
    newChat();
    const r = await triggerAIOps();
    if (r) {
      const msg: ChatMessage = {
        type: "assistant",
        content: r.result,
        detail: r.detail,
        ...(r.a2ui && r.a2ui.length > 0 ? { a2ui: r.a2ui } : {}),
      };
      addMessage(msg);
    }
  }, [isStreaming, showNotification, newChat, triggerAIOps, addMessage, t]);

  const handleUpload = useCallback(
    async (file: File) => {
      const msg = await uploadFile(file);
      if (msg) addMessage({ type: "assistant", content: msg });
    },
    [uploadFile, addMessage],
  );

  // Reports diagnosed from the active-alerts panel join the transcript in
  // the same shape as the AI Ops button flow.
  const handlePanelReport = useCallback(
    (r: AiOpsReportPayload) => {
      addMessage({
        type: "assistant",
        content: r.result,
        detail: r.detail,
        ...(r.a2ui && r.a2ui.length > 0 ? { a2ui: r.a2ui } : {}),
      });
    },
    [addMessage],
  );

  return (
    <SidebarProvider className="h-svh overflow-hidden">
      <ResizablePanelGroup orientation="horizontal" className="h-full">
        <ResizablePanel defaultSize={220} minSize={160} maxSize={420}>
          <Sidebar
            histories={histories}
            activeId={sessionId}
            onNewChat={newChat}
            onLoad={loadChatHistory}
            onDelete={deleteChatHistory}
          />
        </ResizablePanel>
        <ResizableHandle className="hover:bg-primary/40 active:bg-primary/60" />
        <ResizablePanel minSize={360}>
          <main className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden">
            <div className="absolute top-4 right-4 z-10">
              <LanguageSwitcher className="bg-background/80 shadow-sm backdrop-blur-sm" />
            </div>
            <AIOpsBtn onClick={handleAIOps} disabled={isStreaming} />
            <ChatContainer
              messages={messages}
              isStreaming={isStreaming}
              mode={mode}
              onModeChange={setMode}
              onSend={sendMessage}
              onA2uiAction={sendA2uiAction}
              onUpload={handleUpload}
            />
            <ActiveAlertsPanel
              disabled={isStreaming}
              onReport={handlePanelReport}
              onNotify={showNotification}
            />
          </main>
        </ResizablePanel>
      </ResizablePanelGroup>
      <LoadingOverlay overlay={overlay} />
    </SidebarProvider>
  );
}
