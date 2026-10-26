"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowDownUp,
  ArrowUp,
  Check,
  CheckSquare,
  CloudUpload,
  ChevronRight,
  Columns3,
  Combine,
  Download,
  Folder as FolderIcon,
  FolderInput,
  FolderPlus,
  FolderTree,
  Plus,
  LayoutGrid,
  List,
  MoreHorizontal,
  RotateCcw,
  Rows3,
  ScanLine,
  Search,
  Share2,
  SlidersHorizontal,
  Star,
  Tag,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { api, docListUrl, errorMessage, type DocListQuery, type DocListResult, type SortDir, type SortKey } from "@/lib/client/api";
import { mutate, useQuery } from "@/lib/client/query";
import { cx, plural } from "@/lib/client/format";
import { downloadUrl, vibrate } from "@/lib/client/device";
import { folderPath, refreshLibrary, useFolders, useTags } from "@/hooks/data";
import { updatePrefs, usePrefs } from "@/lib/client/prefs";
import { useDebounced } from "@/hooks/use-debounced";
import { useMediaQuery } from "@/hooks/runtime";
import type { DocSummary, Folder } from "@/lib/types";
import { ActionBar, Button, Chip, EmptyState, IconButton, ListAction, Menu, Segmented, Spinner, type BarAction, type MenuItem } from "@/components/ui/primitives";
import { useDock } from "@/hooks/use-dock";
import { Sheet, useResetOnHide } from "@/components/ui/sheet";
import { toast } from "@/components/ui/toast";
import { Wordmark } from "@/components/brand";
import { InstallBanner } from "@/components/install/install-banner";
import { saveToDrive, useDriveStatus } from "@/components/drive/save-to-drive-action";
import { BulkShareSheet } from "@/components/share/bulk-share-sheet";
import { DocCard, DocCardSkeleton } from "./doc-card";
import { ConfirmSheet, FolderActionsSheet, FolderEditSheet, FolderPickerSheet } from "./folder-sheets";
import { CrumbDrop, FolderChip, FolderTile } from "./folder-tile";
import { ViewOptionsSheet } from "./view-options";
import { MergeSheet, TagEditorSheet } from "./doc-actions";
import { useImporter } from "./importer";

export type LibraryMode = "all" | "folder" | "starred" | "trash";

const SORTS: { value: SortKey; label: string }[] = [
  { value: "updated", label: "Last modified" },
  { value: "created", label: "Date created" },
  { value: "title", label: "Name" },
  { value: "size", label: "Size" },
];
const PAGE = 40;

type Sheet =
  | null
  | "sort"
  | "move"
  | "tag"
  | "merge"
  | "more"
  | "newFolder"
  | "folderActions"
  | "purge"
  | "emptyTrash"
  | "import"
  | "view"
  | "bulkShare";

