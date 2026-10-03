import { MailList } from "@/components/mailbox/mail-list";
import { requirePageAccount } from "@/lib/mailbox/auth";
export default async function SentPage() {
  await requirePageAccount("/complaints/sent");
  return <MailList view="sent" />;
}
