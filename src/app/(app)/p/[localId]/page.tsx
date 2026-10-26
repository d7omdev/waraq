import { Suspense } from "react";
import { PendingDocView } from "@/components/doc/pending-doc-view";

/** A scan saved on this device that is still processing/uploading (see lib/client/upload-queue). */
export default function PendingDocPage() {
  return (
    <Suspense fallback={null}>
      <PendingDocView />
    </Suspense>
  );
}
