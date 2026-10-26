"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowLeft,
  Camera,
  Check,
  Crop,
  ImagePlus,
  Loader2,
  Maximize,
  MoreVertical,
  Plus,
  RotateCcw,
  RotateCw,
  ScanSearch,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { errorMessage } from "@/lib/client/api";
import { cx, scanTitle } from "@/lib/client/format";
import { vibrate } from "@/lib/client/device";
import {
  FILTERS,
  FULL_QUAD,
  getEngine,
  imageSize,
  type FilterName,
  type Quad,
  type Rotation,
} from "@/lib/client/scanner/engine";
import { usePrefs } from "@/lib/client/prefs";
import { enqueueScan } from "@/lib/client/upload-queue";
import { Menu } from "@/components/ui/primitives";
import { toast } from "@/components/ui/toast";
import { CameraView, useEngineStatus, type Captured } from "./camera-view";
import { CropEditor, quadIsValid } from "./crop-editor";

export type ScanTarget =
  | { kind: "new"; folderId?: string | null }
  | { kind: "append"; docId: string }
  | { kind: "replace"; docId: string; index: number };

interface ScanPage {
  id: string;
  blob: Blob;
  url: string;
  width: number;
  height: number;
  quad: Quad;
  detected: boolean;
  rotation: Rotation;
  filter: FilterName;
}

let pid = 0;
const newId = () => `p${Date.now().toString(36)}${++pid}`;
const paramsKey = (p: ScanPage) => `${p.id}|${p.quad.flat().map((n) => n.toFixed(4)).join(",")}|${p.rotation}|${p.filter}`;

