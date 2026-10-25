"use client";

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
