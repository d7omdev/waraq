import { Suspense } from "react";
import { FolderLibrary } from "@/components/library/folder-library";
import { LibrarySkeleton } from "@/components/library/library-skeleton";

export default function FolderPage() {
  return (
    <Suspense fallback={<LibrarySkeleton />}>
      <FolderLibrary />
    </Suspense>
  );
}
