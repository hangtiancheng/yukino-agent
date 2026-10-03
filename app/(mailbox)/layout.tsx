import type { Metadata } from "next";
import { MailboxShell } from "@/components/mailbox/shell";
export const metadata: Metadata = {
  title: "投诉信箱 · Yukino",
  robots: { index: false, follow: false },
};
export default function MailboxLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <MailboxShell>{children}</MailboxShell>;
}
