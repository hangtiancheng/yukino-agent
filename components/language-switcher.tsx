"use client";

// Top-right locale dropdown: lists every supported language, persists the
// choice to the yukino_locale cookie, then router.refresh() re-renders the
// server tree so all messages, <html lang> and metadata flip in one shot.
// Mounted at the top-right of each surface: floating in the OnCall page,
// and in the DevFlow header.
import { Languages } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { locales, type Locale } from "@/lib/i18n/config";
import { persistLocale } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  "zh-CN": "简体中文",
};

export function LanguageSwitcher({ className }: { className?: string }) {
  const locale = useLocale();
  const t = useTranslations("common");
  const router = useRouter();

  function handleChange(value: Locale | null) {
    if (value === null || value === locale) return;
    persistLocale(value);
    router.refresh();
  }

  return (
    <Select value={locale} onValueChange={handleChange}>
      <SelectTrigger
        size="sm"
        aria-label={t("switchLanguage")}
        title={t("switchLanguage")}
        className={cn("gap-1.5", className)}
      >
        <Languages className="text-muted-foreground size-4" />
        <SelectValue>
          {(value: Locale | null) =>
            value !== null ? LOCALE_LABELS[value] : ""
          }
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="end">
        {locales.map((value) => (
          <SelectItem key={value} value={value}>
            {LOCALE_LABELS[value]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
