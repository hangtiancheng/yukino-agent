import { defaultLocale, type Locale } from "./config";

interface LanguageEntry {
  tag: string;
  q: number;
}

// Parses an Accept-Language header into q-ranked entries.
function parseAcceptLanguage(header: string): LanguageEntry[] {
  return header
    .split(",")
    .map((entry) => {
      const [tag, ...params] = entry.trim().split(";");
      const qParam = params.find((p) => p.trim().startsWith("q="));
      const q = qParam ? Number.parseFloat(qParam.trim().slice(2)) : 1;
      return { tag: tag.trim().toLowerCase(), q: Number.isFinite(q) ? q : 0 };
    })
    .filter((entry) => entry.tag.length > 0 && entry.tag !== "*")
    .sort((a, b) => b.q - a.q);
}

// Maps an Accept-Language header onto a supported locale: entries are ranked
// by q-value and the first one with a supported language prefix wins.
export function negotiateLocale(
  acceptLanguage: string | null | undefined,
): Locale {
  if (!acceptLanguage) return defaultLocale;
  for (const { tag } of parseAcceptLanguage(acceptLanguage)) {
    if (tag.startsWith("zh")) return "zh-CN";
    if (tag.startsWith("en")) return "en";
  }
  return defaultLocale;
}
