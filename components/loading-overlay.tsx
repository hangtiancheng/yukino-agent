"use client";
import { AnimatePresence, motion } from "motion/react";
import { Spinner } from "@/components/ui/spinner";

interface LoadingOverlayProps {
  overlay: { show: boolean; text: string; subtext: string };
}

export default function LoadingOverlay({ overlay }: LoadingOverlayProps) {
  return (
    <AnimatePresence>
      {overlay.show && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          className="bg-background/70 fixed inset-0 z-9999 flex items-center justify-center backdrop-blur-sm"
          role="status"
          aria-live="polite"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.9, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 6 }}
            transition={{ type: "spring", visualDuration: 0.4, bounce: 0.2 }}
            className="bg-card text-card-foreground flex flex-col items-center rounded-2xl px-12 py-10 text-center shadow-2xl"
          >
            <Spinner className="text-primary size-10" />
            <div className="mt-5 text-lg font-semibold">{overlay.text}</div>
            <div className="text-muted-foreground mt-2 text-sm">
              {overlay.subtext}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
