"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Camera,
  CloudUpload,
  Copy,
  CopyPlus,
  Download,
  FileOutput,
  Files,
  Folder as FolderIcon,
  ImagePlus,
  Loader2,
  Images,
  MoreVertical,
  Pencil,
  Plus,
  Printer,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Scissors,
  Combine,
  Share2,
  SquareCheckBig,
  Star,
  Tag,
  Trash2,
  Type,
  Upload,
  X,
  FileX2,
} from "lucide-react";
import { api, ApiRequestError, errorMessage } from "@/lib/client/api";
import { mutate, useQuery } from "@/lib/client/query";
import { cx, formatBytes, formatDateTime, plural } from "@/lib/client/format";
import { copyText, downloadUrl, pageImageFile, printDoc, shareFiles, vibrate } from "@/lib/client/device";
import { ACCEPT_IMPORT, isAcceptedFile, uploadPages } from "@/lib/client/uploads";
import { docKey, refreshLibrary, useFolders } from "@/hooks/data";
import type { DocDetail, PageOp } from "@/lib/types";
import { ActionBar, Button, EmptyState, IconButton, ListAction, ProgressBar, Segmented, Skeleton, Spinner, TextField, type BarAction } from "@/components/ui/primitives";
import { useDock } from "@/hooks/use-dock";
import { Sheet, useResetOnHide } from "@/components/ui/sheet";
import { OcrBadge } from "@/components/ui/media";
import { toast } from "@/components/ui/toast";
import { FolderPickerSheet, ConfirmSheet } from "@/components/library/folder-sheets";
import { DocPickerSheet, MergeSheet, TagEditorSheet } from "@/components/library/doc-actions";
import { PageGrid } from "./page-grid";
import { PageViewer } from "./page-viewer";
import { ExportSheet, ShareSheet } from "./share-export";
import { saveToDrive, useDriveStatus } from "@/components/drive/save-to-drive-action";

type SheetName =
  | null
  | "share"
  | "export"
  | "more"
  | "move"
  | "tags"
  | "pickMerge"
  | "merge"
  | "split"
  | "add"
  | "deletePages"
  | "purge";

export function DocView() {
  const { id } = useParams<{ id: string }>();
  return <DocViewInner key={id} id={id} />;
}