export function Scanner({
  target,
  initial,
  startWithImport,
}: {
  target: ScanTarget;
  /** Pre-loaded page (edit mode). */
  initial?: { blob: Blob; width: number; height: number };
  startWithImport?: boolean;
}) {
  const router = useRouter();
  // warm the destination route so closing the scanner on Save is instant
  useEffect(() => {
    if (target.kind === "new") router.prefetch("/p/_");
    else router.prefetch(`/d/${target.docId}`);
  }, [router, target]);
  const [pages, setPages] = useState<ScanPage[]>(() =>
    initial
      ? [
          {
            id: newId(),
            blob: initial.blob,
            url: URL.createObjectURL(initial.blob),
            width: initial.width,
            height: initial.height,
            quad: FULL_QUAD,
            detected: false,
            rotation: 0,
            filter: "original",
          },
        ]
      : [],
  );
  const [screen, setScreen] = useState<"camera" | "review" | "import">(
    initial ? "review" : startWithImport ? "import" : "camera",
  );
  const [current, setCurrent] = useState(0);
  const [retakeId, setRetakeId] = useState<string | null>(null);
  // Scanner defaults come from the shared prefs (Settings > Scanner); toggles
  // made while scanning only last for this session.
  const prefs = usePrefs().scanner;
  const [batchOverride, setBatchOverride] = useState<boolean | null>(null);
  const batch = batchOverride ?? prefs.batchMode;
  const [sessionFilter, setLastFilter] = useState<FilterName | null>(null);
  const lastFilter: FilterName = sessionFilter ?? prefs.defaultFilter;
  const autoCrop = prefs.autoCrop;
  const pagesRef = useRef(pages);
  useEffect(() => {
    pagesRef.current = pages;
  });

  // revoke object URLs on real unmount (deferred so StrictMode's simulated
  // unmount/remount does not kill URLs that state still references)
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.setTimeout(() => {
        if (!mounted.current) pagesRef.current.forEach((p) => URL.revokeObjectURL(p.url));
      }, 0);
    };
  }, []);

  // edit mode: try auto-detecting edges on the stored page too
  useEffect(() => {
    if (!initial) return;
    void getEngine().init().catch(() => {});
  }, [initial]);

  const updatePage = (id: string, patch: Partial<ScanPage>) =>
    setPages((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p)));

  const detectFor = async (id: string, blob: Blob) => {
    if (!autoCrop) return;
    try {
      const r = await getEngine().detectBlob(blob);
      if (r) {
        // r.rotation (text-direction upright guess) is not applied: on real
        // scans it was right about as often as wrong for Arabic pages; the
        // server's OCR (--rotate-pages) handles orientation instead.
        setPages((ps) => ps.map((p) => (p.id === id && !p.detected ? { ...p, quad: r.quad, detected: true } : p)));
      }
    } catch {
      /* keep the live or full-frame quad */
    }
  };

  const addCaptured = (c: Captured) => {
    const page: ScanPage = {
      id: newId(),
      blob: c.blob,
      url: URL.createObjectURL(c.blob),
      width: c.width,
      height: c.height,
      quad: (autoCrop && c.quad) || FULL_QUAD,
      detected: false,
      rotation: 0,
      filter: target.kind === "replace" ? "original" : lastFilter,
    };
    if (retakeId) {
      const idx = pages.findIndex((p) => p.id === retakeId);
      setPages((ps) =>
        ps.map((p) => {
          if (p.id !== retakeId) return p;
          URL.revokeObjectURL(p.url);
          return { ...page, id: p.id, filter: p.filter };
        }),
      );
      void detectFor(retakeId, c.blob);
      setRetakeId(null);
      setCurrent(Math.max(0, idx));
      setScreen("review");
      return;
    }
    setPages((ps) => [...ps, page]);
    void detectFor(page.id, c.blob);
    if (!batch || target.kind === "replace") {
      setCurrent(pages.length);
      setScreen("review");
    }
  };

  const addFiles = async (files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith("image/") || /\.(jpe?g|png|webp|heic)$/i.test(f.name));
    if (!imgs.length) return;
    const added: ScanPage[] = [];
    for (const f of imgs) {
      try {
        const { width, height } = await imageSize(f);
        added.push({
          id: newId(),
          blob: f,
          url: URL.createObjectURL(f),
          width,
          height,
          quad: FULL_QUAD,
          detected: false,
          rotation: 0,
          filter: lastFilter,
        });
      } catch {
        toast.error(`Could not read ${f.name}`);
      }
    }
    if (!added.length) return;
    if (retakeId && added[0]) {
      const r = added[0];
      setPages((ps) => ps.map((p) => (p.id === retakeId ? { ...r, id: p.id } : p)));
      void detectFor(retakeId, r.blob);
      setRetakeId(null);
      setScreen("review");
      return;
    }
    const start = pages.length;
    setPages((ps) => [...ps, ...added]);
    added.forEach((p) => void detectFor(p.id, p.blob));
    setCurrent(start);
    setScreen("review");
  };

  const removePage = (id: string) => {
    const idx = pages.findIndex((p) => p.id === id);
    const p = pages[idx];
    if (!p) return;
    URL.revokeObjectURL(p.url);
    const next = pages.filter((x) => x.id !== id);
    setPages(next);
    setCurrent((c) => Math.max(0, Math.min(c >= idx ? c - 1 : c, next.length - 1)));
    if (next.length === 0) setScreen(target.kind === "replace" ? "review" : "camera");
  };

  const close = () => {
    if (target.kind === "new") router.push("/");
    else router.push(`/d/${target.docId}`);
  };

  /**
   * Hand the pages to the background queue and leave at once: the worker
   * enhances + uploads them while the user is already on the document (or
   * its pending page for a new scan). Nothing here waits for the engine.
   */
  const save = () => {
    if (!pages.length) return;
    const invalid = pages.findIndex((p) => !quadIsValid(p.quad));
    if (invalid >= 0) {
      setCurrent(invalid);
      toast.error(`Page ${invalid + 1} has crossed corners. Fix the crop first.`);
      return;
    }
    const n = pages.length;
    let item;
    try {
      item = enqueueScan({
        target,
        title:
          target.kind === "new" ? scanTitle() : target.kind === "append" ? `Adding ${n} ${n === 1 ? "page" : "pages"}` : `Page ${target.index + 1}`,
        pages: pages.map((p) => ({
          id: p.id,
          blob: p.blob,
          width: p.width,
          height: p.height,
          quad: p.quad,
          rotation: p.rotation,
          filter: p.filter,
        })),
        maxEdge: 3000,
        quality: Math.min(0.95, Math.max(0.6, prefs.jpegQuality || 0.85)),
        deskew: true,
      });
    } catch (e) {
      toast.error(errorMessage(e, "Could not save. Your pages are still here."));
      return;
    }
    vibrate([12, 40, 12], "success");
    // the queue keeps the blobs; our preview URLs can go
    pages.forEach((p) => URL.revokeObjectURL(p.url));
    setPages([]);
    if (target.kind === "new") router.replace(item.href);
    else {
      toast(target.kind === "append" ? `Adding ${n} ${n === 1 ? "page" : "pages"} in the background` : "Updating the page in the background");
      router.replace(`/d/${target.docId}`);
    }
  };

  const safeCurrent = Math.min(current, Math.max(0, pages.length - 1));

  if (screen === "camera") {
    return (
      <CameraView
        pageCount={pages.length}
        lastThumb={pages.length ? pages[pages.length - 1].url : null}
        batch={batch}
        onBatchChange={(b) => setBatchOverride(b)}
        autoCaptureDefault={prefs.autoCapture}
        onCapture={addCaptured}
        onFiles={addFiles}
        onDone={() => {
          setCurrent(0);
          setScreen("review");
        }}
        onClose={() => {
          if (retakeId) {
            setRetakeId(null);
            setScreen("review");
          } else if (pages.length) setScreen("review");
          else close();
        }}
        retaking={!!retakeId}
      />
    );
  }

  if (screen === "import" || pages.length === 0) {
    return <ImportLanding onFiles={addFiles} onCamera={() => setScreen("camera")} onClose={close} autoOpen={screen === "import"} />;
  }

  return (
    <ReviewScreen
      target={target}
      pages={pages}
      current={safeCurrent}
      setCurrent={setCurrent}
      onUpdate={(id, patch) => {
        updatePage(id, patch);
        if (patch.filter) setLastFilter(patch.filter);
      }}
      onApplyFilterAll={(f) => setPages((ps) => ps.map((p) => ({ ...p, filter: f })))}
      onReorder={(from, to) => {
        setPages((ps) => arrayMove(ps, from, to));
        setCurrent(to);
      }}
      onRemove={removePage}
      onRetake={(id) => {
        setRetakeId(id);
        setScreen("camera");
      }}
      onAddMore={() => setScreen("camera")}
      onBack={() => {
        if (target.kind === "replace") close();
        else setScreen("camera");
      }}
      onSave={save}
    />
  );
}

