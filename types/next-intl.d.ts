import type messages from "../messages/en.json";
import type { Locale } from "@/lib/i18n/config";
import type { formats } from "@/lib/i18n/formats";

declare module "next-intl" {
  interface AppConfig {
    Locale: Locale;
    Messages: typeof messages;
    Formats: typeof formats;
  }
}
