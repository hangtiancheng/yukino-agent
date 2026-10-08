"use client";

// Thin convenience wrapper over the base-ui toast manager used by the
// DevFlow pages: notify.success / notify.error / notify.info.
import { toast } from "@/components/ui/toast";

export const notify = {
  success(title: string, description?: string) {
    toast.add({
      title,
      ...(description ? { description } : {}),
      type: "success",
    });
  },
  error(title: string, description?: string) {
    toast.add({
      title,
      ...(description ? { description } : {}),
      type: "error",
    });
  },
  info(title: string, description?: string) {
    toast.add({ title, ...(description ? { description } : {}), type: "info" });
  },
};
