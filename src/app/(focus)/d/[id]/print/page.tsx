import type { Metadata } from "next";
import { Suspense } from "react";
import { PrintView } from "@/components/doc/print-view";

export const metadata: Metadata = { title: "Print" };

export default function PrintPage() {
  return (
    <Suspense fallback={null}>
      <PrintView />
    </Suspense>
  );
}
