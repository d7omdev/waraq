import type { Metadata } from "next";
import { Suspense } from "react";
import { ScanRoute } from "@/components/scanner/scan-route";

export const metadata: Metadata = { title: "Scan" };

export default function ScanPage() {
  return (
    <Suspense fallback={<div className="fixed inset-0 bg-black" />}>
      <ScanRoute />
    </Suspense>
  );
}