function DocViewInner({ id }: { id: string }) {
  const router = useRouter();
  const key = docKey(id);
  const [poll, setPoll] = useState(false);
  // timeout: a hung request must not keep the processing banner up (see STALE_INFLIGHT_MS)
  const { data: doc, error, loading } = useQuery<DocDetail>(key, () => api.doc(id, AbortSignal.timeout(10_000)), {
    refreshInterval: poll ? 3000 : 0,
  });
  const needsPoll = !!doc && (doc.ocrStatus === "queued" || doc.ocrStatus === "running" || doc.status === "processing");
  if (needsPoll !== poll) setPoll(needsPoll);

  // when OCR finishes, refresh lists so the badge/snippet update there too
  const prevOcr = useRef(doc?.ocrStatus);
  useEffect(() => {
    if (prevOcr.current && prevOcr.current !== doc?.ocrStatus && doc?.ocrStatus === "done") refreshLibrary();
    prevOcr.current = doc?.ocrStatus;
  }, [doc?.ocrStatus]);

  const [tab, setTab] = useState<"pages" | "text">("pages");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [orderOverride, setOrderOverride] = useState<{ v: number; order: number[] } | null>(null);
  const [sheet, setSheet] = useState<SheetName>(null);
  const [viewer, setViewer] = useState<number | null>(null);
  const [mergeIds, setMergeIds] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const drive = useDriveStatus();
  const { data: folders } = useFolders();
  const phoneBar = useRef<HTMLDivElement>(null);
  const deskBar = useRef<HTMLDivElement>(null);
  useDock(phoneBar, !!doc);
  useDock(deskBar, !!doc && selecting);

  useResetOnHide(() => {
    setSheet(null);
    setViewer(null);
    setSelecting(false);
    setSelected([]);
  });

  if (error && !doc) {
    const notFound = error instanceof ApiRequestError && error.status === 404;
    return (
      <div className="pt-[calc(var(--sat)+40px)]">
        <EmptyState
          icon={<FileX2 />}
          title={notFound ? "Document not found" : "Could not open document"}
          body={notFound ? "It may have been deleted for good." : errorMessage(error)}
          action={
            <Link href="/" className="focus-ring inline-flex h-11 items-center rounded-lg border border-line-strong bg-s2 px-4 text-sm">
              Back to Library
            </Link>
          }
        />
      </div>
    );
  }
  if (!doc || (loading && !doc)) return <DocSkeleton />;

  const order = orderOverride && orderOverride.v === doc.version ? orderOverride.order : doc.pages.map((p) => p.index);
  const viewerPages = order.map((i) => doc.pages[i]).filter(Boolean);

  const apply = (next: DocDetail) => {
    mutate<DocDetail>(key, next);
    refreshLibrary();
  };

  const patchDoc = async (body: Parameters<typeof api.updateDoc>[1], msg?: string) => {
    const prev = doc;
    mutate<DocDetail>(key, { ...doc, ...body } as DocDetail);
    try {
      const s = await api.updateDoc(doc.id, body);
      mutate<DocDetail>(key, (d) => (d ? { ...d, ...s } : d));
      refreshLibrary();
      if (msg) toast.success(msg);
    } catch (e) {
      mutate<DocDetail>(key, prev);
      toast.error(errorMessage(e));
    }
  };

  const runOps = async (ops: PageOp[], msg: string, opts: { keepSelection?: boolean } = {}) => {
    setBusy("ops");
    try {
      const next = await api.pageOps(doc.id, ops);
      apply(next);
      if (!opts.keepSelection) {
        setSelected([]);
        setSelecting(false);
      }
      toast.success(msg);
      return next;
    } catch (e) {
      toast.error(errorMessage(e, "Page operation failed"));
    } finally {
      setBusy(null);
    }
  };

  const onReorder = async (next: number[]) => {
    const v = doc.version;
    setOrderOverride({ v, order: next });
    try {
      const d = await api.pageOps(doc.id, [{ op: "reorder", order: next }]);
      setOrderOverride(null);
      apply(d);
      setSelected([]);
    } catch (e) {
      setOrderOverride(null);
      toast.error(errorMessage(e, "Could not reorder pages"));
    }
  };

  const toggleSel = (i: number) => {
    vibrate(10, "light");
    setSelected((s) => (s.includes(i) ? s.filter((x) => x !== i) : [...s, i]));
  };
  const exitSelect = () => {
    setSelecting(false);
    setSelected([]);
  };
  const selSorted = [...selected].sort((a, b) => a - b);

  const moveToTrash = async () => {
    try {
      await api.trashDoc(doc.id);
      refreshLibrary();
      vibrate(12, "warning");
      router.push(doc.folderId ? `/f/${doc.folderId}` : "/");
      toast({
        message: `“${doc.title}” moved to Trash`,
        action: {
          label: "Undo",
          onClick: async () => {
            await api.restoreDoc(doc.id);
            refreshLibrary();
            router.push(`/d/${doc.id}`);
          },
        },
      });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const extract = async (removeFromSource: boolean) => {
    setBusy("extract");
    try {
      const d = await api.extract(doc.id, { pages: selSorted, removeFromSource });
      refreshLibrary();
      if (removeFromSource) void api.doc(doc.id).then((x) => mutate(key, x));
      exitSelect();
      toast.success(removeFromSource ? "Pages moved to a new document" : "Pages copied to a new document", {
        action: { label: "Open", onClick: () => router.push(`/d/${d.id}`) },
      });
    } catch (e) {
      toast.error(errorMessage(e, "Extract failed"));
    } finally {
      setBusy(null);
    }
  };

  const sharePagesAsImages = async () => {
    setBusy("shareimg");
    try {
      const files = await Promise.all(selSorted.map((i) => pageImageFile(doc.pages[i].imageUrl, doc.title, i)));
      const r = await shareFiles(files, doc.title);
      if (r === "unsupported") downloadUrl(api.exportUrl(doc.id, "jpg-zip", selSorted));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const importPages = (list: FileList | null) => {
    const files = Array.from(list ?? []).filter(isAcceptedFile);
    if (!files.length) return;
    uploadPages(doc.id, files, `Adding ${plural(files.length, "file")}`)
      .then((d) => {
        apply(d);
        toast.success(`Added ${plural(files.length, "file")}`);
      })
      .catch((e) => toast.error(errorMessage(e, "Upload failed")));
  };

  const trashed = !!doc.trashedAt;
  const noSel = !selected.length || !!busy;
  const rotate = (degrees: 90 | 270) => runOps([{ op: "rotate", pages: selSorted, degrees }], "Rotated", { keepSelection: true });
  // Priority order: what does not fit folds into "More".
  const selectionActions: BarAction[] = [
    { key: "rotate", icon: <RotateCw />, label: "Rotate", disabled: noSel, onClick: () => rotate(90) },
    { key: "send", icon: <Images />, label: "Send", disabled: noSel, busy: busy === "shareimg", onClick: sharePagesAsImages },
    { key: "extract", icon: <FileOutput />, label: "Extract", disabled: noSel, busy: busy === "extract", onClick: () => extract(false) },
    { key: "delete", icon: <Trash2 />, label: "Delete", tone: "danger", disabled: noSel, onClick: () => setSheet("deletePages") },
    { key: "duplicate", icon: <CopyPlus />, label: "Duplicate", disabled: noSel, onClick: () => runOps([{ op: "duplicate", pages: selSorted }], "Duplicated") },
    {
      key: "moveout",
      icon: <Scissors />,
      label: "Move to new doc",
      disabled: noSel || selected.length === doc.pageCount,
      onClick: () => extract(true),
    },
    { key: "rotl", icon: <RotateCcw />, label: "Rotate left", disabled: noSel, onClick: () => rotate(270) },
  ];
  const docActions: BarAction[] = [
    { key: "share", icon: <Share2 />, label: "Share", onClick: () => setSheet("share") },
    { key: "export", icon: <Download />, label: "Export", onClick: () => setSheet("export") },
    { key: "add", icon: <Plus />, label: "Add pages", onClick: () => setSheet("add") },
    {
      key: "select",
      icon: <SquareCheckBig />,
      label: "Select",
      onClick: () => {
        setTab("pages");
        setSelecting(true);
      },
    },
  ];

  return (
    <div className="pb-dock mx-auto w-full max-w-[1500px]">
      <input
        ref={fileInput}
        type="file"
        multiple
        accept={ACCEPT_IMPORT}
        className="hidden"
        onChange={(e) => {
          importPages(e.target.files);
          e.target.value = "";
        }}
      />
      {/* Top bar */}
      <header className="bar sticky top-0 z-20 border-b border-line px-2 pt-[var(--sat)] sm:px-4 lg:px-8">
        <div className="flex h-14 min-w-0 items-center gap-1">
          {selecting ? (
            <>
              <IconButton label="Exit selection" onClick={exitSelect}>
                <X />
              </IconButton>
              <p className="min-w-0 flex-1 truncate text-[15px] font-semibold tabular-nums">
                {selected.length ? `${selected.length} of ${doc.pageCount} selected` : "Select pages"}
              </p>
              <Button
                size="sm"
                variant="ghost"
                className="h-11 text-accent"
                onClick={() => setSelected(selected.length === doc.pageCount ? [] : doc.pages.map((p) => p.index))}
              >
                {selected.length === doc.pageCount ? "None" : "All"}
              </Button>
            </>
          ) : (
            <>
              <Link
                href={doc.folderId ? `/f/${doc.folderId}` : "/"}
                className="focus-ring inline-flex h-11 min-w-0 items-center gap-1.5 rounded-xl pr-3 pl-2.5 text-[15px] text-muted hover:bg-white/6 hover:text-ink"
              >
                <ArrowLeft className="size-5 shrink-0 text-ink" />
                <span dir="auto" className="truncate">
                  {(doc.folderId && folders?.find((f) => f.id === doc.folderId)?.name) || "Library"}
                </span>
              </Link>
              <div className="flex-1" />
              <IconButton
                label={doc.starred ? "Unstar" : "Star"}
                onClick={() => {
                  vibrate(8);
                  void patchDoc({ starred: !doc.starred });
                }}
              >
                <Star className={cx(doc.starred && "fill-warn text-warn")} />
              </IconButton>
              <div className="hidden items-center gap-1 sm:flex lg:hidden">
                <IconButton label="Share" onClick={() => setSheet("share")}>
                  <Share2 />
                </IconButton>
                <IconButton label="Export" onClick={() => setSheet("export")}>
                  <Download />
                </IconButton>
              </div>
              <IconButton label="More actions" onClick={() => setSheet("more")}>
                <MoreVertical />
              </IconButton>
            </>
          )}
        </div>
      </header>

      {trashed && (
        <div className="surface mx-4 mt-3 flex min-w-0 items-center gap-3 rounded-2xl py-2 pr-2 pl-3.5 text-sm sm:mx-6 lg:mx-10">
          <Trash2 className="size-4 shrink-0 text-muted" />
          <span className="flex-1 text-muted">This document is in Trash.</span>
          <Button
            size="sm"
            onClick={async () => {
              await api.restoreDoc(doc.id);
              apply({ ...doc, trashedAt: null });
              toast.success("Restored");
            }}
          >
            Restore
          </Button>
        </div>
      )}

      <div className="lg:flex lg:items-start lg:gap-10 lg:px-8">
        <div className="min-w-0 flex-1">
          {/* Title + meta */}
          <section className="min-w-0 px-4 pt-5 sm:px-6 lg:px-2 lg:pt-8">
            <TitleEditor title={doc.title} onSave={(t) => patchDoc({ title: t })} />
            <MetaRow doc={doc} onFolder={() => setSheet("move")} onTags={() => setSheet("tags")} />
          </section>

          {/* Tabs (phones/tablets) */}
          <div className="bar sticky top-[calc(var(--sat)+57px)] z-10 mt-4 px-4 pt-2 pb-3 sm:px-6 lg:hidden">
            <Segmented
              value={tab}
              onChange={setTab}
              options={[
                { value: "pages", label: <><Files className="size-4" /> Pages <span className="text-faint tabular-nums">{doc.pageCount}</span></> },
                { value: "text", label: <><Type className="size-4" /> Text</> },
              ]}
            />
          </div>


          {(doc.status === "processing" || doc.status === "error") && (
            <ProcessingBanner doc={doc} onRetry={async () => apply(await api.retryDoc(doc.id))} />
          )}

          {/* banners above sit flush on pt-4; keep the standard section gap before the grid/text */}
          <div className={cx("px-4 sm:px-6 lg:mt-6 lg:px-2", (doc.status === "processing" || doc.status === "error") && "mt-4")}>
            <div className={cx(tab === "text" && "hidden lg:block")}>
              <div className="mb-3 hidden items-center justify-between lg:flex">
                <h2 className="text-[15px] font-semibold text-ink">
                  {plural(doc.pageCount, "page")}
                  <span className="ml-2 text-[13px] font-normal text-faint">Drag to reorder</span>
                </h2>
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" icon={<SquareCheckBig className="size-4" />} onClick={() => setSelecting(!selecting)}>
                    {selecting ? "Done" : "Select"}
                  </Button>
                  <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => setSheet("add")}>
                    Add pages
                  </Button>
                </div>
              </div>
              {busy === "ops" && (
                <div className="mb-3 flex items-center gap-2 text-[13px] text-muted">
                  <Spinner className="size-4" /> Updating pages…
                </div>
              )}
              <PageGrid
                pages={doc.pages}
                order={order}
                selecting={selecting}
                selected={selected}
                onToggle={toggleSel}
                onOpen={(pos) => setViewer(pos)}
                onReorder={onReorder}
                disabled={busy === "ops" || trashed || doc.status === "processing"}
                pendingFrom={doc.status === "processing" ? (doc.processing?.pagesDone ?? 0) : null}
              />
              <button
                type="button"
                onClick={() => setSheet("add")}
                className="surface focus-ring mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-2xl text-sm font-medium text-muted transition-colors hover:text-ink lg:hidden"
              >
                <Plus className="size-4" /> Add pages
              </button>
            </div>
            <div className={cx(tab === "pages" && "hidden", "lg:hidden")}>
              <DocText doc={doc} />
            </div>
          </div>
        </div>

        {/* Desktop side panel */}
        <aside className="sticky top-[calc(var(--sat)+80px)] mt-8 hidden w-[360px] shrink-0 space-y-3 lg:block">
          <div className="grid grid-cols-2 gap-2">
            <Button variant="primary" icon={<Share2 className="size-4" />} onClick={() => setSheet("share")}>
              Share
            </Button>
            <Button icon={<Download className="size-4" />} onClick={() => setSheet("export")}>
              Export
            </Button>
          </div>
          {drive.connected && (
            <Button block variant="ghost" className="border border-line" icon={<CloudUpload className="size-4" />} onClick={() => void saveToDrive([doc.id])}>
              Save to Google Drive
            </Button>
          )}
          <div className="surface divide-y divide-line rounded-2xl">
            <div className="p-4">
              <DetailsList doc={doc} />
            </div>
            <div className="p-4">
              <DocText doc={doc} compact />
            </div>
          </div>
        </aside>
      </div>

      {/* Bottom action bar (phones) */}
      <div
        ref={phoneBar}
        className="bar fixed inset-x-0 bottom-0 z-30 border-t border-line pb-[var(--sab)] shadow-[0_-12px_40px_-16px_rgb(0_0_0/0.8)] lg:hidden"
      >
        <div className="mx-auto max-w-2xl px-1.5 py-1.5">
          <ActionBar key={selecting ? "sel" : "doc"} actions={selecting ? selectionActions : docActions} />
        </div>
      </div>

      {/* Desktop selection bar */}
      {selecting && (
        <div
          ref={deskBar}
          className="bar fixed bottom-6 left-[calc(50%+130px)] z-30 hidden w-[min(680px,calc(100vw-340px))] -translate-x-1/2 animate-bar-in rounded-3xl border border-line-strong p-1.5 shadow-[0_24px_60px_-20px_rgb(0_0_0/0.9)] lg:block"
        >
          <ActionBar actions={selectionActions} />
        </div>
      )}

      {viewer !== null && viewerPages.length > 0 && (
        <PageViewer
          pages={viewerPages}
          startIndex={Math.min(viewer, viewerPages.length - 1)}
          title={doc.title}
          onClose={() => setViewer(null)}
          actions={(pos) => {
            const pageIndex = order[pos];
            return (
              <>
                <IconButton
                  label="Rotate page"
                  className="text-white"
                  onClick={() => runOps([{ op: "rotate", pages: [pageIndex], degrees: 90 }], "Rotated")}
                >
                  <RotateCw />
                </IconButton>
                <IconButton
                  label="Edit page (crop and filters)"
                  className="text-white"
                  onClick={() => router.push(`/d/${doc.id}/page/${pageIndex}/edit`)}
                >
                  <Pencil />
                </IconButton>
                <IconButton
                  label="Share page"
                  className="text-white"
                  onClick={async () => {
                    try {
                      const f = await pageImageFile(doc.pages[pageIndex].imageUrl, doc.title, pageIndex);
                      const r = await shareFiles([f], doc.title);
                      if (r === "unsupported") downloadUrl(doc.pages[pageIndex].imageUrl, f.name);
                    } catch (e) {
                      toast.error(errorMessage(e));
                    }
                  }}
                >
                  <Share2 />
                </IconButton>
              </>
            );
          }}
        />
      )}

      {/* Sheets */}
      <ShareSheet
        open={sheet === "share"}
        onClose={() => setSheet(null)}
        doc={doc}
        selectedPages={selecting ? selSorted : []}
        onOpenExport={() => setSheet("export")}
      />
      <ExportSheet
        open={sheet === "export"}
        onClose={() => setSheet(null)}
        doc={doc}
        selectedPages={selecting ? selSorted : []}
        onDocChange={apply}
      />
      <Sheet open={sheet === "add"} onClose={() => setSheet(null)} title="Add pages" size="sm">
        <ListAction
          icon={<Camera />}
          tone="accent"
          label="Scan with camera"
          description="Pages are added to the end"
          onClick={() => router.push(`/scan?doc=${doc.id}`)}
        />
        <ListAction
          icon={<ImagePlus />}
          label="Photos to crop and enhance"
          description="Pick from gallery, then adjust edges"
          onClick={() => router.push(`/scan?doc=${doc.id}&import=1`)}
        />
        <ListAction
          icon={<Upload />}
          label="Import files as-is"
          description="PDFs or images"
          onClick={() => {
            setSheet(null);
            fileInput.current?.click();
          }}
        />
      </Sheet>
      <Sheet open={sheet === "more"} onClose={() => setSheet(null)} title={doc.title} size="sm">
        <ListAction icon={<FolderIcon />} label="Move to folder" onClick={() => setSheet("move")} />
        <ListAction icon={<Tag />} label="Tags" description={doc.tags.length ? doc.tags.join(", ") : undefined} onClick={() => setSheet("tags")} />
        <ListAction
          icon={<Copy />}
          label="Duplicate"
          onClick={async () => {
            setSheet(null);
            try {
              const d = await api.duplicate(doc.id);
              refreshLibrary();
              toast.success("Duplicated", { action: { label: "Open", onClick: () => router.push(`/d/${d.id}`) } });
            } catch (e) {
              toast.error(errorMessage(e));
            }
          }}
        />
        <ListAction icon={<Combine />} label="Merge with other documents" onClick={() => setSheet("pickMerge")} />
        <ListAction icon={<Scissors />} label="Split into documents" disabled={doc.pageCount < 2} onClick={() => setSheet("split")} />
        <ListAction
          icon={<RefreshCw />}
          label="Read text again (OCR)"
          description="English and Arabic"
          onClick={async () => {
            setSheet(null);
            try {
              await api.rerunOcr(doc.id);
              mutate<DocDetail>(key, { ...doc, ocrStatus: "queued" });
              toast.success("OCR queued");
            } catch (e) {
              toast.error(errorMessage(e));
            }
          }}
        />
        <ListAction icon={<Download />} label="Download PDF" onClick={() => { setSheet(null); downloadUrl(api.fileUrl(doc.id, true)); }} />
        <ListAction icon={<Printer />} label="Print" onClick={() => { setSheet(null); printDoc(doc.id); }} />
        {drive.connected && (
          <ListAction
            icon={<CloudUpload />}
            label="Save to Google Drive"
            onClick={() => {
              setSheet(null);
              void saveToDrive([doc.id]);
            }}
          />
        )}
        {trashed ? (
          <ListAction icon={<Trash2 />} label="Delete forever" tone="danger" onClick={() => setSheet("purge")} />
        ) : (
          <ListAction icon={<Trash2 />} label="Move to Trash" tone="danger" onClick={() => { setSheet(null); void moveToTrash(); }} />
        )}
      </Sheet>
      <FolderPickerSheet
        open={sheet === "move"}
        onClose={() => setSheet(null)}
        currentId={doc.folderId}
        onPick={(fid) => patchDoc({ folderId: fid }, "Moved")}
      />
      <TagEditorSheet
        open={sheet === "tags"}
        onClose={() => setSheet(null)}
        initial={doc.tags}
        onSave={async (tags) => patchDoc({ tags })}
      />
      <DocPickerSheet
        open={sheet === "pickMerge"}
        onClose={() => setSheet(null)}
        excludeIds={[doc.id]}
        title="Merge with"
        onConfirm={(ids) => {
          setMergeIds([doc.id, ...ids]);
          setSheet("merge");
        }}
      />
      <MergeSheet open={sheet === "merge"} onClose={() => setSheet(null)} ids={mergeIds} defaultTitle={doc.title} />
      <SplitSheet
        open={sheet === "split"}
        onClose={() => setSheet(null)}
        doc={doc}
        selected={selSorted}
        onDone={() => {
          exitSelect();
          refreshLibrary();
        }}
      />
      <ConfirmSheet
        open={sheet === "deletePages"}
        onClose={() => setSheet(null)}
        title={selected.length === doc.pageCount ? "Delete every page?" : `Delete ${plural(selected.length, "page")}?`}
        body={
          selected.length === doc.pageCount
            ? "A document needs at least one page. Move the whole document to Trash instead?"
            : "Deleted pages cannot be recovered."
        }
        confirmLabel={selected.length === doc.pageCount ? "Move document to Trash" : "Delete pages"}
        onConfirm={async () => {
          if (selected.length === doc.pageCount) await moveToTrash();
          else await runOps([{ op: "delete", pages: selSorted }], `Deleted ${plural(selSorted.length, "page")}`);
        }}
      />
      <ConfirmSheet
        open={sheet === "purge"}
        onClose={() => setSheet(null)}
        title="Delete forever?"
        body="The file is removed from the server and cannot be recovered."
        confirmLabel="Delete forever"
        onConfirm={async () => {
          await api.deleteForever(doc.id);
          refreshLibrary();
          router.replace("/trash");
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function TitleEditor({ title, onSave }: { title: string; onSave: (t: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (editing) {
      ref.current?.focus();
      ref.current?.select();
    }
  }, [editing]);
  const commit = () => {
    const v = value.replace(/\s+/g, " ").trim();
    setEditing(false);
    if (v && v !== title) onSave(v);
    else setValue(title);
  };
  if (editing)
    return (
      <textarea
        ref={ref}
        value={value}
        dir="auto"
        rows={2}
        maxLength={200}
        onChange={(e) => setValue(e.target.value.replace(/\n/g, ""))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
          if (e.key === "Escape") {
            setValue(title);
            setEditing(false);
          }
        }}
        enterKeyHint="done"
        className="display block w-full resize-none rounded-xl border border-accent/60 bg-black/25 px-2 py-1 text-[24px] leading-[1.15] text-ink outline-none ring-3 ring-accent/20 sm:text-[32px]"
      />
    );
  return (
    <button
      type="button"
      onClick={() => {
        setValue(title);
        setEditing(true);
      }}
      className="focus-ring group -mx-2 block w-[calc(100%+16px)] min-w-0 rounded-xl px-2 py-1 text-left hover:bg-white/3"
      aria-label={`Rename: ${title}`}
    >
      <h1 dir="auto" className="display text-[24px] leading-[1.15] [overflow-wrap:anywhere] text-ink sm:text-[32px]">
        {title}
        <Pencil className="ms-2 inline size-4 align-[2px] text-faint opacity-0 transition-opacity group-hover:opacity-100 max-lg:opacity-70" />
      </h1>
    </button>
  );
}

function MetaRow({ doc, onFolder, onTags }: { doc: DocDetail; onFolder: () => void; onTags: () => void }) {
  const { data: folders } = useFolders();
  const folder = folders?.find((f) => f.id === doc.folderId);
  return (
    <div className="mt-2 space-y-3">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[13px] text-muted">
        <span>{plural(doc.pageCount, "page")}</span>
        <span className="text-faint">·</span>
        <span>{formatBytes(doc.sizeBytes)}</span>
        <span className="text-faint">·</span>
        <span>{formatDateTime(doc.updatedAt)}</span>
        <OcrBadge status={doc.ocrStatus} />
      </p>
      <div className="flex min-w-0 flex-wrap gap-2">
        <button
          type="button"
          onClick={onFolder}
          className="focus-ring flex h-9 max-w-full min-w-0 items-center gap-1.5 rounded-full border border-line-strong bg-s2 px-3 text-[13px] text-ink hover:border-accent/40"
        >
          <FolderIcon className="size-3.5 shrink-0 text-accent" style={folder?.color ? { color: folder.color } : undefined} />
          <span dir="auto" className="truncate">
            {folder?.name ?? "No folder"}
          </span>
        </button>
        {doc.tags.map((t) => (
          <button
            key={t}
            type="button"
            onClick={onTags}
            className="focus-ring flex h-9 max-w-full min-w-0 items-center rounded-full border border-line bg-white/[0.03] px-3 text-[13px] text-muted hover:text-ink"
          >
            <span dir="auto" className="truncate">
              #{t}
            </span>
          </button>
        ))}
        <button
          type="button"
          onClick={onTags}
          className="focus-ring flex h-9 shrink-0 items-center gap-1 rounded-full px-2.5 text-[13px] text-accent hover:bg-accent-tint"
        >
          {doc.tags.length ? <Pencil className="size-3.5" /> : <Plus className="size-3.5" />} {doc.tags.length ? "Edit tags" : "Add tag"}
        </button>
      </div>
    </div>
  );
}

function DetailsList({ doc }: { doc: DocDetail }) {
  const rows: [string, string][] = [
    ["Pages", String(doc.pageCount)],
    ["Size", formatBytes(doc.sizeBytes)],
    ["Created", formatDateTime(doc.createdAt)],
    ["Modified", formatDateTime(doc.updatedAt)],
    ["Source", doc.source.replace("-", " ")],
    ["Share links", String(doc.shares.filter((s) => !s.revokedAt).length)],
  ];
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt className="text-[13px] text-faint">{k}</dt>
          <dd className="mt-0.5 text-ink capitalize">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function DocText({ doc, compact }: { doc: DocDetail; compact?: boolean }) {
  const needsFetch = doc.ocrText == null && doc.ocrStatus === "done";
  const { data, loading } = useQuery<{ text: string }>(needsFetch ? `/api/docs/${doc.id}/text?v=${doc.version}` : null, () =>
    api.text(doc.id),
  );
  const text = doc.ocrText ?? data?.text ?? "";
  const [expanded, setExpanded] = useState(false);
  const running = doc.ocrStatus === "queued" || doc.ocrStatus === "running";
  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <h2 className="flex-1 text-[15px] font-semibold text-ink">Text</h2>
        <OcrBadge status={doc.ocrStatus} />
        {text && (
          <IconButton
            label="Copy all text"
            onClick={async () => {
              if (await copyText(text)) {
                vibrate(8);
                toast.success("Text copied");
              }
            }}
          >
            <Copy />
          </IconButton>
        )}
      </div>
      {running ? (
        <div className="space-y-2.5">
          <Skeleton className="h-3.5 w-11/12" />
          <Skeleton className="h-3.5 w-4/5" />
          <Skeleton className="h-3.5 w-10/12" />
          <p className="pt-2 text-[13px] text-muted">Reading English and Arabic text. This updates automatically.</p>
        </div>
      ) : needsFetch && loading ? (
        <Spinner />
      ) : text.trim() ? (
        <>
          <pre
            dir="auto"
            className={cx(
              "ocr-text font-sans text-[14.5px] whitespace-pre-wrap text-ink/90 select-text",
              compact && !expanded && "line-clamp-[12]",
            )}
          >
            {text.trim()}
          </pre>
          {compact && text.split("\n").length > 12 && (
            <Button size="sm" variant="ghost" className="mt-2 text-accent" onClick={() => setExpanded(!expanded)}>
              {expanded ? "Show less" : "Show all"}
            </Button>
          )}
        </>
      ) : (
        <div className="surface rounded-2xl p-5 text-center">
          <p className="text-sm text-muted">
            {doc.ocrStatus === "error"
              ? "Text recognition failed for this document."
              : doc.ocrStatus === "none"
                ? "Text has not been read yet."
                : "No text was found in this document."}
          </p>
          <Button
            size="sm"
            className="mt-3"
            icon={<RefreshCw className="size-4" />}
            onClick={async () => {
              try {
                await api.rerunOcr(doc.id);
                mutate<DocDetail>(docKey(doc.id), { ...doc, ocrStatus: "queued" });
              } catch (e) {
                toast.error(errorMessage(e));
              }
            }}
          >
            Run OCR
          </Button>
        </div>
      )}
    </div>
  );
}

function SplitSheet({
  open,
  onClose,
  doc,
  selected,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  doc: DocDetail;
  selected: number[];
  onDone: () => void;
}) {
  const [mode, setMode] = useState<"every" | "at">(selected.length ? "at" : "every");
  const [every, setEvery] = useState(1);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  // "at": a new document starts at each selected page
  const starts = Array.from(new Set([0, ...selected.filter((i) => i > 0)])).sort((a, b) => a - b);
  const ranges = starts.map((s, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : doc.pageCount;
    return Array.from({ length: end - s }, (_, k) => s + k);
  });
  const count = mode === "every" ? Math.ceil(doc.pageCount / Math.max(1, every)) : ranges.length;
  return (
    <Sheet open={open} onClose={onClose} title="Split document" description={`${plural(doc.pageCount, "page")} into ${plural(count, "document")}`} size="sm">
      <div className="space-y-4 px-2 pb-2">
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: "every", label: "Every N pages" },
            { value: "at", label: "At selected pages" },
          ]}
        />
        {mode === "every" ? (
          <TextField
            label="Pages per document"
            type="number"
            inputMode="numeric"
            min={1}
            max={doc.pageCount}
            value={every}
            onChange={(e) => setEvery(Math.max(1, Math.min(doc.pageCount, Number(e.target.value) || 1)))}
          />
        ) : (
          <p className="text-sm text-muted">
            {selected.length
              ? `A new document starts at page ${starts.map((s) => s + 1).join(", ")}.`
              : "Select pages first: each selected page starts a new document."}
          </p>
        )}
        <Button
          variant="primary"
          block
          loading={busy}
          disabled={count < 2}
          onClick={async () => {
            setBusy(true);
            try {
              const res = await api.split(doc.id, mode === "every" ? { every } : { ranges });
              onDone();
              onClose();
              toast.success(`Created ${plural(res.docs.length, "document")}`, {
                action: { label: "Library", onClick: () => router.push(doc.folderId ? `/f/${doc.folderId}` : "/") },
              });
            } catch (e) {
              toast.error(errorMessage(e, "Split failed"));
            } finally {
              setBusy(false);
            }
          }}
        >
          Split into {count}
        </Button>
        <p className="text-center text-[13px] text-faint">The original stays as it is.</p>
      </div>
    </Sheet>
  );
}

function DocSkeleton() {
  return (
    <div className="mx-auto max-w-[1500px] px-4 pt-[calc(var(--sat)+70px)] sm:px-6 lg:px-10">
      <Skeleton className="h-9 w-3/4 max-w-md" />
      <Skeleton className="mt-4 h-4 w-1/2 max-w-xs" />
      <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="aspect-[3/4] rounded-xl" />
        ))}
      </div>
    </div>
  );
}

