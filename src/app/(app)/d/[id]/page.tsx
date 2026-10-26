import { Suspense } from "react";
import { DocView } from "@/components/doc/doc-view";
import { Skeleton } from "@/components/ui/primitives";

function Fallback() {
  return (
    <div className="mx-auto max-w-[1500px] px-4 pt-[calc(var(--sat)+70px)] sm:px-6 lg:px-10">
      <Skeleton className="h-9 w-3/4 max-w-md" />
      <Skeleton className="mt-4 h-4 w-1/2 max-w-xs" />
    </div>
  );
}

export default function DocPage() {
  return (
    <Suspense fallback={<Fallback />}>
      <DocView />
    </Suspense>
  );
}
