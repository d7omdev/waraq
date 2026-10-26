"use client";

import { useSearchParams } from "next/navigation";
import { Scanner } from "./scanner";

/**
 * /scan: Waraq's in-browser scanner. `?doc=` adds pages to a document, `?folder=` files a new
 * scan, `?import=1` opens the photo picker. Old links with `?engine=` / `?advanced=1` (app 1.0.0/1.0.1) still land
 * here; those parameters are ignored.
 */
export function ScanRoute() {
  const params = useSearchParams();
  const doc = params.get("doc");
  const folder = params.get("folder");
  const importMode = params.get("import") === "1";
  const target = doc ? ({ kind: "append", docId: doc } as const) : ({ kind: "new", folderId: folder } as const);
  return <Scanner key={`${doc ?? "new"}-${importMode ? "i" : "c"}`} target={target} startWithImport={importMode} />;
}
