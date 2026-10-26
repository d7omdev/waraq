import type { Metadata } from "next";
import { ScannerSettings } from "@/components/settings/sections";

export const metadata: Metadata = { title: "Scanner settings" };

export default function Page() {
  return <ScannerSettings />;
}
