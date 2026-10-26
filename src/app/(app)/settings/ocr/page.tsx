import type { Metadata } from "next";
import { OcrSettings } from "@/components/settings/sections";

export const metadata: Metadata = { title: "Text recognition" };

export default function Page() {
  return <OcrSettings />;
}
