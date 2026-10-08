import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { isLocale, LOCALE_COOKIE } from "@/lib/i18n/config";
import { formats } from "@/lib/i18n/formats";
import { negotiateLocale } from "@/lib/i18n/negotiate";

// Locale resolution for every request. This app intentionally has no
// [locale] route segment: the persisted `yukino_locale` cookie wins, and a
// first visit falls back to Accept-Language negotiation. Because this runs
// on the server, the very first HTML is already rendered in the user's
// language — no hydration mismatch and no English flash.
export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const stored = cookieStore.get(LOCALE_COOKIE)?.value;
  const locale = isLocale(stored)
    ? stored
    : negotiateLocale((await headers()).get("accept-language"));

  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
    formats,
  };
});
