import type { Metadata } from "next";
import { Suspense } from "react";
import { LibraryView } from "@/components/library/library-view";
import { LibrarySkeleton } from "@/components/library/library-skeleton";

export const metadata: Metadata = { title: "Starred" };

export default function StarredPage() {
  return (
    <Suspense fallback={<LibrarySkeleton />}>
      <LibraryView mode="starred" />
    </Suspense>
  );
}
