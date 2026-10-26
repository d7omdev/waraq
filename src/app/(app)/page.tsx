import { Suspense } from "react";
import { LibraryView } from "@/components/library/library-view";
import { LibrarySkeleton } from "@/components/library/library-skeleton";

export default function LibraryPage() {
  return (
    <Suspense fallback={<LibrarySkeleton />}>
      <LibraryView mode="all" />
    </Suspense>
  );
}
