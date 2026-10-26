import type { Metadata } from "next";
import { Suspense } from "react";
import { PublicShareView } from "@/components/public-share-view";

export const metadata: Metadata = {
  title: "Shared document",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function SharePage() {
  return (
    <Suspense fallback={<div className="min-h-dvh" />}>
      <PublicShareView />
    </Suspense>
  );
}
