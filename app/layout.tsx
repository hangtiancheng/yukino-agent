import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages, getTranslations } from "next-intl/server";
import "./globals.css";
import { cn } from "@/lib/utils";
import { SentryProvider } from "@/components/sentry-provider";
import { Toaster } from "@/components/ui/toast";
import Dock from "@/components/dock";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("meta");
  return {
    title: t("title"),
    description: t("description"),
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Resolved in i18n/request.ts (cookie → Accept-Language); the client
  // provider inherits the same locale, keeping hydration mismatch-free.
  const locale = await getLocale();
  const messages = await getMessages();
  return (
    <html
      lang={locale}
      className={cn("h-full", "antialiased", "font-sans")}
      suppressHydrationWarning
    >
      <body className="flex min-h-full flex-col">
        <NextIntlClientProvider locale={locale} messages={messages}>
          <SentryProvider>
            {children}
            <Dock />
            <Toaster />
          </SentryProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
