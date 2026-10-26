"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Plus, Search, Tag as TagIcon, X } from "lucide-react";
import { api, docListUrl, errorMessage } from "@/lib/client/api";
import { useQuery } from "@/lib/client/query";
import { cx, formatBytes } from "@/lib/client/format";
import { refreshLibrary, useTags } from "@/hooks/data";
import { useDebounced } from "@/hooks/use-debounced";
import { Button, Spinner, Switch, TextField } from "@/components/ui/primitives";
import { Sheet } from "@/components/ui/sheet";
import { Thumb } from "@/components/ui/media";
import { toast } from "@/components/ui/toast";

const normTag = (t: string) => t.trim().replace(/^#/, "").replace(/\s+/g, " ").slice(0, 40);

export function TagEditorSheet({
  open,
  onClose,
  title = "Tags",
  description,
  initial,
  onSave,
  mode = "replace",
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  initial: string[];
  onSave: (tags: string[]) => Promise<void>;
  mode?: "replace" | "add";
}) {
  return (
    <Sheet open={open} onClose={onClose} title={title} description={description}>
      <TagEditor key={`${open}-${initial.join("|")}`} initial={initial} onSave={onSave} onClose={onClose} mode={mode} />
    </Sheet>
  );
}

function TagEditor({
  initial,
  onSave,
  onClose,
  mode,
}: {
  initial: string[];
  onSave: (tags: string[]) => Promise<void>;
  onClose: () => void;
  mode: "replace" | "add";
}) {
  const [tags, setTags] = useState<string[]>(initial);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const { data: all } = useTags();
  const add = (raw: string) => {
    const t = normTag(raw);
    if (!t) return;
    setTags((prev) => (prev.some((p) => p.toLowerCase() === t.toLowerCase()) ? prev : [...prev, t]));
    setInput("");
  };
  const suggestions = (all ?? [])
    .filter((t) => !tags.includes(t.tag) && (!input || t.tag.toLowerCase().includes(input.toLowerCase())))
    .slice(0, 12);
  return (
    <div className="space-y-4 px-2 pb-2">
      <form method="post"
        onSubmit={(e) => {
          e.preventDefault();
          add(input);
        }}
        className="flex min-w-0 gap-2"
      >
        <div className="min-w-0 flex-1">
          <TextField
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Add a tag"
            enterKeyHint="enter"
            data-autofocus
            onKeyDown={(e) => {
              if (e.key === "," || e.key === "Tab") {
                if (input.trim()) {
                  e.preventDefault();
                  add(input);
                }
              }
            }}
          />
        </div>
        <Button type="submit" icon={<Plus className="size-4" />} disabled={!input.trim()}>
          Add
        </Button>
      </form>
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {tags.map((t) => (
            <span key={t} className="inline-flex h-9 max-w-full min-w-0 items-center gap-1 rounded-full border border-accent/40 bg-accent-tint pr-0.5 pl-3 text-[13px] text-ink">
              <span dir="auto">{t}</span>
              <button
                type="button"
                aria-label={`Remove ${t}`}
                onClick={() => setTags((p) => p.filter((x) => x !== t))}
                className="inline-flex size-7 items-center justify-center rounded-md text-muted hover:bg-white/10 hover:text-ink"
              >
                <X className="size-3.5" />
              </button>
            </span>
          ))}
        </div>
      )}
      {suggestions.length > 0 && (
        <div>
          <p className="mb-2 text-[13px] font-medium text-muted">Existing tags</p>
          <div className="flex flex-wrap gap-2">
            {suggestions.map((s) => (
              <button
                key={s.tag}
                type="button"
                onClick={() => add(s.tag)}
                className="focus-ring inline-flex h-9 max-w-full min-w-0 items-center gap-1.5 rounded-full border border-line px-3 text-[13px] text-muted hover:border-line-strong hover:text-ink"
              >
                <TagIcon className="size-3.5" />
                <span dir="auto">{s.tag}</span>
                <span className="text-[12px] text-faint tabular-nums">{s.count}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <Button
        variant="primary"
        block
        loading={busy}
        disabled={mode === "add" && tags.length === 0}
        onClick={async () => {
          setBusy(true);
          try {
            const final = input.trim() ? [...tags, normTag(input)] : tags;
            await onSave(Array.from(new Set(final)));
            onClose();
          } catch (e) {
            toast.error(errorMessage(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {mode === "add" ? "Add tags" : "Save tags"}
      </Button>
    </div>
  );
}

export function MergeSheet({
  open,
  onClose,
  ids,
  defaultTitle,
}: {
  open: boolean;
  onClose: () => void;
  ids: string[];
  defaultTitle?: string;
}) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`Merge ${ids.length} documents`}
      description="Pages are combined in the order shown."
      size="sm"
    >
      <MergeForm key={`${open}-${ids.join(",")}`} ids={ids} defaultTitle={defaultTitle} onClose={onClose} />
    </Sheet>
  );
}

function MergeForm({ ids, defaultTitle, onClose }: { ids: string[]; defaultTitle?: string; onClose: () => void }) {
  const router = useRouter();
  const [title, setTitle] = useState(defaultTitle ?? "");
  const [trashSources, setTrashSources] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <form method="post"
      className="space-y-4 px-2 pb-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          const doc = await api.merge({ ids, title: title.trim() || undefined, trashSources });
          refreshLibrary();
          toast.success("Documents merged");
          onClose();
          router.push(`/d/${doc.id}`);
        } catch (err) {
          toast.error(errorMessage(err, "Merge failed"));
        } finally {
          setBusy(false);
        }
      }}
    >
      <TextField label="Title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Merged document" data-autofocus />
      <Switch
        checked={trashSources}
        onChange={setTrashSources}
        label="Move originals to Trash"
        description="Otherwise the originals are kept."
      />
      <Button type="submit" variant="primary" block loading={busy}>
        Merge
      </Button>
    </form>
  );
}

/** Multi-select picker of other documents (for merging into the current doc). */
export function DocPickerSheet({
  open,
  onClose,
  excludeIds,
  title = "Choose documents",
  confirmLabel = "Continue",
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  excludeIds: string[];
  title?: string;
  confirmLabel?: string;
  onConfirm: (ids: string[]) => void;
}) {
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const dq = useDebounced(q.trim(), 250);
  const key = open ? docListUrl({ q: dq || undefined, limit: 60, sort: "updated", dir: "desc" }) : null;
  const { data, loading } = useQuery(key, () => api.docs({ q: dq || undefined, limit: 60, sort: "updated", dir: "desc" }));
  const items = (data?.items ?? []).filter((d) => !excludeIds.includes(d.id));
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      size="lg"
      footer={
        <Button
          variant="primary"
          block
          disabled={picked.length === 0}
          onClick={() => {
            onConfirm(picked);
            setPicked([]);
          }}
        >
          {confirmLabel}
          {picked.length > 0 ? ` (${picked.length})` : ""}
        </Button>
      }
    >
      <div className="sticky top-0 z-10 bg-s1 px-1 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-faint" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search documents"
            dir="auto"
            className="h-11 w-full rounded-xl border border-line-strong bg-black/25 pr-3 pl-10 text-[15px] outline-none focus:border-accent/70"
          />
        </div>
      </div>
      {loading && !data && (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      )}
      <div className="space-y-0.5">
        {items.map((d) => {
          const on = picked.includes(d.id);
          return (
            <button
              key={d.id}
              type="button"
              onClick={() => setPicked((p) => (on ? p.filter((x) => x !== d.id) : [...p, d.id]))}
              className={cx(
                "focus-ring flex w-full min-w-0 items-center gap-3 rounded-xl p-2 text-left transition-colors",
                on ? "bg-accent-tint" : "hover:bg-white/4",
              )}
            >
              <Thumb src={d.thumbUrl} className="h-14 w-11 shrink-0 rounded-md shadow-paper" />
              <span className="min-w-0 flex-1">
                <span dir="auto" className="block truncate text-sm font-medium">
                  {d.title}
                </span>
                <span className="text-[13px] text-muted">
                  {d.pageCount}p · {formatBytes(d.sizeBytes)}
                </span>
              </span>
              <span
                className={cx(
                  "flex size-6 items-center justify-center rounded-full border-[1.5px]",
                  on ? "border-accent-strong bg-accent-strong text-white" : "border-white/25 text-transparent",
                )}
              >
                {on && picked.indexOf(d.id) >= 0 ? (
                  <span className="font-mono text-[10px] font-bold">{picked.indexOf(d.id) + 1}</span>
                ) : (
                  <Check className="size-3.5" />
                )}
              </span>
            </button>
          );
        })}
        {!loading && items.length === 0 && <p className="py-8 text-center text-sm text-muted">No documents found.</p>}
      </div>
    </Sheet>
  );
}
