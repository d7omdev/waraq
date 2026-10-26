import type { Metadata } from "next";
import { DevicesSettings } from "@/components/settings/sections";

export const metadata: Metadata = { title: "Devices" };

export default function Page() {
  return <DevicesSettings />;
}