/* ------------------------------------------------------------------ */

function ImportLanding({
  onFiles,
  onCamera,
  onClose,
  autoOpen,
}: {
  onFiles: (f: File[]) => void;
  onCamera: () => void;
  onClose: () => void;
  autoOpen: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!autoOpen) return;
    // Works when the navigation kept the user's tap activation; otherwise the buttons remain.
    try {
      input.current?.click();
    } catch {
      /* needs a user gesture */
    }
  }, [autoOpen]);
  return (
    <div className="fixed inset-0 flex flex-col bg-bg">
      <div className="flex items-center px-2 pt-[calc(var(--sat)+6px)]">
        <button type="button" onClick={onClose} aria-label="Close" className="focus-ring inline-flex size-11 items-center justify-center rounded-lg hover:bg-white/6">
          <X className="size-6" />
        </button>
      </div>
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const f = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (f.length) onFiles(f);
        }}
      />
      <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
        <div className="surface mb-6 flex size-14 items-center justify-center rounded-2xl text-accent">
          <ImagePlus className="size-6" />
        </div>
        <h1 className="display text-[34px] leading-[1.05]">Photos to scans</h1>
        <p className="mt-2 max-w-xs text-sm text-muted">
          Pick photos of documents. Edges are found automatically, then you can adjust, enhance and save them as one PDF.
        </p>
        <div className="mt-8 flex w-full max-w-xs flex-col gap-2">
          <button
            type="button"
            onClick={() => input.current?.click()}
            className="focus-ring flex h-12 items-center justify-center gap-2 rounded-xl bg-accent-strong bg-[linear-gradient(180deg,rgb(255_255_255/0.14),rgb(255_255_255/0))] text-[15px] font-semibold text-white shadow-glow hover:bg-accent-hover"
          >
            <ImagePlus className="size-5" /> Choose photos
          </button>
          <button type="button" onClick={onCamera} className="focus-ring flex h-12 items-center justify-center gap-2 rounded-xl border border-line-strong bg-s2 text-[15px] font-medium shadow-[inset_0_1px_0_rgb(255_255_255/0.05)] hover:bg-s3">
            <Camera className="size-5" /> Use camera
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function usePreview(page: ScanPage | undefined, maxEdge: number) {
  const status = useEngineStatus();
  const [state, setState] = useState<{ key: string; url: string } | null>(null);
  const urlRef = useRef<string | null>(null);
  const key = page ? paramsKey(page) : "";
  useEffect(() => {
    if (!page || status.state !== "ready") return;
    let cancelled = false;
    const t = window.setTimeout(async () => {
      try {
        const r = await getEngine().process(page.blob, {
          quad: page.quad,
          rotation: page.rotation,
          filter: page.filter,
          maxEdge,
          quality: 0.82,
        });
        if (cancelled) return;
        const url = URL.createObjectURL(r.blob);
        const old = urlRef.current;
        urlRef.current = url;
        setState({ key, url });
        if (old) window.setTimeout(() => URL.revokeObjectURL(old), 1000);
      } catch {
        /* ignore preview errors */
      }
    }, 140);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
    // page object identity changes on every update; key captures what matters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, status.state, maxEdge]);
  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );
  return { url: state?.url ?? null, fresh: state?.key === key, engine: status };
}

function FilterThumbs({ page, onPick }: { page: ScanPage; onPick: (f: FilterName) => void }) {
  const status = useEngineStatus();
  const baseKey = `${page.id}|${page.quad.flat().map((n) => n.toFixed(3)).join(",")}|${page.rotation}`;
  const [thumbs, setThumbs] = useState<{ key: string; urls: Partial<Record<FilterName, string>> }>({ key: "", urls: {} });
  useEffect(() => {
    if (status.state !== "ready") return;
    let cancelled = false;
    const made: string[] = [];
    const t = window.setTimeout(async () => {
      const urls: Partial<Record<FilterName, string>> = {};
      for (const f of FILTERS) {
        if (cancelled) break;
        try {
          const r = await getEngine().process(page.blob, { quad: page.quad, rotation: page.rotation, filter: f.value, maxEdge: 180, quality: 0.7 });
          const u = URL.createObjectURL(r.blob);
          made.push(u);
          urls[f.value] = u;
          if (!cancelled) setThumbs({ key: baseKey, urls: { ...urls } });
        } catch {
          /* ignore */
        }
      }
    }, 450);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
      window.setTimeout(() => made.forEach((u) => URL.revokeObjectURL(u)), 2000);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseKey, status.state]);
  const urls = thumbs.urls;
  return (
    <div className="no-scrollbar flex gap-2.5 overflow-x-auto px-4 py-1 sm:justify-center">
      {FILTERS.map((f) => {
        const active = page.filter === f.value;
        return (
          <button
            key={f.value}
            type="button"
            onClick={() => onPick(f.value)}
            className="focus-ring flex w-[62px] shrink-0 flex-col items-center gap-1.5 rounded-xl"
          >
            <span
              className={cx(
                "relative block h-[74px] w-[58px] overflow-hidden rounded-xl border-2 bg-s3 transition-colors",
                active ? "border-accent" : "border-transparent",
              )}
            >
              {urls[f.value] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={urls[f.value]} alt="" className="size-full object-cover" />
              ) : (
                <span className="skeleton absolute inset-0" />
              )}
              {f.value === "magic" && (
                <Sparkles className="absolute top-1 right-1 size-3.5 text-accent drop-shadow" />
              )}
            </span>
            <span className={cx("text-[11px] font-medium", active ? "text-accent" : "text-muted")}>{f.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function ReviewScreen({
  target,
  pages,
  current,
  setCurrent,
  onUpdate,
  onApplyFilterAll,
  onReorder,
  onRemove,
  onRetake,
  onAddMore,
  onBack,
  onSave,
}: {
  target: ScanTarget;
  pages: ScanPage[];
  current: number;
  setCurrent: (i: number) => void;
  onUpdate: (id: string, patch: Partial<ScanPage>) => void;
  onApplyFilterAll: (f: FilterName) => void;
  onReorder: (from: number, to: number) => void;
  onRemove: (id: string) => void;
  onRetake: (id: string) => void;
  onAddMore: () => void;
  onBack: () => void;
  onSave: () => void;
}) {
  const page = pages[current];
  const [tool, setTool] = useState<"crop" | "enhance">("crop");
  const preview = usePreview(page, 1400);
  const engine = useEngineStatus();
  const [detecting, setDetecting] = useState(false);
  const valid = page ? quadIsValid(page.quad) : true;

  const autoDetect = async () => {
    if (!page) return;
    setDetecting(true);
    try {
      const r = await getEngine().detectBlob(page.blob);
      if (r) {
        onUpdate(page.id, { quad: r.quad, detected: true });
        vibrate(10, "select");
      } else toast("No clear document edges found. Drag the corners instead.");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setDetecting(false);
    }
  };

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
  );
  const ids = useMemo(() => pages.map((p) => p.id), [pages]);
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    onReorder(ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id)));
  };

  if (!page) return null;
  const rotate = (d: 90 | -90) => onUpdate(page.id, { rotation: (((page.rotation + d) % 360) + 360) % 360 as Rotation });
  const engineLoading = engine.state === "loading";
  const pct = engine.total ? Math.round((engine.loaded / engine.total) * 100) : 0;

  return (
    <div className="fixed inset-0 flex flex-col bg-[#050506] text-ink">
      {/* top bar */}
      <div className="flex shrink-0 items-center gap-2 px-2 pt-[calc(var(--sat)+6px)] pb-2">
        <button
          type="button"
          onClick={onBack}
          aria-label={target.kind === "replace" ? "Cancel" : "Back to camera"}
          className="focus-ring inline-flex size-11 shrink-0 items-center justify-center rounded-xl hover:bg-white/6"
        >
          {target.kind === "replace" ? <X className="size-6" /> : <ArrowLeft className="size-6" />}
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold">
            {target.kind === "replace" ? "Edit page" : `Page ${current + 1} of ${pages.length}`}
          </p>
          <p className="truncate text-[13px] text-muted">
            {tool === "crop" ? (valid ? "Drag corners or edges to fit the page" : "Corners are crossed") : "Choose a look"}
          </p>
        </div>
        <button
          type="button"
          onClick={onSave}
          className="focus-ring inline-flex h-11 shrink-0 items-center gap-2 rounded-xl bg-accent-strong bg-[linear-gradient(180deg,rgb(255_255_255/0.14),rgb(255_255_255/0))] px-4 text-[15px] font-semibold text-white shadow-accent hover:bg-accent-hover disabled:opacity-60"
        >
          <Check className="size-5" />
          {target.kind === "replace" ? "Save" : target.kind === "append" ? "Add" : "Save"}
        </button>
      </div>

      {/* stage */}
      <div className="relative min-h-0 flex-1">
        {tool === "crop" ? (
          <CropEditor
            key={page.id}
            src={page.url}
            width={page.width}
            height={page.height}
            quad={page.quad}
            onChange={(q) => onUpdate(page.id, { quad: q, detected: true })}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center p-5">
            {preview.url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={preview.url}
                alt="Enhanced page preview"
                className={cx(
                  "max-h-full max-w-full rounded-sm object-contain shadow-[0_20px_60px_-10px_rgb(0_0_0)] transition-opacity",
                  preview.fresh ? "opacity-100" : "opacity-60",
                )}
              />
            ) : (
              <div className="flex flex-col items-center gap-3 text-sm text-muted">
                <Loader2 className="size-6 animate-spin text-accent" />
                {engineLoading ? `Loading image engine ${pct}%` : engine.state === "error" ? engine.error : "Enhancing…"}
              </div>
            )}
            {!preview.fresh && preview.url && (
              <Loader2 className="absolute top-4 right-4 size-5 animate-spin text-accent" />
            )}
          </div>
        )}
      </div>

      {/* tool options */}
      <div className="shrink-0 pt-2">
        {tool === "enhance" ? (
          <>
            <FilterThumbs page={page} onPick={(f) => onUpdate(page.id, { filter: f })} />
            {pages.length > 1 && (
              <div className="flex justify-center pt-1">
                <button
                  type="button"
                  onClick={() => {
                    onApplyFilterAll(page.filter);
                    toast.success(`${FILTERS.find((f) => f.value === page.filter)?.label} applied to all pages`);
                  }}
                  className="focus-ring h-9 rounded-full px-3 text-xs font-medium text-accent hover:bg-accent-tint"
                >
                  Apply to all pages
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="flex justify-center gap-2 px-4 py-1">
            <Chip onClick={autoDetect} disabled={engine.state !== "ready" || detecting} icon={detecting ? <Loader2 className="size-4 animate-spin" /> : <ScanSearch className="size-4" />}>
              {engine.state === "loading" ? `Engine ${pct}%` : "Auto detect"}
            </Chip>
            <Chip onClick={() => onUpdate(page.id, { quad: FULL_QUAD, detected: true })} icon={<Maximize className="size-4" />}>
              Full page
            </Chip>
          </div>
        )}
      </div>

      {/* toolbar */}
      {/* Fits 320px: tabs flex and truncate, at most two 44px icons beside them, the rest in a menu. */}
      <div className="mx-auto flex w-full max-w-lg min-w-0 shrink-0 items-center gap-1 px-3 pt-2.5">
        <div className="flex min-w-0 flex-1 rounded-2xl border border-line bg-s1 p-1">
          <ToolTab active={tool === "crop"} onClick={() => setTool("crop")} icon={<Crop className="size-4" />}>
            Crop
          </ToolTab>
          <ToolTab active={tool === "enhance"} onClick={() => setTool("enhance")} icon={<Sparkles className="size-4" />}>
            Enhance
          </ToolTab>
        </div>
        {target.kind === "replace" ? (
          <IconTool label="Rotate left" onClick={() => rotate(-90)}>
            <RotateCcw />
          </IconTool>
        ) : null}
        <IconTool label="Rotate right" onClick={() => rotate(90)}>
          <RotateCw />
        </IconTool>
        {target.kind !== "replace" && (
          <Menu
            label="More page actions"
            trigger={<MoreVertical />}
            items={[
              { icon: <RotateCcw />, label: "Rotate left", onClick: () => rotate(-90) },
              { icon: <Camera />, label: "Retake photo", onClick: () => onRetake(page.id) },
              { icon: <Trash2 />, label: "Delete page", tone: "danger", divider: true, onClick: () => onRemove(page.id) },
            ]}
          />
        )}
      </div>

      {/* tray */}
      {target.kind !== "replace" ? (
        <div className="shrink-0 pt-3 pb-[calc(var(--sab)+12px)]">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={ids} strategy={horizontalListSortingStrategy}>
              <div className="no-scrollbar flex gap-2 overflow-x-auto px-4">
                {pages.map((p, i) => (
                  <TrayItem
                    key={p.id}
                    page={p}
                    index={i}
                    active={i === current}
                    previewUrl={i === current ? preview.url : null}
                    onClick={() => setCurrent(i)}
                  />
                ))}
                <button
                  type="button"
                  onClick={onAddMore}
                  aria-label="Add more pages"
                  className="focus-ring flex h-[72px] w-[54px] shrink-0 items-center justify-center rounded-lg border border-line-strong bg-white/4 text-muted hover:text-ink"
                >
                  <Plus className="size-5" />
                </button>
              </div>
            </SortableContext>
          </DndContext>
        </div>
      ) : (
        <div className="h-[calc(var(--sab)+16px)] shrink-0" />
      )}

    </div>
  );
}

function TrayItem({
  page,
  index,
  active,
  previewUrl,
  onClick,
}: {
  page: ScanPage;
  index: number;
  active: boolean;
  previewUrl: string | null;
  onClick: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: page.id });
  return (
    <button
      ref={setNodeRef}
      type="button"
      onClick={onClick}
      {...attributes}
      {...listeners}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      aria-label={`Page ${index + 1}`}
      className={cx(
        "focus-ring relative h-[72px] w-[54px] shrink-0 touch-manipulation overflow-hidden rounded-xl border-2 bg-s3 shadow-paper [-webkit-touch-callout:none]",
        active ? "border-accent" : "border-transparent opacity-75",
        isDragging && "z-10 scale-110 opacity-90 shadow-xl",
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={previewUrl ?? page.url}
        alt=""
        draggable={false}
        className="size-full object-cover"
        style={!previewUrl && page.rotation ? { transform: `rotate(${page.rotation}deg)` } : undefined}
      />
      <span className="absolute bottom-0.5 left-0.5 rounded bg-black/60 px-1 font-mono text-[10px] text-white">{index + 1}</span>
    </button>
  );
}

function Chip({
  children,
  icon,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="focus-ring flex h-10 min-w-0 items-center gap-1.5 rounded-full border border-line bg-s2 px-4 text-[13px] font-medium whitespace-nowrap text-ink hover:bg-s3 disabled:opacity-50"
    >
      {icon}
      {children}
    </button>
  );
}

function ToolTab({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        "focus-ring flex h-10 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-xl px-2 text-[13px] font-medium transition-colors",
        active ? "bg-s4 text-ink shadow-[inset_0_1px_0_rgb(255_255_255/0.07),0_1px_3px_rgb(0_0_0/0.4)]" : "text-muted hover:text-ink",
      )}
    >
      <span className="shrink-0">{icon}</span>
      <span className="truncate">{children}</span>
    </button>
  );
}

function IconTool({
  label,
  onClick,
  children,
  danger,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cx(
        "focus-ring inline-flex size-11 shrink-0 items-center justify-center rounded-xl hover:bg-white/6 active:bg-white/10 [&_svg]:size-5",
        danger ? "text-danger" : "text-ink",
      )}
    >
      {children}
    </button>
  );
}
