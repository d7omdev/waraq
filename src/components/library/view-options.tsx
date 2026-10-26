"use client";

import type { ReactNode } from "react";
import { Columns3, FolderTree, LayoutGrid, List, Rows3 } from "lucide-react";
import { updatePrefs, usePrefs } from "@/lib/client/prefs";
import type { GridColumnsDesktop, GridColumnsMobile, SortKeyPref } from "@/lib/client/contract";
import { Segmented, Switch } from "@/components/ui/primitives";
import { Sheet } from "@/components/ui/sheet";

export const SORT_LABELS: { value: SortKeyPref; label: string }[] = [
  { value: "updated", label: "Modified" },
  { value: "created", label: "Created" },
  { value: "title", label: "Name" },
  { value: "size", label: "Size" },
];

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="mb-1.5 px-1 text-[13px] font-medium text-muted">{label}</p>
      {children}
      {hint && <p className="mt-1.5 px-1 text-[12.5px] leading-snug text-faint">{hint}</p>}
    </div>
  );
}

/** Library display prefs; used by the library "View" sheet and Settings > Library. */
export function LibraryPrefsForm({ showSort = true }: { showSort?: boolean }) {
  const { library } = usePrefs();
  const set = (p: Partial<typeof library>) => updatePrefs({ library: p });
  return (
    <div className="space-y-5">
      <Field
        label="Browse"
        hint={
          library.browseMode === "folders"
            ? "Library shows folders first, then documents that are not in a folder."
            : "Library shows every document; folders appear as chips."
        }
      >
        <Segmented
          value={library.browseMode}
          onChange={(v) => set({ browseMode: v })}
          options={[
            { value: "folders", label: <><FolderTree className="size-4" /> Folders</> },
            { value: "all", label: <><Rows3 className="size-4" /> All documents</> },
          ]}
        />
      </Field>
      <Field label="Layout">
        <Segmented
          value={library.view}
          onChange={(v) => set({ view: v })}
          options={[
            { value: "grid", label: <><LayoutGrid className="size-4" /> Grid</> },
            { value: "list", label: <><List className="size-4" /> List</> },
          ]}
        />
      </Field>
      <Field label="Grid columns on phones">
        <Segmented
          value={String(library.gridColumnsMobile) as `${GridColumnsMobile}`}
          onChange={(v) => set({ gridColumnsMobile: Number(v) as GridColumnsMobile, view: "grid" })}
          options={(["2", "3", "4"] as const).map((n) => ({ value: n, label: <><Columns3 className="size-3.5 opacity-60" /> {n}</> }))}
        />
      </Field>
      <Field label="Grid columns on larger screens" hint="Auto fits 3 to 6 columns to the window.">
        <Segmented
          value={String(library.gridColumnsDesktop) as string}
          onChange={(v) => set({ gridColumnsDesktop: (v === "auto" ? "auto" : Number(v)) as GridColumnsDesktop, view: "grid" })}
          options={["auto", "3", "4", "5", "6"].map((n) => ({ value: n, label: n === "auto" ? "Auto" : n }))}
        />
      </Field>
      {showSort && (
        <Field label="Sort documents by">
          <Segmented size="sm" value={library.sort} onChange={(v) => set({ sort: v })} options={SORT_LABELS} />
          <Segmented
            size="sm"
            className="mt-2"
            value={library.dir}
            onChange={(v) => set({ dir: v })}
            options={[
              { value: "desc", label: library.sort === "title" ? "Z to A" : library.sort === "size" ? "Largest first" : "Newest first" },
              { value: "asc", label: library.sort === "title" ? "A to Z" : library.sort === "size" ? "Smallest first" : "Oldest first" },
            ]}
          />
        </Field>
      )}
      {library.browseMode === "all" && (
        <div className="px-1">
          <Switch
            checked={library.showFolderTiles}
            onChange={(v) => set({ showFolderTiles: v })}
            label="Show folder shortcuts"
            description="A row of folders above the documents"
          />
        </div>
      )}
    </div>
  );
}

export function ViewOptionsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="View options" description="Saved for all your devices" size="sm">
      <div className="px-2 pt-1 pb-3">
        <LibraryPrefsForm />
      </div>
    </Sheet>
  );
}
