import type { Formats } from "next-intl";

export const formats = {
  dateTime: {
    short: {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    },
    medium: { dateStyle: "medium", timeStyle: "short" },
    date: { dateStyle: "medium" },
  },
} satisfies Formats;
