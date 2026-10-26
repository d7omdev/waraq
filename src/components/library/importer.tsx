"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FileStack, Files } from "lucide-react";
import { ACCEPT_IMPORT, isAcceptedFile, uploadNewDoc } from "@/lib/client/uploads";
import { errorMessage } from "@/lib/client/api";
import { formatBytes } from "@/lib/client/format";
import { refreshLibrary } from "@/hooks/data";
import { ListAction } from "@/components/ui/primitives";
import { Sheet } from "@/components/ui/sheet";
import { toast } from "@/components/ui/toast";

/** File-picker + "separate or combined" choice + background upload. */
export function useImporter(folderId: string | null) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<File[] | null>(null);

  const run = async (files: File[], combine: boolean) => {
    try {
      if (combine || files.length === 1) {
        const doc = await uploadNewDoc(files, { folderId, source: "import" });
        refreshLibrary();
        toast.success(`Imported “${doc.title}”`, {
          action: { label: "Open", onClick: () => router.push(`/d/${doc.id}`) },
        });
      } else {
        let ok = 0;
        // Sequential keeps the server's OCR queue and memory calm.
        for (const f of files) {
          try {
            await uploadNewDoc([f], { folderId, source: "import" });
            ok++;
            refreshLibrary();
          } catch {
            /* error shown in the tray */
          }
        }
        if (ok) toast.success(`Imported ${ok} of ${files.length} documents`);
      }
    } catch (e) {
      toast.error(errorMessage(e, "Import failed"));
    }
  };

  const handleFiles = (list: FileList | File[] | null) => {
    const files = Array.from(list ?? []).filter(isAcceptedFile);
    const rejected = (list ? Array.from(list).length : 0) - files.length;
    if (rejected > 0) toast.error(`${rejected} file${rejected === 1 ? "" : "s"} skipped (PDF or images only)`);
    if (files.length === 0) return;
    if (files.length === 1) void run(files, false);
    else setPending(files);
  };

  const input = (
    <input
      ref={inputRef}
      type="file"
      multiple
      accept={ACCEPT_IMPORT}
      className="hidden"
      onChange={(e) => {
        handleFiles(e.target.files);
        e.target.value = "";
      }}
    />
  );

  const count = pending?.length ?? 0;
  const size = pending?.reduce((s, f) => s + f.size, 0) ?? 0;
  const pdfs = pending?.filter((f) => f.type === "application/pdf").length ?? 0;

  const sheet = (
    <Sheet
      open={!!pending}
      onClose={() => setPending(null)}
      title={`Import ${count} files`}
      description={`${formatBytes(size)}${pdfs ? ` · ${pdfs} PDF${pdfs === 1 ? "" : "s"}` : ""}`}
      size="sm"
    >
      <ListAction
        icon={<Files />}
        tone="accent"
        label="Separate documents"
        description={`Creates ${count} documents, one per file`}
        onClick={() => {
          const f = pending;
          setPending(null);
          if (f) void run(f, false);
        }}
      />
      <ListAction
        icon={<FileStack />}
        label="Combine into one document"
        description="Pages are added in the order selected"
        onClick={() => {
          const f = pending;
          setPending(null);
          if (f) void run(f, true);
        }}
      />
    </Sheet>
  );

  return { open: () => inputRef.current?.click(), handleFiles, input, sheet };
}
