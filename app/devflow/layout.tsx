import type { Metadata } from "next";
import { ThemeProvider } from "@/components/theme-provider";
import { DevflowProvider } from "@/components/devflow/provider";
import DevflowShell from "@/components/devflow/shell";

export const metadata: Metadata = {
  title: "DevFlow — Yukino Agent",
  description:
    "AI engineering collaboration workspace: GitHub issues, pull requests, CI debugging, knowledge base and reports.",
};

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
