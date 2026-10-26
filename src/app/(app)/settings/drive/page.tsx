import type { Metadata } from "next";
import { DrivePage } from "@/components/settings/sections";

export const metadata: Metadata = { title: "Google Drive" };

export default function Page() {
  return <DrivePage />;
}
