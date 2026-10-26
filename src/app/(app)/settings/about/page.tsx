import type { Metadata } from "next";
import { AboutSettings } from "@/components/settings/sections";

export const metadata: Metadata = { title: "About" };

export default function Page() {
  return <AboutSettings />;
}
