import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { ThemeProvider } from "@/components/theme-provider";
import { DevflowProvider } from "@/components/devflow/provider";
import DevflowShell from "@/components/devflow/shell";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("meta");
  return {
    title: t("devflowTitle"),
    description: t("devflowDescription"),
  };
}

export default function DevflowLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <ThemeProvider defaultTheme="light" storageKey="devflow-theme">
      <DevflowProvider>
        <DevflowShell>{children}</DevflowShell>
      </DevflowProvider>
    </ThemeProvider>
  );
}
