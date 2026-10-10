export const locales = ["en", "zh-CN"] as const;

export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = "en";

export const LOCALE_COOKIE = "yukino_locale";

export function isLocale(value: unknown): value is Locale {
  return (
    typeof value === "string" && (locales as readonly string[]).includes(value)
  );
}
