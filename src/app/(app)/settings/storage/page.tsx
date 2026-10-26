import type { Metadata } from "next";
import { StorageSettings } from "@/components/settings/sections";

export const metadata: Metadata = { title: "Storage" };

export default function Page() {
  return <StorageSettings />;
}
