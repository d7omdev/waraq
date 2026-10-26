import type { Metadata } from "next";
import { Suspense } from "react";
import { AccountSettings } from "@/components/settings/account-settings";

export const metadata: Metadata = { title: "Account" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AccountSettings />
    </Suspense>
  );
}
