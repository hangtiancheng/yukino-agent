import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { isLocale, LOCALE_COOKIE } from "@/lib/i18n/config";
import { formats } from "@/lib/i18n/formats";
import { negotiateLocale } from "@/lib/i18n/negotiate";

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