export function LibraryView({ mode, folderId }: { mode: LibraryMode; folderId?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const urlQ = params.get("q") ?? "";
  const tag = params.get("tag") ?? "";

  const prefs = usePrefs();
  const { view, sort, dir, browseMode, gridColumnsMobile, gridColumnsDesktop, showFolderTiles } = prefs.library;
  const setView = (v: "grid" | "list") => updatePrefs({ library: { view: v } });
  const setSort = (v: SortKey) => updatePrefs({ library: { sort: v } });
  const setDir = (v: SortDir) => updatePrefs({ library: { dir: v } });
  const foldersMode = browseMode === "folders" && (mode === "all" || mode === "folder");
  const wide = useMediaQuery("(min-width: 640px)");

  /* ----------------------------- search box ----------------------------- */
  const [qInput, setQInput] = useState(urlQ);
  const [lastUrlQ, setLastUrlQ] = useState(urlQ);
  if (urlQ !== lastUrlQ) {
    setLastUrlQ(urlQ);
    setQInput(urlQ);
  }
  const debouncedQ = useDebounced(qInput.trim(), 300);
  useEffect(() => {
    if (debouncedQ === urlQ.trim()) return;
    const sp = new URLSearchParams(params.toString());
    if (debouncedQ) sp.set("q", debouncedQ);
    else sp.delete("q");
    const s = sp.toString();
    router.replace(`${pathname}${s ? `?${s}` : ""}`, { scroll: false });
  }, [debouncedQ, urlQ, params, pathname, router]);

  // share-target failures land on "/?share_error=<code>"
  const shareError = params.get("share_error");
  useEffect(() => {
    if (!shareError) return;
    const messages: Record<string, string> = {
      no_files: "Nothing to import: the shared item had no PDF or image.",
      forbidden_origin: "That share was blocked for security reasons. Try again from the app.",
    };
    toast.error(messages[shareError] ?? "Could not import the shared files.");
    const sp = new URLSearchParams(params.toString());
    sp.delete("share_error");
    const s = sp.toString();
    router.replace(`${pathname}${s ? `?${s}` : ""}`, { scroll: false });
  }, [shareError, params, pathname, router]);

  const setTag = (t: string | null) => {
    const sp = new URLSearchParams(params.toString());
    if (t) sp.set("tag", t);
    else sp.delete("tag");
    const s = sp.toString();
    router.replace(`${pathname}${s ? `?${s}` : ""}`, { scroll: false });
  };

  /* ------------------------------- data -------------------------------- */
  // folders mode: the root lists only documents outside folders (search and tags stay global)
  const rootOnly = mode === "all" && browseMode === "folders" && !urlQ.trim() && !tag;
  const query: DocListQuery = {
    folderId: mode === "folder" ? folderId : rootOnly ? "root" : undefined,
    starred: mode === "starred" || undefined,
    trash: mode === "trash" || undefined,
    q: urlQ.trim() || undefined,
    tag: tag || undefined,
    sort: urlQ.trim() ? undefined : sort,
    dir: urlQ.trim() ? undefined : dir,
    limit: PAGE,
  };
  const key = docListUrl(query);
  const [pollDocs, setPollDocs] = useState(false);
  const first = useQuery<DocListResult>(key, () => api.docs(query), { refreshInterval: pollDocs ? 3000 : 0 });
  const anyProcessing = !!first.data?.items.some((d) => d.status === "processing");
  if (anyProcessing !== pollDocs) setPollDocs(anyProcessing);
  const [more, setMore] = useState<{ key: string; pages: DocListResult[]; loading: boolean }>({
    key,
    pages: [],
    loading: false,
  });
  const extra = useMemo(() => (more.key === key ? more.pages : []), [more, key]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const items = useMemo(() => {
    const all = [...(first.data?.items ?? []), ...extra.flatMap((p) => p.items)];
    const seen = new Set<string>();
    return all.filter((d) => {
      if (hidden.has(d.id) || seen.has(d.id)) return false;
      seen.add(d.id);
      return true;
    });
  }, [first.data, extra, hidden]);
  const nextCursor = extra.length ? extra[extra.length - 1].nextCursor : (first.data?.nextCursor ?? null);

  const loadMore = async () => {
    if (!nextCursor || (more.key === key && more.loading)) return;
    setMore((m) => ({ key, pages: m.key === key ? m.pages : [], loading: true }));
    try {
      const page = await api.docs({ ...query, cursor: nextCursor });
      setMore((m) => ({ key, pages: [...(m.key === key ? m.pages : []), page], loading: false }));
    } catch (e) {
      setMore((m) => ({ ...m, loading: false }));
      toast.error(errorMessage(e));
    }
  };
  const sentinel = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef(loadMore);
  useEffect(() => {
    loadMoreRef.current = loadMore;
  });
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void loadMoreRef.current();
    }, { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [nextCursor]);

  const reload = () => {
    setHidden(new Set());
    setMore({ key, pages: [], loading: false });
    refreshLibrary();
  };

  const { data: folders } = useFolders();
  const { data: tags } = useTags();
  const bulkBar = useRef<HTMLDivElement>(null);
  const currentFolder = folders?.find((f) => f.id === folderId) ?? null;
  const crumbs = folderPath(folders, folderId ?? null);
  const childFolders: Folder[] = (folders ?? [])
    .filter((f) => (mode === "folder" ? f.parentId === folderId : !f.parentId || !folders?.some((p) => p.id === f.parentId)))
    .sort((a, b) => a.name.localeCompare(b.name));

  /* ----------------------------- selection ----------------------------- */
  const [selected, setSelected] = useState<string[]>([]);
  const [selecting, setSelecting] = useState(false);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [folderTarget, setFolderTarget] = useState<Folder | null>(null);
  useResetOnHide(() => {
    setSheet(null);
    setSelecting(false);
    setSelected([]);
    setFolderTarget(null);
  });
  const toggle = (id: string) => {
    vibrate(10, "light");
    setSelecting(true);
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  };
  const exitSelect = () => {
    setSelecting(false);
    setSelected([]);
  };
  const selDocs = selected.map((id) => items.find((d) => d.id === id)).filter(Boolean) as DocSummary[];

  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") exitSelect();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selecting]);

  /* ------------------------------ import ------------------------------- */
  const importer = useImporter(mode === "folder" ? (folderId ?? null) : null);

  /* ------------------- app-icon shortcuts (?action=...) ------------------- */
  const searchInput = useRef<HTMLInputElement>(null);
  const action = mode === "all" ? params.get("action") : null;
  useEffect(() => {
    if (action !== "import" && action !== "search") return;
    // A file picker cannot open without a user gesture: show a sheet with one big button.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (action === "import") setSheet("import");
    else window.setTimeout(() => searchInput.current?.focus(), 50);
    const sp = new URLSearchParams(params.toString());
    sp.delete("action");
    const s = sp.toString();
    router.replace(`${pathname}${s ? `?${s}` : ""}`, { scroll: false });
  }, [action, params, pathname, router]);
  const [dragging, setDragging] = useState(false);
  const handleFilesRef = useRef(importer.handleFiles);
  useEffect(() => {
    handleFilesRef.current = importer.handleFiles;
  });
  useEffect(() => {
    if (mode === "trash") return;
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      handleFilesRef.current(Array.from(e.dataTransfer?.files ?? []));
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [mode]);

  /* ---------------------------- bulk actions --------------------------- */
  const [busy, setBusy] = useState<string | null>(null);
  const drive = useDriveStatus();
  const bulkDrive = async () => {
    setBusy("drive");
    try {
      await saveToDrive([...selected]);
      exitSelect();
    } catch (e) {
      toast.error(errorMessage(e, "Could not save to Google Drive"));
    } finally {
      setBusy(null);
    }
  };

  const bulkTrash = async () => {
    const ids = [...selected];
    setHidden((h) => new Set([...h, ...ids]));
    exitSelect();
    const results = await Promise.allSettled(ids.map((id) => api.trashDoc(id)));
    const failed = ids.filter((_, i) => results[i].status === "rejected");
    if (failed.length) {
      setHidden((h) => new Set([...h].filter((x) => !failed.includes(x))));
      toast.error(`${failed.length} could not be moved to Trash`);
    }
    const ok = ids.filter((id) => !failed.includes(id));
    refreshLibrary();
    if (ok.length)
      toast({
        message: `${plural(ok.length, "document")} moved to Trash`,
        action: {
          label: "Undo",
          onClick: async () => {
            await Promise.allSettled(ok.map((id) => api.restoreDoc(id)));
            setHidden((h) => new Set([...h].filter((x) => !ok.includes(x))));
            refreshLibrary();
          },
        },
      });
  };

  const bulkRestore = async () => {
    const ids = [...selected];
    setHidden((h) => new Set([...h, ...ids]));
    exitSelect();
    await Promise.allSettled(ids.map((id) => api.restoreDoc(id)));
    refreshLibrary();
    toast.success(`${plural(ids.length, "document")} restored`);
  };

  const bulkStar = async () => {
    const target = !selDocs.every((d) => d.starred);
    setBusy("star");
    try {
      await Promise.all(selected.map((id) => api.updateDoc(id, { starred: target })));
      mutate<DocListResult>(key, (prev) =>
        prev ? { ...prev, items: prev.items.map((d) => (selected.includes(d.id) ? { ...d, starred: target } : d)) } : prev,
      );
      refreshLibrary();
      toast.success(target ? "Starred" : "Unstarred");
      exitSelect();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const bulkDownload = () => {
    selDocs.forEach((d, i) => window.setTimeout(() => downloadUrl(api.fileUrl(d.id, true)), i * 400));
  };

  const none = !selected.length;
  const bulkActions: BarAction[] =
    mode === "trash"
      ? [
          { key: "restore", icon: <RotateCcw />, label: "Restore", disabled: none, onClick: bulkRestore },
          { key: "purge", icon: <Trash2 />, label: "Delete", tone: "danger", disabled: none, onClick: () => setSheet("purge") },
        ]
      : [
          { key: "share", icon: <Share2 />, label: "Share", disabled: none, onClick: () => setSheet("bulkShare") },
          { key: "move", icon: <FolderInput />, label: "Move", disabled: none, onClick: () => setSheet("move") },
          { key: "tag", icon: <Tag />, label: "Tag", disabled: none, onClick: () => setSheet("tag") },
          { key: "trash", icon: <Trash2 />, label: "Delete", tone: "danger", disabled: none, onClick: bulkTrash },
          {
            key: "star",
            icon: <Star />,
            label: selDocs.length && selDocs.every((d) => d.starred) ? "Unstar" : "Star",
            disabled: none,
            busy: busy === "star",
            onClick: bulkStar,
          },
          { key: "merge", icon: <Combine />, label: "Merge", disabled: selected.length < 2, onClick: () => setSheet("merge") },
          { key: "download", icon: <Download />, label: "Download", disabled: none, onClick: bulkDownload },
          ...(drive.connected
            ? [{ key: "drive", icon: <CloudUpload />, label: "Save to Drive", disabled: none, busy: busy === "drive", onClick: bulkDrive }]
            : []),
        ];
  useDock(bulkBar, selecting);

  const empty = !first.loading && items.length === 0;
  const isSearching = !!urlQ.trim();

  /* ------------------------------- header ------------------------------ */
  const title =
    mode === "folder" ? (currentFolder?.name ?? "Folder") : mode === "starred" ? "Starred" : mode === "trash" ? "Trash" : "Library";
  const countLabel = first.data
    ? `${items.length}${nextCursor ? "+" : ""} ${items.length === 1 ? "document" : "documents"}`
    : "";

  const sortLabel = SORTS.find((x) => x.value === sort)?.label ?? "Sort";
  const newItems: MenuItem[] = [
    { icon: <ScanLine />, label: "Scan document", onClick: () => router.push(folderId ? `/scan?folder=${folderId}` : "/scan") },
    { icon: <Upload />, label: "Import files", onClick: importer.open },
    { icon: <FolderPlus />, label: mode === "folder" ? "New subfolder" : "New folder", onClick: () => setSheet("newFolder"), divider: true },
  ];
  const menuItems: MenuItem[] = [
    ...(items.length ? [{ icon: <CheckSquare />, label: "Select documents", onClick: () => setSelecting(true) }] : []),
    ...(mode === "all" || mode === "folder"
      ? [
          {
            icon: browseMode === "folders" ? <Rows3 /> : <FolderTree />,
            label: browseMode === "folders" ? "Show all documents" : "Browse by folder",
            onClick: () => updatePrefs({ library: { browseMode: browseMode === "folders" ? "all" : "folders" } }),
          },
        ]
      : []),
    { icon: <SlidersHorizontal />, label: "View options", onClick: () => setSheet("view") },
    ...(mode === "folder" && currentFolder
      ? [
          {
            icon: <FolderIcon />,
            divider: true,
            label: "Folder options",
            onClick: () => {
              setFolderTarget(currentFolder);
              setSheet("folderActions");
            },
          },
        ]
      : []),
    ...(mode === "trash" && items.length
      ? [{ icon: <Trash2 />, label: "Empty trash", tone: "danger" as const, onClick: () => setSheet("emptyTrash") }]
      : []),
  ];

  return (
    <div className="pb-dock mx-auto w-full max-w-[1400px]">
      {importer.input}
      {/* Top bar */}
      <header className="px-4 pt-[calc(var(--sat)+8px)] sm:px-6 lg:px-10 lg:pt-7">
        <div className="flex h-12 min-w-0 items-center gap-1">
          {mode === "all" ? (
            <div className="lg:hidden">
              <Wordmark />
            </div>
          ) : mode === "folder" ? (
            <nav className="-ml-1 flex min-w-0 items-center text-sm text-muted" aria-label="Breadcrumb">
              <CrumbDrop href="/" folderId={null} name="Library" className="focus-ring flex h-11 shrink-0 items-center rounded-lg px-1.5 hover:text-ink">
                Library
              </CrumbDrop>
              {crumbs.length > 3 && (
                <span className="flex shrink-0 items-center">
                  <ChevronRight className="size-3.5 shrink-0 text-faint" />
                  <span className="px-1 text-faint">…</span>
                </span>
              )}
              {crumbs.slice(Math.max(0, crumbs.length - 3), -1).map((c) => (
                <span key={c.id} className="flex min-w-0 items-center">
                  <ChevronRight className="size-3.5 shrink-0 text-faint" />
                  <CrumbDrop href={`/f/${c.id}`} folderId={c.id} name={c.name} className="focus-ring block h-11 min-w-0 truncate rounded-lg px-1.5 leading-[44px] hover:text-ink">
                    {c.name}
                  </CrumbDrop>
                </span>
              ))}
            </nav>
          ) : null}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {mode !== "trash" && (
              <span className="hidden sm:block">
                <Button size="sm" className="h-10 rounded-xl" icon={<Upload className="size-4" />} onClick={importer.open}>
                  Import
                </Button>
              </span>
            )}
            {mode !== "trash" && (
              <Menu label="New" trigger={<Plus />} items={newItems} />
            )}
            {menuItems.length > 0 && <Menu label="More options" trigger={<MoreHorizontal />} items={menuItems} />}
          </div>
        </div>

        <div className="mt-3 mb-5 flex min-w-0 items-baseline gap-3 lg:mt-1">
          <h1 dir="auto" className="display flex min-w-0 items-baseline gap-2.5 text-[28px] leading-[1.15] text-ink sm:text-[36px]">
            {mode === "folder" && (
              <FolderIcon
                className="size-6 shrink-0 self-center text-accent"
                strokeWidth={1.75}
                style={currentFolder?.color ? { color: currentFolder.color } : undefined}
              />
            )}
            <span className="truncate">{title}</span>
          </h1>
          {countLabel && !isSearching && <span className="shrink-0 text-[13px] text-muted tabular-nums">{countLabel}</span>}
        </div>

        {mode === "all" && !isSearching && (
          <QuickTiles
            onImport={importer.open}
            folderCount={folders?.length ?? 0}
            onNewFolder={() => setSheet("newFolder")}
          />
        )}

        {mode === "all" && <InstallBanner className="mb-4 lg:max-w-2xl" />}

        {mode !== "trash" && (
          <div className="relative lg:max-w-2xl">
            <Search className="pointer-events-none absolute top-1/2 left-4 size-[18px] -translate-y-1/2 text-faint" />
            <input
              ref={searchInput}
              type="search"
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              placeholder={mode === "folder" ? "Search in this folder" : "Search documents and text"}
              dir="auto"
              enterKeyHint="search"
              aria-label="Search documents"
              className="h-12 w-full rounded-2xl border border-line-strong bg-black/25 pr-12 pl-11 text-[15px] text-ink shadow-[inset_0_1px_2px_rgb(0_0_0/0.35)] outline-none placeholder:text-faint transition-colors focus:border-accent/70 focus:ring-3 focus:ring-accent/20"
            />
            {qInput && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setQInput("")}
                className="absolute top-1/2 right-0.5 inline-flex size-11 -translate-y-1/2 items-center justify-center rounded-xl text-muted hover:text-ink"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
        )}

        {/* Folders */}
        {!foldersMode && showFolderTiles && (mode === "all" || mode === "folder") && !isSearching && childFolders.length > 0 && (
          <div className="no-scrollbar fade-x -mx-4 mt-4 flex gap-2 overflow-x-auto px-4 py-1 sm:-mx-6 sm:px-6 lg:mx-0 lg:flex-wrap lg:px-0">
            {childFolders.map((f) => (
              <FolderChip
                key={f.id}
                folder={f}
                onMenu={() => {
                  setFolderTarget(f);
                  setSheet("folderActions");
                }}
              />
            ))}
            <button
              type="button"
              onClick={() => setSheet("newFolder")}
              className="focus-ring flex h-12 shrink-0 items-center gap-1.5 rounded-2xl border border-line px-3.5 text-sm text-muted transition-colors hover:border-line-strong hover:text-ink"
            >
              <FolderPlus className="size-4" />
              {mode === "folder" ? "New subfolder" : "New folder"}
            </button>
          </div>
        )}

        {/* Tag filter */}
        {mode !== "trash" && tags && tags.length > 0 && !isSearching && (
          <div
            className="no-scrollbar fade-x -mx-4 mt-3 flex items-center gap-1.5 overflow-x-auto px-4 sm:-mx-6 sm:px-6 lg:mx-0 lg:flex-wrap lg:px-0"
            role="group"
            aria-label="Filter by tag"
          >
            {tags.slice(0, 30).map((t) => (
              <Chip key={t.tag} selected={tag === t.tag} onClick={() => setTag(tag === t.tag ? null : t.tag)}>
                <span dir="auto">{t.tag}</span>
              </Chip>
            ))}
          </div>
        )}
      </header>

      {/* Content */}
      {foldersMode && !isSearching && !tag && (childFolders.length > 0 || mode === "folder") && (
        <section className="mt-5 px-4 sm:px-6 lg:px-10" aria-label="Folders">
          <div className="mb-3 flex min-h-9 items-center gap-2 border-b border-line pb-2">
            <p className="flex-1 text-[13px] font-medium text-ink">
              {mode === "folder" ? "Subfolders" : "Folders"}
              <span className="ml-2 font-normal text-faint tabular-nums">{childFolders.length || ""}</span>
            </p>
            <Button size="sm" variant="ghost" className="-my-1 text-accent" icon={<FolderPlus className="size-4" />} onClick={() => setSheet("newFolder")}>
              {mode === "folder" ? "New subfolder" : "New folder"}
            </Button>
          </div>
          {childFolders.length > 0 && (
            <div
              className={cx(
                "grid gap-2.5",
                gridColumnsMobile >= 3 ? "grid-cols-2 min-[400px]:grid-cols-3" : "grid-cols-2",
                "sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6",
              )}
            >
              {childFolders.map((f) => (
                <FolderTile
                  key={f.id}
                  folder={f}
                  compact={gridColumnsMobile >= 3}
                  subfolders={(folders ?? []).filter((x) => x.parentId === f.id).length}
                  onMenu={() => {
                    setFolderTarget(f);
                    setSheet("folderActions");
                  }}
                />
              ))}
            </div>
          )}
        </section>
      )}

      <section className="mt-5 px-4 sm:px-6 lg:px-10" aria-busy={first.loading}>
        {/* Toolbar: count, sort, view */}
        {!(first.error && !first.data) && (
          <div className="mb-4 flex min-h-9 min-w-0 items-center gap-1.5 border-b border-line pb-3">
            <p className="min-w-0 flex-1 truncate text-[13px] text-muted">
              {isSearching ? (
                first.loading ? (
                  "Searching…"
                ) : (
                  <>
                    {items.length}
                    {nextCursor ? "+" : ""} {items.length === 1 && !nextCursor ? "result" : "results"} for{" "}
                    <span className="text-ink" dir="auto">
                      “{urlQ}”
                    </span>
                  </>
                )
              ) : (
                <span className="font-medium text-ink">
                  {tag ? (
                    <>
                      Tagged <span dir="auto">“{tag}”</span>
                    </>
                  ) : mode === "trash" ? (
                    "Deleted documents"
                  ) : rootOnly ? (
                    "Not in a folder"
                  ) : (
                    "Documents"
                  )}
                </span>
              )}
            </p>
            {!isSearching && items.length > 0 && (
              <button
                type="button"
                onClick={() => setSheet("sort")}
                className="focus-ring -my-1 flex h-9 min-w-0 shrink items-center gap-1.5 rounded-lg px-2 text-[13px] text-muted hover:bg-white/5 hover:text-ink"
                aria-label={`Sort: ${sortLabel}`}
              >
                <span className="truncate">{sortLabel}</span>
                {dir === "desc" ? <ArrowDown className="size-3.5" /> : <ArrowUp className="size-3.5" />}
              </button>
            )}
            <Segmented
              size="sm"
              value={view}
              onChange={setView}
              className="-my-1 shrink-0"
              options={[
                { value: "grid", label: <LayoutGrid className="size-4" />, ariaLabel: "Grid view" },
                { value: "list", label: <List className="size-4" />, ariaLabel: "List view" },
              ]}
            />
            <Menu
              label="View options"
              trigger={<SlidersHorizontal />}
              buttonClassName="focus-ring -my-1 -mr-1.5 inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-muted transition-colors hover:bg-white/6 hover:text-ink [&_svg]:size-[18px]"
              items={[
                ...(wide
                  ? (["auto", 3, 4, 5, 6] as const).map((n) => ({
                      icon: <Columns3 />,
                      label: n === "auto" ? "Auto columns" : `${n} columns`,
                      checked: view === "grid" && gridColumnsDesktop === n,
                      onClick: () => updatePrefs({ library: { gridColumnsDesktop: n, view: "grid" } }),
                    }))
                  : ([2, 3, 4] as const).map((n) => ({
                      icon: <Columns3 />,
                      label: `${n} columns`,
                      checked: view === "grid" && gridColumnsMobile === n,
                      onClick: () => updatePrefs({ library: { gridColumnsMobile: n, view: "grid" } }),
                    }))),
                {
                  icon: <FolderTree />,
                  label: "Browse by folder",
                  checked: browseMode === "folders",
                  divider: true,
                  onClick: () => updatePrefs({ library: { browseMode: browseMode === "folders" ? "all" : "folders" } }),
                },
                { icon: <SlidersHorizontal />, label: "All view options…", onClick: () => setSheet("view") },
              ]}
            />
          </div>
        )}
        {first.error && !first.data ? (
          <EmptyState
            icon={<X />}
            title="Could not load"
            body={errorMessage(first.error)}
            action={<Button onClick={() => first.refresh()}>Try again</Button>}
          />
        ) : first.loading && !first.data ? (
          <Grid view={view} colsM={gridColumnsMobile} colsD={gridColumnsDesktop}>
            {Array.from({ length: view === "grid" ? 8 : 6 }, (_, i) => (
              <DocCardSkeleton key={i} view={view} />
            ))}
          </Grid>
        ) : empty ? (
          rootOnly && childFolders.length > 0 ? (
            <p className="py-6 text-center text-[13px] text-faint">Every document is in a folder.</p>
          ) : mode === "folder" && foldersMode && childFolders.length > 0 ? (
            <p className="py-6 text-center text-[13px] text-faint">No documents directly in this folder.</p>
          ) : (
            <LibraryEmpty mode={mode} searching={isSearching} tag={tag} onImport={importer.open} onClearTag={() => setTag(null)} />
          )
        ) : (
          <Grid view={view} colsM={gridColumnsMobile} colsD={gridColumnsDesktop}>
            {items.map((d) => (
              <DocCard
                key={d.id}
                doc={d as DocSummary}
                dragIds={() => (selected.includes(d.id) ? [...selected] : [d.id])}
                view={view}
                selecting={selecting}
                selected={selected.includes(d.id)}
                onToggle={() => toggle(d.id)}
                onLongPress={() => toggle(d.id)}
                trash={mode === "trash"}
              />
            ))}
          </Grid>
        )}
        <div ref={sentinel} className="h-px" />
        {more.key === key && more.loading && (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        )}
        {mode === "trash" && items.length > 0 && (
          <p className="mt-8 text-center text-[13px] text-faint">Items in Trash are deleted for good after {prefs.trash.retentionDays} days.</p>
        )}
      </section>

      {/* Bulk action bar */}
      {selecting && (
        <div
          ref={bulkBar}
          className="bar fixed inset-x-0 bottom-0 z-40 animate-bar-in border-t border-line-strong pb-[var(--sab)] shadow-[0_-12px_40px_-12px_rgb(0_0_0/0.7)] lg:right-auto lg:bottom-6 lg:left-[calc(50%+130px)] lg:w-[min(720px,calc(100vw-340px))] lg:-translate-x-1/2 lg:rounded-3xl lg:border lg:pb-0"
        >
          <div className="flex min-w-0 items-center gap-1 px-2 pt-1.5 lg:px-3 lg:pt-2">
            <IconButton label="Exit selection" onClick={exitSelect}>
              <X />
            </IconButton>
            <p className="min-w-0 flex-1 truncate text-[15px] font-semibold tabular-nums">{selected.length} selected</p>
            <button
              type="button"
              className="focus-ring h-11 shrink-0 rounded-xl px-3 text-sm font-medium text-accent hover:bg-accent-tint"
              onClick={() => {
                setSelected(selected.length === items.length ? [] : items.map((d) => d.id));
              }}
            >
              {selected.length === items.length ? "Select none" : "Select all"}
            </button>
          </div>
          <div className="px-1.5 pb-1.5 lg:px-3 lg:pb-3">
            <ActionBar actions={bulkActions} />
          </div>
        </div>
      )}

      {/* Drop overlay */}
      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-[70] flex animate-fade-in items-center justify-center bg-bg/80 p-8 backdrop-blur-sm">
          <div className="flex h-full max-h-[420px] w-full max-w-xl flex-col items-center justify-center rounded-2xl border-2 border-accent/60 bg-accent-tint">
            <Upload className="mb-3 size-8 text-accent" />
            <p className="text-xl font-semibold">Drop to import</p>
            <p className="mt-1 text-sm text-muted">PDFs and images{currentFolder ? ` into ${currentFolder.name}` : ""}</p>
          </div>
        </div>
      )}

      {/* Sheets */}
      {importer.sheet}
      <ViewOptionsSheet open={sheet === "view"} onClose={() => setSheet(null)} />
      <BulkShareSheet open={sheet === "bulkShare"} onClose={() => setSheet(null)} docs={selDocs} />
      <Sheet open={sheet === "sort"} onClose={() => setSheet(null)} title="Sort by" size="sm">
        <div className="space-y-0.5">
          {SORTS.map((s) => (
            <ListAction
              key={s.value}
              icon={<ArrowDownUp />}
              label={s.label}
              onClick={() => {
                setSort(s.value);
                setSheet(null);
              }}
              trailing={sort === s.value ? <Check className="size-5 text-accent" /> : null}
            />
          ))}
        </div>
        <div className="px-2 pt-3 pb-1">
          <Segmented
            value={dir}
            onChange={setDir}
            options={[
              { value: "desc", label: sort === "title" ? "Z to A" : sort === "size" ? "Largest" : "Newest" },
              { value: "asc", label: sort === "title" ? "A to Z" : sort === "size" ? "Smallest" : "Oldest" },
            ]}
          />
        </div>
      </Sheet>
      <FolderPickerSheet
        open={sheet === "move"}
        onClose={() => setSheet(null)}
        title={`Move ${plural(selected.length, "document")}`}
        currentId={mode === "folder" ? (folderId ?? null) : undefined}
        onPick={async (fid) => {
          await Promise.all(selected.map((id) => api.updateDoc(id, { folderId: fid })));
          if (mode === "folder" && fid !== folderId) setHidden((h) => new Set([...h, ...selected]));
          refreshLibrary();
          toast.success(`Moved ${plural(selected.length, "document")}`);
          exitSelect();
        }}
      />
      <TagEditorSheet
        open={sheet === "tag"}
        onClose={() => setSheet(null)}
        title="Add tags"
        description={`To ${plural(selected.length, "document")}`}
        initial={[]}
        mode="add"
        onSave={async (newTags) => {
          await Promise.all(
            selDocs.map((d) => api.updateDoc(d.id, { tags: Array.from(new Set([...d.tags, ...newTags])) })),
          );
          refreshLibrary();
          toast.success("Tags added");
          exitSelect();
        }}
      />
      <MergeSheet
        open={sheet === "merge"}
        onClose={() => setSheet(null)}
        ids={selected}
        defaultTitle={selDocs[0]?.title}
      />
      <FolderEditSheet
        open={sheet === "newFolder"}
        onClose={() => setSheet(null)}
        parentId={mode === "folder" ? folderId : null}
      />
      <FolderActionsSheet
        folder={sheet === "folderActions" ? folderTarget : null}
        onClose={() => {
          setSheet(null);
          setFolderTarget(null);
        }}
        onDeleted={(f) => {
          if (f.id === folderId) router.replace(f.parentId ? `/f/${f.parentId}` : "/");
        }}
      />
      <Sheet open={sheet === "import"} onClose={() => setSheet(null)} title="Import files" description="PDFs and photos, added as new documents" size="sm">
        <div className="px-2 pt-1 pb-2">
          <Button
            variant="primary"
            size="lg"
            block
            data-autofocus
            icon={<Upload className="size-5" />}
            className="h-14 text-[16px]"
            onClick={() => {
              setSheet(null);
              importer.open();
            }}
          >
            Choose files
          </Button>
          <Link
            href="/scan?import=1"
            onClick={() => setSheet(null)}
            className="focus-ring mt-2 flex h-12 items-center justify-center gap-2 rounded-xl text-sm font-medium text-muted hover:bg-white/5 hover:text-ink"
          >
            <ScanLine className="size-4" /> Photos to crop and enhance instead
          </Link>
        </div>
      </Sheet>

      <ConfirmSheet
        open={sheet === "purge"}
        onClose={() => setSheet(null)}
        title={`Delete ${plural(selected.length, "document")} forever?`}
        body="This removes the files from the server. It cannot be undone."
        confirmLabel="Delete forever"
        onConfirm={async () => {
          const ids = [...selected];
          await Promise.all(ids.map((id) => api.deleteForever(id)));
          setHidden((h) => new Set([...h, ...ids]));
          exitSelect();
          refreshLibrary();
          toast.success("Deleted");
        }}
      />
      <ConfirmSheet
        open={sheet === "emptyTrash"}
        onClose={() => setSheet(null)}
        title="Empty Trash?"
        body={`${plural(items.length, "document")} will be removed from the server for good.`}
        confirmLabel="Empty trash"
        onConfirm={async () => {
          const ids = items.map((d) => d.id);
          await Promise.allSettled(ids.map((id) => api.deleteForever(id)));
          reload();
          toast.success("Trash emptied");
        }}
      />
    </div>
  );
}

function Grid({
  view,
  colsM,
  colsD,
  children,
}: {
  view: "grid" | "list";
  colsM: number;
  colsD: number | "auto";
  children: React.ReactNode;
}) {
  return view === "grid" ? (
    <div
      className="doc-grid"
      data-cols-m={colsM}
      data-cols-d={colsD}
      style={{ "--cols-m": colsM, "--cols-d": colsD === "auto" ? 5 : colsD } as React.CSSProperties}
    >
      {children}
    </div>
  ) : (
    <div className="grid grid-cols-1 gap-2 xl:grid-cols-2 xl:gap-x-4">{children}</div>
  );
}

function LibraryEmpty({
  mode,
  searching,
  tag,
  onImport,
  onClearTag,
}: {
  mode: LibraryMode;
  searching: boolean;
  tag: string;
  onImport: () => void;
  onClearTag: () => void;
}) {
  if (searching)
    return (
      <EmptyState
        icon={<Search />}
        title="No matches"
        body="Search looks at titles and the text read from your scans. Text appears a little after upload once OCR finishes."
      />
    );
  if (tag)
    return (
      <EmptyState
        icon={<Tag />}
        title={`Nothing tagged “${tag}” here`}
        action={<Button onClick={onClearTag}>Clear tag filter</Button>}
      />
    );
  if (mode === "trash")
    return <EmptyState icon={<Trash2 />} title="Trash is empty" body="Deleted documents wait here before they are gone for good. Change how long in Settings › Storage." />;
  if (mode === "starred")
    return <EmptyState icon={<Star />} title="No starred documents" body="Star the papers you reach for often: IDs, contracts, the Wi-Fi password." />;
  return (
    <div className="surface relative mx-auto max-w-xl overflow-hidden rounded-3xl px-6 py-12 text-center sm:py-14">
      <div className="pointer-events-none absolute inset-x-0 -top-24 h-48 bg-[radial-gradient(closest-side,rgb(124_77_255/0.22),transparent)]" />
      <div className="relative mx-auto mb-6 h-24 w-20">
        <span className="absolute inset-0 translate-x-2.5 rotate-[7deg] rounded-lg bg-paper/40 shadow-paper" />
        <span className="absolute inset-0 flex -rotate-[4deg] flex-col gap-2 rounded-lg bg-paper p-3 pt-5 shadow-paper">
          <span className="h-1.5 w-10 rounded-full bg-paper-ink/25" />
          <span className="h-1.5 w-12 rounded-full bg-paper-ink/15" />
          <span className="h-1.5 w-8 rounded-full bg-paper-ink/15" />
        </span>
      </div>
      <h3 className="display relative text-[24px] leading-tight">{mode === "folder" ? "This folder is empty" : "No documents yet"}</h3>
      <p className="relative mx-auto mt-2 max-w-sm text-sm leading-relaxed text-muted">
        Scan with the camera or import PDFs and photos. Text inside them becomes searchable.
      </p>
      <div className="relative mt-7 flex flex-wrap justify-center gap-2">
        <Link
          href="/scan"
          className="focus-ring inline-flex h-11 items-center gap-2 rounded-xl bg-accent-strong bg-[linear-gradient(180deg,rgb(255_255_255/0.14),rgb(255_255_255/0))] px-5 text-sm font-semibold text-white shadow-glow hover:bg-accent-hover"
        >
          <ScanLine className="size-4" /> Scan
        </Link>
        <Button onClick={onImport} icon={<Upload className="size-4" />}>
          Import files
        </Button>
      </div>
    </div>
  );
}

function QuickTiles({
  onImport,
  folderCount,
  onNewFolder,
}: {
  onImport: () => void;
  folderCount: number;
  onNewFolder: () => void;
}) {
  const tile =
    "surface focus-ring group relative flex min-w-0 flex-col justify-between overflow-hidden rounded-2xl p-3 text-left transition-[border-color,transform] duration-150 hover:border-line-strong active:scale-[0.985] sm:p-3.5";
  const chip = "flex size-9 items-center justify-center rounded-[11px] [&_svg]:size-[18px]";
  const label = "block truncate text-[15px] font-semibold text-ink";
  const sub = "block truncate text-[12px] text-muted";
  return (
    <div className="mb-4 grid h-[96px] grid-cols-[1.3fr_1fr_1fr] gap-2 sm:h-[104px] sm:gap-2.5 lg:max-w-2xl">
      <button
        type="button"
        onClick={onImport}
        className={cx(tile, "border-accent/25 bg-[linear-gradient(155deg,rgb(124_77_255/0.26),rgb(124_77_255/0.05)_70%)]")}
      >
        <span className={cx(chip, "bg-accent-strong text-white shadow-accent")}>
          <Upload />
        </span>
        <span className="min-w-0">
          <span className={label}>Import</span>
          <span className={sub}>PDFs and photos</span>
        </span>
      </button>
      <button type="button" onClick={onNewFolder} className={tile}>
        <span className={cx(chip, "bg-white/7 text-ink")}>
          <FolderPlus />
        </span>
        <span className="min-w-0">
          <span className={label}>Folder</span>
          <span className={cx(sub, "tabular-nums")}>{folderCount ? plural(folderCount, "folder") : "Organize"}</span>
        </span>
      </button>
      <Link href="/starred" className={tile}>
        <span className={cx(chip, "bg-white/7 text-warn")}>
          <Star />
        </span>
        <span className="min-w-0">
          <span className={label}>Starred</span>
          <span className={sub}>Quick access</span>
        </span>
      </Link>
    </div>
  );
}
