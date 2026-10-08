import type messages from "../messages/en.json";
import type { Locale } from "@/lib/i18n/config";
import type { formats } from "@/lib/i18n/formats";

// Makes message keys, locale values and dateTime format names compile-time
// checked everywhere useTranslations/useLocale/useFormatter are used. en.json
// is the source of truth; tests/i18n.smoke.ts keeps zh-CN.json structurally
// identical at runtime.
declare module "next-intl" {
  interface AppConfig {
    Locale: Locale;
    Messages: typeof messages;
    Formats: typeof formats;
  }
}
