"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Loader2, TriangleAlert } from "lucide-react";
import { api, errorMessage, fetchBlob } from "@/lib/client/api";
import { imageSize } from "@/lib/client/scanner/engine";
import { Scanner } from "./scanner";

type Loaded = { key: string; blob: Blob; width: number; height: number } | { key: string; error: string };

export function EditPageRoute() {
  const { id, index } = useParams<{ id: string; index: string }>();
  const idx = Number(index);
  const key = `${id}/${idx}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const doc = await api.doc(id);
        const page = doc.pages[idx];
        if (!page) throw new Error("That page does not exist");
        const { blob } = await fetchBlob(page.imageUrl);
        const size = await imageSize(blob);
        if (!cancelled) setLoaded({ key, blob, ...size });
      } catch (e) {
        if (!cancelled) setLoaded({ key, error: errorMessage(e, "Could not load the page") });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, idx, key]);

  const current = loaded?.key === key ? loaded : null;
  if (!current)
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center gap-3 bg-[#050506] text-sm text-muted">
        <Loader2 className="size-6 animate-spin text-accent" />
        Loading page {Number.isFinite(idx) ? idx + 1 : ""}
      </div>
    );
  if ("error" in current)
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center gap-4 bg-[#050506] px-8 text-center">
        <TriangleAlert className="size-7 text-muted" />
        <p className="text-sm text-muted">{current.error}</p>
        <Link href={`/d/${id}`} className="focus-ring inline-flex h-11 items-center rounded-2xl bg-s3 px-4 text-sm">
          Back to document
        </Link>
      </div>
    );
  return (
    <Scanner
      key={key}
      target={{ kind: "replace", docId: id, index: idx }}
      initial={{ blob: current.blob, width: current.width, height: current.height }}
    />
  );
}
