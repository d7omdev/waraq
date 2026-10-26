import { DocCardSkeleton } from "./doc-card";

export function LibrarySkeleton() {
  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 pt-[calc(var(--sat)+68px)] sm:px-6 lg:px-10 lg:pt-20">
      <div className="skeleton h-8 w-36 rounded-lg" />
      <div className="skeleton mt-5 h-11 w-full rounded-lg lg:max-w-xl" />
      <div className="mt-8 grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
        {Array.from({ length: 8 }, (_, i) => (
          <DocCardSkeleton key={i} view="grid" />
        ))}
      </div>
    </div>
  );
}
