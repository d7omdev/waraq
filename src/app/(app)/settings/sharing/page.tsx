import type { Metadata } from "next";
import { SharingSettings } from "@/components/settings/sharing-settings";

export const metadata: Metadata = { title: "Sharing" };

export default function Page() {
  return <SharingSettings />;
}
