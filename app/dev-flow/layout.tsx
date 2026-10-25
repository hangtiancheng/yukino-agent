import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { DevFlowProvider } from "@/components/dev-flow/provider";
import DevFlowShell from "@/components/dev-flow/shell";
import { ThemeProvider } from "@/components/theme-provider";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("meta");
  return {
    title: t("devFlowTitle"),
    description: t("devFlowDescription"),
  };
}

export default function DevFlowLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <ThemeProvider defaultTheme="light" storageKey="dev-flow-theme">
      <DevFlowProvider>
        <DevFlowShell>{children}</DevFlowShell>
      </DevFlowProvider>
    </ThemeProvider>
  );
}
