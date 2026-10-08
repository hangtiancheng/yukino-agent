// Supported UI locales. Adding a language = add it here, ship a matching
// dictionaries/<locale>.json, and register it in lib/i18n/dictionaries.ts.
export const locales = ["en", "zh-CN"] as const;

export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = "en";

// Cookie that persists the user's explicit language choice across visits and
// keeps SSR and client rendering in sync (no hydration mismatch).
export const LOCALE_COOKIE = "yukino_locale";

export function isLocale(value: unknown): value is Locale {
  return (
    typeof value === "string" && (locales as readonly string[]).includes(value)
  );
}
