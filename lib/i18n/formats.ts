import type { Formats } from "next-intl";

// Locale-aware date/time formats. Returned from i18n/request.ts (server) and
// inherited by the client provider, so useFormatter().dateTime(date, "<name>")
// renders in the active locale everywhere. Declared in types/next-intl.d.ts
// (AppConfig.Formats) so format names are compile-time checked.
export const formats = {
  dateTime: {
    // Compact stamp for list rows: "Oct 3, 2:30 PM" / "10月3日 14:30"
    short: {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    },
    // Default full stamp: "Oct 3, 2026, 2:30 PM" / "2026年10月3日 14:30"
    medium: { dateStyle: "medium", timeStyle: "short" },
    // Date only: "Oct 3, 2026" / "2026年10月3日"
    date: { dateStyle: "medium" },
  },
} satisfies Formats;
