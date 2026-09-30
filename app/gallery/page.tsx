"use client";

// Backend-free A2UI verification page: renders every shadcn extension
// component from a canned message set through the real catalog pipeline.
import { useCallback, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { FlaskConical } from "lucide-react";
import { A2uiView } from "@/components/a2ui-view";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createGalleryMessages } from "./gallery-messages";

export default function GalleryPage() {
  const messages = useMemo(() => createGalleryMessages(), []);
  const [lastAction, setLastAction] = useState<string | null>(null);

  const handleAction = useCallback((query: string) => {
    console.log("[gallery] action:", query);
    setLastAction(query);
  }, []);

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-6 px-6 py-8">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{
          y: { type: "spring", visualDuration: 0.5, bounce: 0.2 },
          opacity: { duration: 0.3, ease: "easeOut" },
        }}
        className="flex flex-col gap-2"
      >
        <h1 className="text-2xl font-semibold tracking-tight">
          A2UI Catalog Gallery
        </h1>
        <p className="text-muted-foreground text-sm">
          Renders all shadcn extension components from a mock message set — no
          backend required. Triggered actions are logged below and in the
          console.
        </p>
      </motion.div>
      <AnimatePresence initial={false}>
        {lastAction && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.28, ease: [0.23, 1, 0.32, 1] }}
            className="overflow-hidden"
          >
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <FlaskConical className="text-primary" />
                  Last action
                </CardTitle>
              </CardHeader>
              <CardContent>
                <pre className="text-muted-foreground overflow-x-auto font-mono text-xs whitespace-pre-wrap">
                  {lastAction}
                </pre>
              </CardContent>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>
      <A2uiView messages={messages} onAction={handleAction} />
    </div>
  );
}
