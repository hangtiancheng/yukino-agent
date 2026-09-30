"use client";

import { useCallback } from "react";
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
import LoadingOverlay from "@/components/loading-overlay";

export default function Home() {
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
      showNotification(
        "Please wait for the current operation to finish",
        "warning",
      );
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
  }, [isStreaming, showNotification, newChat, triggerAIOps, addMessage]);

  const handleUpload = useCallback(
    async (file: File) => {
      const msg = await uploadFile(file);
      if (msg) addMessage({ type: "assistant", content: msg });
    },
    [uploadFile, addMessage],
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
          </main>
        </ResizablePanel>
      </ResizablePanelGroup>
      <LoadingOverlay overlay={overlay} />
    </SidebarProvider>
  );
}
