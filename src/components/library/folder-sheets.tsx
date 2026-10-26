"use client";

import { useState, type ReactNode } from "react";
import { Check, ChevronRight, Folder as FolderIcon, FolderPlus, Home, Pencil, Trash2 } from "lucide-react";
import { api, errorMessage } from "@/lib/client/api";
import { cx } from "@/lib/client/format";
import { FOLDER_COLORS, folderPath, refreshLibrary, useFolders } from "@/hooks/data";
import type { Folder } from "@/lib/types";
import { Button, ListAction, Spinner, TextField } from "@/components/ui/primitives";
import { Sheet } from "@/components/ui/sheet";
import { toast } from "@/components/ui/toast";

export function ConfirmSheet({
  open,
  onClose,
  title,
  body,
  confirmLabel,
  tone = "danger",
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  tone?: "danger" | "primary";
  onConfirm: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Sheet open={open} onClose={onClose} title={title} size="sm">
      <div className="px-2 pb-2">
        {body && <p className="mb-5 text-sm leading-relaxed break-words text-muted">{body}</p>}
        <div className="grid grid-cols-2 gap-2">
          {/* destructive: initial focus on the safe choice */}
          <Button block onClick={onClose} variant="secondary" data-autofocus={tone === "danger" ? true : undefined}>
            Cancel
          </Button>
          <Button
            block
            variant={tone === "danger" ? "danger" : "primary"}
            loading={busy}
            data-autofocus={tone === "danger" ? undefined : true}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                onClose();
              } catch (e) {
                toast.error(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

export function FolderEditSheet({
  open,
  onClose,
  folder,
  parentId,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  folder?: Folder | null;
  parentId?: string | null;
  onSaved?: (f: Folder) => void;
}) {
  return (
    <Sheet open={open} onClose={onClose} title={folder ? "Rename folder" : parentId ? "New subfolder" : "New folder"} size="sm">
      {/* keyed so the form resets each time it opens for a different folder */}
      <FolderForm key={`${folder?.id ?? "new"}-${open}`} folder={folder} parentId={parentId} onClose={onClose} onSaved={onSaved} />
    </Sheet>
  );
}

function FolderForm({
  folder,
  parentId,
  onClose,
  onSaved,
}: {
  folder?: Folder | null;
  parentId?: string | null;
  onClose: () => void;
  onSaved?: (f: Folder) => void;
}) {
  const [name, setName] = useState(folder?.name ?? "");
  const [color, setColor] = useState<string | null>(folder?.color ?? FOLDER_COLORS[0]);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    try {
      const saved = folder
        ? await api.updateFolder(folder.id, { name: n, color })
        : await api.createFolder({ name: n, parentId: parentId ?? null, color });
      refreshLibrary();
      toast.success(folder ? "Folder renamed" : `Created “${n}”`);
      onSaved?.(saved);
      onClose();
    } catch (err) {
      toast.error(errorMessage(err, "Could not save folder"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form method="post" onSubmit={submit} className="space-y-5 px-2 pb-2">
      <TextField
        label="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Receipts, IDs, University…"
        maxLength={80}
        data-autofocus
        enterKeyHint="done"
      />
      <div>
        <span className="mb-2 block text-[13px] font-medium text-muted">Color</span>
        <div className="flex flex-wrap gap-2">
          {FOLDER_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Color ${c}`}
              onClick={() => setColor(c)}
              className={cx(
                "focus-ring flex size-11 items-center justify-center rounded-xl border transition-colors",
                color === c ? "border-white/50 bg-white/6" : "border-line hover:bg-white/4",
              )}
            >
              <span className="size-5 rounded-full opacity-80" style={{ background: c }}>
                {color === c && <Check className="size-5 p-0.5 text-black/70" />}
              </span>
            </button>
          ))}
        </div>
      </div>
      <Button type="submit" variant="primary" block loading={busy} disabled={!name.trim()}>
        {folder ? "Save" : "Create folder"}
      </Button>
    </form>
  );
}

export function FolderPickerSheet({
  open,
  onClose,
  title = "Move to",
  currentId,
  onPick,
  excludeId,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  currentId?: string | null;
  excludeId?: string;
  onPick: (folderId: string | null) => Promise<void> | void;
}) {
  const { data: folders, loading } = useFolders();
  const [creating, setCreating] = useState<null | { parentId: string | null }>(null);
  const [busyId, setBusyId] = useState<string | "root" | null>(null);
  const [filter, setFilter] = useState("");
  // folders whose children are visible; the path to the current folder starts open
  const [expanded, setExpanded] = useState<Set<string> | null>(null);
  const all = (folders ?? []).filter((f) => f.id !== excludeId);
  const ids = new Set(all.map((f) => f.id));
  // hide the excluded folder's whole subtree (a folder cannot move into itself)
  const blocked = new Set<string>();
  if (excludeId) {
    let grew = true;
    blocked.add(excludeId);
    while (grew) {
      grew = false;
      for (const f of folders ?? []) {
        if (f.parentId && blocked.has(f.parentId) && !blocked.has(f.id)) {
          blocked.add(f.id);
          grew = true;
        }
      }
    }
  }
  const visibleFolders = all.filter((f) => !blocked.has(f.id));
  const kids = new Map<string | null, Folder[]>();
  for (const f of visibleFolders) {
    const parent = f.parentId && ids.has(f.parentId) ? f.parentId : null;
    kids.set(parent, [...(kids.get(parent) ?? []), f]);
  }
  for (const l of kids.values()) l.sort((a, b) => a.name.localeCompare(b.name));
  const openSet =
    expanded ??
    new Set(folderPath(folders, currentId ?? null).map((f) => f.id).filter((id) => id !== currentId || (kids.get(id)?.length ?? 0) > 0));
  const toggle = (id: string) => {
    const next = new Set(openSet);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpanded(next);
  };
  const q = filter.trim().toLowerCase();
  const pick = async (id: string | null) => {
    setBusyId(id ?? "root");
    try {
      await onPick(id);
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  };
  const row = (f: Folder, depth: number, showPath?: string): ReactNode => {
    const children = kids.get(f.id) ?? [];
    const isOpen = openSet.has(f.id);
    return (
      <div key={f.id}>
        <div className="flex min-w-0 items-center" style={{ paddingLeft: Math.min(depth, 5) * 16 }}>
          {children.length > 0 && !showPath ? (
            <button
              type="button"
              aria-label={isOpen ? `Collapse ${f.name}` : `Expand ${f.name}`}
              aria-expanded={isOpen}
              onClick={() => toggle(f.id)}
              className="focus-ring inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-faint hover:bg-white/5 hover:text-ink"
            >
              <ChevronRight className={cx("size-4 transition-transform", isOpen && "rotate-90")} />
            </button>
          ) : (
            <span className="size-11 shrink-0" />
          )}
          <div className="min-w-0 flex-1">
            <ListAction
              icon={<FolderIcon style={{ color: f.color ?? undefined }} />}
              label={f.name}
              description={showPath ?? `${f.docCount} ${f.docCount === 1 ? "doc" : "docs"}${children.length ? ` · ${children.length} ${children.length === 1 ? "folder" : "folders"}` : ""}`}
              onClick={() => pick(f.id)}
              trailing={busyId === f.id ? <Spinner /> : currentId === f.id ? <Check className="size-5 text-accent" /> : null}
            />
          </div>
        </div>
        {isOpen && !showPath && children.map((c) => row(c, depth + 1))}
      </div>
    );
  };
  return (
    <>
      <Sheet open={open && !creating} onClose={onClose} title={title}>
        <div className="space-y-0.5">
          {visibleFolders.length > 10 && (
            <div className="px-1 pb-2">
              <TextField type="search" placeholder="Find a folder" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
          )}
          {!q && (
            <div className="flex min-w-0 items-center">
              <span className="size-11 shrink-0" />
              <div className="min-w-0 flex-1">
                <ListAction
                  icon={<Home />}
                  label="Library"
                  description="Not in a folder"
                  onClick={() => pick(null)}
                  trailing={busyId === "root" ? <Spinner /> : currentId === null ? <Check className="size-5 text-accent" /> : null}
                />
              </div>
            </div>
          )}
          {loading && !folders && (
            <div className="flex justify-center py-6">
              <Spinner />
            </div>
          )}
          {q
            ? visibleFolders
                .filter((f) => f.name.toLowerCase().includes(q))
                .map((f) =>
                  row(
                    f,
                    0,
                    folderPath(folders, f.parentId)
                      .map((x) => x.name)
                      .join(" › ") || "Library",
                  ),
                )
            : (kids.get(null) ?? []).map((f) => row(f, 0))}
          <div className="flex min-w-0 items-center">
            <span className="size-11 shrink-0" />
            <div className="min-w-0 flex-1">
              <ListAction icon={<FolderPlus />} label="New folder" tone="accent" onClick={() => setCreating({ parentId: null })} />
            </div>
          </div>
        </div>
      </Sheet>
      <FolderEditSheet
        open={open && !!creating}
        parentId={creating?.parentId ?? null}
        onClose={() => setCreating(null)}
        onSaved={(f) => {
          setCreating(null);
          void pick(f.id);
        }}
      />
    </>
  );
}

export function FolderActionsSheet({
  folder,
  onClose,
  onDeleted,
}: {
  folder: Folder | null;
  onClose: () => void;
  onDeleted?: (f: Folder) => void;
}) {
  const [mode, setMode] = useState<"menu" | "edit" | "delete" | "move" | "sub">("menu");
  const close = () => {
    setMode("menu");
    onClose();
  };
  return (
    <>
      <Sheet
        open={!!folder && mode === "menu"}
        onClose={close}
        title={folder?.name}
        description={folder ? `${folder.docCount} ${folder.docCount === 1 ? "document" : "documents"}` : undefined}
        size="sm"
      >
        <ListAction icon={<Pencil />} label="Rename or recolor" onClick={() => setMode("edit")} />
        <ListAction icon={<FolderPlus />} label="New subfolder" onClick={() => setMode("sub")} />
        <ListAction icon={<FolderIcon />} label="Move folder" onClick={() => setMode("move")} />
        <ListAction icon={<Trash2 />} label="Delete folder" tone="danger" onClick={() => setMode("delete")} />
      </Sheet>
      <FolderEditSheet open={!!folder && mode === "edit"} folder={folder} onClose={close} />
      <FolderEditSheet open={!!folder && mode === "sub"} parentId={folder?.id ?? null} onClose={close} />
      <FolderPickerSheet
        open={!!folder && mode === "move"}
        onClose={close}
        title="Move folder into"
        currentId={folder?.parentId ?? null}
        excludeId={folder?.id}
        onPick={async (parentId) => {
          if (!folder) return;
          await api.updateFolder(folder.id, { parentId });
          refreshLibrary();
          toast.success("Folder moved");
        }}
      />
      <ConfirmSheet
        open={!!folder && mode === "delete"}
        onClose={close}
        title={`Delete “${folder?.name ?? ""}”?`}
        body="Documents inside move to your Library and subfolders move up one level. Nothing is deleted."
        confirmLabel="Delete folder"
        onConfirm={async () => {
          if (!folder) return;
          await api.deleteFolder(folder.id);
          refreshLibrary();
          toast.success("Folder deleted");
          onDeleted?.(folder);
        }}
      />
    </>
  );
}
