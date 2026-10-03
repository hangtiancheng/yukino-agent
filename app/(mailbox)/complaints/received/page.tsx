import { MailList } from "@/components/mailbox/mail-list";
import { requirePageAccount } from "@/lib/mailbox/auth";
export default async function ReceivedPage() {
  await requirePageAccount("/complaints/received");
  return <MailList view="received" />;
}
