import { LOCALE_COOKIE, type Locale } from "./config";

// Client-side persistence of an explicit language choice. Callers follow
// this with `router.refresh()` so the server re-renders every message,
// `<html lang>` and generateMetadata output in the new locale.
export function persistLocale(locale: Locale) {
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=31536000; samesite=lax`;
}
