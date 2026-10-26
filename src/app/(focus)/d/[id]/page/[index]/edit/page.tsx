import type { Metadata } from "next";
import { Suspense } from "react";
import { EditPageRoute } from "@/components/scanner/edit-page-route";

export const metadata: Metadata = { title: "Edit page" };

export default function EditPage() {
  return (
    <Suspense fallback={<div className="fixed inset-0 bg-[#050506]" />}>
      <EditPageRoute />
    </Suspense>
  );
}
