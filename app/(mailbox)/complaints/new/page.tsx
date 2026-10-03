import { ComposeComplaint } from "@/components/mailbox/compose";
import { requirePageAccount } from "@/lib/mailbox/auth";
export default async function NewComplaintPage() {
  return (
    <ComposeComplaint account={await requirePageAccount("/complaints/new")} />
  );
}
