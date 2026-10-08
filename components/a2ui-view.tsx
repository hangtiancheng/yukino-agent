"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { renderMarkdown } from "@a2ui/markdown-it";
import {
  A2uiSurface,
  MarkdownContext,
  type ReactComponentImplementation,
} from "@a2ui/react/v0_9";
import {
  type A2uiClientAction,
  type A2uiMessage,
  A2uiMessageSchema,
  MessageProcessor,
  type SurfaceModel,
} from "@a2ui/web_core/v0_9";

import { shadcnCatalog } from "@/catalog";

export const A2UI_ACTION = "[a2ui_action]";

export function buildQueryFromAction(action: A2uiClientAction): string {
  return `${A2UI_ACTION} ${action.name}\ncontext: ${JSON.stringify(action.context ?? {})}`;
}

export interface A2uiViewProps {
  messages: unknown[];
  onAction?: (query: string) => void;
  onRawAction?: (action: A2uiClientAction) => void;
}

export function A2uiView({ messages, onAction, onRawAction }: A2uiViewProps) {
  const onActionRef = useRef(onAction);
  const onRawActionRef = useRef(onRawAction);
  useEffect(() => {
    onActionRef.current = onAction;
    onRawActionRef.current = onRawAction;
  }, [onAction, onRawAction]);

  const validMessages = useMemo(() => {
    const valid: A2uiMessage[] = [];
    for (const message of messages) {
      const parsed = A2uiMessageSchema.safeParse(message);
      if (parsed.success) {
        valid.push(parsed.data);
      } else {
        console.error("[a2ui] dropping invalid message:", parsed.error.issues);
      }
    }
    return valid;
  }, [messages]);

  const processor = useMemo(
    () =>
      new MessageProcessor<ReactComponentImplementation>(
        [shadcnCatalog],
        // eslint-disable-next-line react-hooks/refs
        (action) => {
          if (onRawActionRef.current) {
            onRawActionRef.current(action);
          } else {
            onActionRef.current?.(buildQueryFromAction(action));
          }
        },
      ),
    [],
  );

  const [surfaces, setSurfaces] = useState<
    SurfaceModel<ReactComponentImplementation>[]
  >(() => Array.from(processor.model.surfacesMap.values()));

  const processedCount = useRef(0);

  useEffect(() => {
    const created = processor.onSurfaceCreated((surface) => {
      setSurfaces((prev) =>
        prev.some((s) => s.id === surface.id) ? prev : [...prev, surface],
      );
    });
    const deleted = processor.onSurfaceDeleted((id) => {
      setSurfaces((prev) => prev.filter((s) => s.id !== id));
    });
    if (validMessages.length > processedCount.current) {
      const pending = validMessages.slice(processedCount.current);
      processedCount.current = validMessages.length;
      try {
        processor.processMessages(pending);
      } catch (error) {
        console.error("[a2ui] failed to process messages:", error);
      }
    }
    return () => {
      created.unsubscribe();
      deleted.unsubscribe();
    };
  }, [processor, validMessages]);

  if (surfaces.length === 0) {
    return null;
  }
  return (
    <MarkdownContext.Provider value={renderMarkdown}>
      <div className="mt-3 flex flex-col gap-3">
        {surfaces.map((surface) => (
          <motion.div
            key={surface.id}
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{
              y: { type: "spring", visualDuration: 0.4, bounce: 0.18 },
              scale: { type: "spring", visualDuration: 0.4, bounce: 0.18 },
              opacity: { duration: 0.25, ease: "easeOut" },
            }}
          >
            <A2uiSurface surface={surface} />
          </motion.div>
        ))}
      </div>
    </MarkdownContext.Provider>
  );
}
