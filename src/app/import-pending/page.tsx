import type { Metadata } from "next";
import { ImportPending } from "@/components/import-pending";

export const metadata: Metadata = { title: "Import shared files" };

export default function ImportPendingPage() {
  return <ImportPending />;
}