/** Non-blocking notice while the server is still building the document. */
export function ProcessingBanner({ doc, onRetry }: { doc: DocDetail; onRetry: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const p = doc.processing;
  const failed = doc.status === "error";
  const frac = p && p.pagesTotal ? Math.min(1, p.pagesDone / p.pagesTotal) : null;
  const stage = !p ? "Processing" : p.stage === "queued" ? "Waiting to process" : p.stage === "assembling" ? "Building the PDF" : "Rendering pages";
  return (
    <div className="px-4 pt-4 sm:px-6 lg:px-2" role="status" data-processing-banner>
      <div
        className={cx(
          "box-border flex w-full max-w-full min-w-0 items-center gap-3 overflow-hidden rounded-2xl border px-3.5 py-3",
          failed ? "border-danger/40 bg-danger/10" : "border-accent/30 bg-accent-tint",
        )}
      >
        {failed ? <AlertTriangle className="size-5 shrink-0 text-danger" /> : <Loader2 className="size-5 shrink-0 animate-spin text-accent" />}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-medium text-ink">
            {failed ? "Processing failed" : stage}
            {!failed && p && p.pagesTotal > 0 && (
              <span className="ml-1.5 font-normal text-muted tabular-nums">
                {Math.min(p.pagesDone, p.pagesTotal)} of {p.pagesTotal}
              </span>
            )}
          </p>
          {failed ? (
            <p className="mt-0.5 line-clamp-2 text-[13px] text-muted">{doc.processingError || "The scan could not be turned into a PDF."}</p>
          ) : frac != null ? (
            <ProgressBar value={frac} className="mt-2" label="Processing progress" />
          ) : (
            <p className="mt-0.5 truncate text-[13px] text-muted">You can leave this page. It updates by itself.</p>
          )}
        </div>
        {failed && (
          <Button
            size="sm"
            variant="secondary"
            loading={busy}
            icon={<RefreshCw className="size-4" />}
            onClick={async () => {
              setBusy(true);
              try {
                await onRetry();
              } catch (e) {
                toast.error(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Retry
          </Button>
        )}
      </div>
    </div>
  );
}
