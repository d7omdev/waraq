import type { Metadata } from "next";
import { LibrarySettings } from "@/components/settings/sections";

export const metadata: Metadata = { title: "Library settings" };

export default function Page() {
  return <LibrarySettings />;
}
