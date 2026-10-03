import { AuthForm } from "@/components/mailbox/auth-form";
import { requirePageAccount } from "@/lib/mailbox/auth";
export default async function PasswordPage() {
  return (
    <AuthForm
      mode="change"
      account={await requirePageAccount("/account/password")}
    />
  );
}
