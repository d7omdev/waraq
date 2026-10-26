"use client";

import { useParams, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Printer } from "lucide-react";
import { api, errorMessage } from "@/lib/client/api";
import { useQuery } from "@/lib/client/query";
import type { DocDetail } from "@/lib/types";
import { Button, Spinner } from "@/components/ui/primitives";

/**
 * Printable document: one rendered page image per sheet. Works the same on
 * desktop and Android (which has no inline PDF viewer to print from).
 */
export function PrintView() {
  const { id } = useParams<{ id: string }>();
  const sp = useSearchParams();
  const wanted = (sp.get("pages") ?? "")
    .split(",")
    .map((x) => Number(x))
    .filter((n) => Number.isInteger(n) && n >= 0);
  const { data: doc, error } = useQuery<DocDetail>(`/api/docs/${id}`, () => api.doc(id));
  const pages = doc ? (wanted.length ? wanted.map((i) => doc.pages[i]).filter(Boolean) : doc.pages) : [];
  const [loaded, setLoaded] = useState(0);
  const printed = useRef(false);
  const ready = !!doc && pages.length > 0 && loaded >= pages.length;

  useEffect(() => {
    if (!ready || printed.current) return;
    printed.current = true;
    const t = window.setTimeout(() => window.print(), 250);
    return () => window.clearTimeout(t);
  }, [ready]);

  return (
    <div className="min-h-dvh bg-[#e9e6df] print:bg-white">
      <style>{`@page { margin: 0; } @media print { .print-sheet { break-after: page; height: 100vh; } .print-sheet:last-child { break-after: auto; } }`}</style>
      <div className="sticky top-0 z-10 flex items-center gap-3 bg-[#14121a] px-4 py-3 pt-[calc(var(--sat)+12px)] text-ink print:hidden">
        <p className="min-w-0 flex-1 truncate text-sm" dir="auto">
          {error ? errorMessage(error) : doc ? doc.title : "Preparing…"}
          {doc && !ready && <span className="ml-2 text-muted">Loading pages {loaded}/{pages.length}</span>}
        </p>
        {!ready && !error && <Spinner className="size-4" />}
        <Button size="sm" variant="primary" disabled={!ready} icon={<Printer className="size-4" />} onClick={() => window.print()}>
          Print
        </Button>
      </div>
      <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4 print:max-w-none print:gap-0 print:p-0">
        {pages.map((p) => (
          <div key={p.index} className="print-sheet flex items-center justify-center bg-white shadow-lg print:shadow-none">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={p.imageUrl}
              alt={`Page ${p.index + 1}`}
              className="block max-h-full w-full object-contain print:h-full print:w-auto"
              onLoad={() => setLoaded((n) => n + 1)}
              onError={() => setLoaded((n) => n + 1)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
