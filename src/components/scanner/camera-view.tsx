"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Camera, Images, Layers, Loader2, Zap, ZapOff, X, Wand2, ImagePlus, Check, SwitchCamera } from "lucide-react";
import { cx } from "@/lib/client/format";
import { vibrate } from "@/lib/client/device";
import { getEngine, type Quad } from "@/lib/client/scanner/engine";
import { diag } from "@/lib/client/scanner/diagnostics";

export interface Captured {
  blob: Blob;
  width: number;
  height: number;
  quad: Quad | null;
}

type CamState =
  | { kind: "starting" }
  | { kind: "live" }
  | { kind: "denied"; message: string }
  | { kind: "unavailable"; message: string };

const DETECT_EDGE = 360;
const DETECT_INTERVAL = 110; // ~9 fps
const STABLE_FRAMES = 9;

/* ------------------------------ lens choice ------------------------------ */

// Secondary lenses we never pick by default: they crop (tele/zoom), distort
// (ultra-wide/fisheye) or are not real cameras (depth/IR).
const SECONDARY_LENS = /tele|zoom|macro|depth|infrared|\bir\b|ultra|fisheye|\b0[.,]5|uw\b/i;
const BACK_LENS = /back|rear|environment|world|camera2 \d+, facing back/i;

export interface Lens {
  id: string;
  label: string;
}

/** Back cameras, main wide lens first (Android "camera2 0" is the main one). */
export function rankBackLenses(devices: MediaDeviceInfo[], currentId?: string): Lens[] {
  const backs = devices.filter((d) => d.kind === "videoinput" && BACK_LENS.test(d.label));
  const score = (d: MediaDeviceInfo) => {
    let s = 0;
    if (SECONDARY_LENS.test(d.label)) s += 100;
    const n = /camera2 (\d+)/.exec(d.label);
    if (n) s += Number(n[1]);
    if (d.deviceId === currentId) s -= 0.5;
    return s;
  };
  return backs
    .slice()
    .sort((a, b) => score(a) - score(b))
    .map((d, i) => ({ id: d.deviceId, label: lensName(d.label, i) }));
}

function lensName(label: string, i: number) {
  if (/tele|zoom/i.test(label)) return "Telephoto";
  if (/ultra|0[.,]5|uw\b/i.test(label)) return "Ultra wide";
  if (/macro/i.test(label)) return "Macro";
  return i === 0 ? "Main" : `Camera ${i + 1}`;
}

/**
 * Documents are 4:3-ish and phone sensors are 4:3. A plain "ideal 4K" request
 * makes Chrome pick a 16:9 (often stabilised, extra-cropped) mode, which looks
 * zoomed in. So try, in order: a native (resizeMode none, no browser crop)
 * 4:3 mode in landscape or portrait orientation, then any uncropped native
 * mode, then whatever the browser offers.
 */
function videoAttempts(deviceId?: string): MediaTrackConstraints[] {
  const base: MediaTrackConstraints = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: "environment" } };
  const native = { resizeMode: "none" } as MediaTrackConstraints;
  return [
    { ...base, ...native, aspectRatio: { min: 1.3, max: 1.37 }, width: { ideal: 3264 }, height: { ideal: 2448 } },
    { ...base, ...native, aspectRatio: { min: 0.73, max: 0.77 }, width: { ideal: 2448 }, height: { ideal: 3264 } },
    { ...base, ...native, width: { ideal: 3264 }, height: { ideal: 2448 } },
    { ...base, width: { ideal: 1920 }, height: { ideal: 1440 } },
  ];
}

/** Index of the constraint set the last openCamera() succeeded with (diagnostics). */
let lastAttempt = -1;

async function openCamera(deviceId?: string): Promise<MediaStream> {
  let last: unknown = null;
  for (const [i, video] of videoAttempts(deviceId).entries()) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: false, video });
      const mode = (s.getVideoTracks()[0]?.getSettings() as MediaTrackSettings & { resizeMode?: string }).resizeMode;
      // A browser that crops to satisfy the aspect would make it worse: next.
      if ("resizeMode" in video && mode && mode !== "none") {
        s.getTracks().forEach((t) => t.stop());
        continue;
      }
      lastAttempt = i;
      return s;
    } catch (e) {
      last = e;
      const name = e instanceof DOMException ? e.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") throw e;
    }
  }
  throw last;
}

type ZoomCaps = MediaTrackCapabilities & { zoom?: { min: number; max: number }; torch?: boolean; focusMode?: string[] };

/** Undo any default digital zoom: 1x (or the widest the lens allows above it). */
async function resetZoom(track: MediaStreamTrack) {
  const caps = (track.getCapabilities?.() ?? {}) as ZoomCaps;
  if (!caps.zoom) return;
  const target = caps.zoom.min <= 1 && caps.zoom.max >= 1 ? 1 : caps.zoom.min;
  const cur = (track.getSettings() as MediaTrackSettings & { zoom?: number }).zoom;
  if (cur !== undefined && Math.abs(cur - target) < 0.01) return;
  await track.applyConstraints({ advanced: [{ zoom: target } as MediaTrackConstraintSet] }).catch(() => {});
}

type ImageCaptureLike = { takePhoto: (s?: Record<string, unknown>) => Promise<Blob> };

/**
 * ImageCapture.takePhoto() is fast on some phones and slow or hanging on others (it reconfigures the camera; some
 * Android WebView/camera HAL combinations never resolve). After one timeout, failure or mismatched photo on a lens,
 * captures on that lens use the video frame straight away instead of waiting again (remembered on this device for a
 * week, then tried once more: browser and camera updates change this).
 */
const STILL_TIMEOUT_MS = 2500;
const STILL_OFF_KEY = "waraq:still-off";
const STILL_OFF_TTL = 7 * 86400_000;
type StillOffMap = Record<string, { why: string; at: number }>;
function stillOff(label: string): string | null {
  try {
    const e = (JSON.parse(window.localStorage.getItem(STILL_OFF_KEY) || "{}") as StillOffMap)[label];
    return e && typeof e.at === "number" && Date.now() - e.at < STILL_OFF_TTL ? e.why : null;
  } catch {
    return null;
  }
}
function setStillOff(label: string, why: string) {
  try {
    const m = JSON.parse(window.localStorage.getItem(STILL_OFF_KEY) || "{}") as StillOffMap;
    m[label] = { why, at: Date.now() };
    window.localStorage.setItem(STILL_OFF_KEY, JSON.stringify(m));
  } catch {
    /* ignore */
  }
}

/**
 * Full-resolution still via ImageCapture when it shows the same field of view
 * as the preview (same aspect), so the live edge quad still lines up. Returns
 * null to fall back to the video frame.
 */
async function takeStill(
  track: MediaStreamTrack,
  v: HTMLVideoElement,
  torchOn: boolean,
): Promise<{ blob: Blob; width: number; height: number } | { skipped: string; ms?: number }> {
  const IC = (window as unknown as { ImageCapture?: new (t: MediaStreamTrack) => ImageCaptureLike }).ImageCapture;
  if (!IC) return { skipped: "no ImageCapture" };
  if (torchOn) return { skipped: "torch" };
  const lens = track.label || "default";
  const off = stillOff(lens);
  if (off) return { skipped: `off (${off})` };
  const t0 = performance.now();
  try {
    const ic = new IC(track);
    const photo = await Promise.race([
      ic.takePhoto({ fillLightMode: "off" }).catch(() => ic.takePhoto()),
      new Promise<null>((r) => window.setTimeout(() => r(null), STILL_TIMEOUT_MS)),
    ]);
    if (!photo) {
      setStillOff(lens, "timeout");
      return { skipped: "timeout", ms: Math.round(performance.now() - t0) };
    }
    const bmp = await createImageBitmap(photo, { imageOrientation: "from-image" });
    try {
      const va = v.videoWidth / v.videoHeight;
      const pa = bmp.width / bmp.height;
      if (Math.abs(pa / va - 1) > 0.025 || Math.max(bmp.width, bmp.height) <= Math.max(v.videoWidth, v.videoHeight)) {
        // different field of view or no more pixels than the preview: never worth the wait on this lens
        setStillOff(lens, "no gain");
        return { skipped: "no gain", ms: Math.round(performance.now() - t0) };
      }
      const s = Math.min(1, 4000 / Math.max(bmp.width, bmp.height));
      const c = document.createElement("canvas");
      c.width = Math.round(bmp.width * s);
      c.height = Math.round(bmp.height * s);
      const ctx = c.getContext("2d")!;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/jpeg", 0.92));
      const out = blob ? { blob, width: c.width, height: c.height } : null;
      c.width = c.height = 0;
      return out ?? { skipped: "encode failed" };
    } finally {
      bmp.close();
    }
  } catch {
    setStillOff(lens, "error");
    return { skipped: "error", ms: Math.round(performance.now() - t0) };
  }
}

export function useEngineStatus() {
  const e = getEngine();
  return useSyncExternalStore(e.subscribe, e.getStatus, e.getStatus);
}

/**
 * Full-screen camera with live edge detection overlay, torch, batch and
 * auto-capture. Falls back to file inputs when no camera is available.
 */
export function CameraView({
  pageCount,
  lastThumb,
  batch,
  onBatchChange,
  onCapture,
  onFiles,
  onDone,
  onClose,
  retaking,
  autoCaptureDefault = false,
}: {
  pageCount: number;
  lastThumb: string | null;
  batch: boolean;
  onBatchChange: (b: boolean) => void;
  onCapture: (c: Captured) => void;
  onFiles: (files: File[]) => void;
  onDone: () => void;
  onClose: () => void;
  retaking: boolean;
  /** Initial state of the auto-capture toggle (Settings > Scanner). */
  autoCaptureDefault?: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [cam, setCam] = useState<CamState>({ kind: "starting" });
  const [torch, setTorch] = useState<{ supported: boolean; on: boolean }>({ supported: false, on: false });
  const [quad, setQuad] = useState<Quad | null>(null);
  const [auto, setAuto] = useState(autoCaptureDefault);
  const [stableProgress, setStableProgress] = useState(0);
  const [flash, setFlash] = useState(0);
  const [capturing, setCapturing] = useState(false);
  const [dims, setDims] = useState({ cw: 0, ch: 0, vw: 0, vh: 0 });
  const [lenses, setLenses] = useState<Lens[]>([]);
  const [lensId, setLensId] = useState<string | undefined>(undefined);
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const engineStatus = useEngineStatus();
  const galleryInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);

  const missed = useRef(0);

  const smoothed = useRef<Quad | null>(null);
  const history = useRef<Quad[]>([]);
  const cooldownUntil = useRef(0);
  const captureRef = useRef<() => void>(() => {});

  /* ----------------------------- diagnostics ---------------------------- */
  useEffect(() => {
    diag.scannerOpened();
    const e = getEngine();
    if (e.ready && e.timings) diag.engineReady({ ...e.timings, warm: true });
    return () => diag.flush();
  }, []);

  /* ---------------------------- start camera ---------------------------- */
  useEffect(() => {
    let cancelled = false;
    const tOpen = performance.now();
    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCam({ kind: "unavailable", message: "This browser does not allow camera access here. Use a photo instead." });
        return;
      }
      try {
        let s: MediaStream;
        try {
          s = await openCamera(lensId);
        } catch (e) {
          if (!lensId || (e instanceof DOMException && e.name === "NotAllowedError")) throw e;
          s = await openCamera();
        }
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        let track = s.getVideoTracks()[0];
        // Labels are only readable after permission. If the browser handed us a
        // tele/ultra-wide lens for "environment", reopen on the main back lens.
        const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
        const currentId = track.getSettings().deviceId;
        const ranked = rankBackLenses(devices, currentId);
        if (!lensId && ranked.length > 1 && currentId && ranked[0].id !== currentId && SECONDARY_LENS.test(track.label)) {
          try {
            const main = await openCamera(ranked[0].id);
            s.getTracks().forEach((t) => t.stop());
            s = main;
            track = s.getVideoTracks()[0];
          } catch {
            /* keep the first stream */
          }
        }
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream.current = s;
        setLenses(ranked);
        setActiveId(track.getSettings().deviceId);
        await resetZoom(track);
        const v = video.current;
        if (v) {
          v.srcObject = s;
          await v.play().catch(() => {});
        }
        const caps = (track.getCapabilities?.() ?? {}) as ZoomCaps;
        setTorch({ supported: !!caps.torch, on: false });
        if (caps.focusMode?.includes("continuous")) {
          track.applyConstraints({ advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet] }).catch(() => {});
        }
        setCam({ kind: "live" });
        diag.cameraReady(track, { attempt: lastAttempt, openMs: Math.round(performance.now() - tOpen) });
      } catch (e) {
        const name = e instanceof DOMException ? e.name : "";
        if (name === "NotAllowedError" || name === "SecurityError")
          setCam({ kind: "denied", message: "Camera permission was denied. Allow it in site settings, or use a photo instead." });
        else
          setCam({ kind: "unavailable", message: "No camera could be opened. You can still take or pick a photo." });
      }
    };
    void start();
    void getEngine().init().catch(() => {});
    return () => {
      cancelled = true;
      stream.current?.getTracks().forEach((t) => t.stop());
      stream.current = null;
    };
  }, [lensId]);

  const activeLens = activeId ?? lensId ?? lenses[0]?.id;
  const switchLens = () => {
    if (lenses.length < 2) return;
    const i = Math.max(0, lenses.findIndex((l) => l.id === activeLens));
    const next = lenses[(i + 1) % lenses.length];
    smoothed.current = null;
    history.current = [];
    setQuad(null);
    setCam({ kind: "starting" });
    setLensId(next.id);
  };
  const lensLabel = lenses.find((l) => l.id === activeLens)?.label;

  /* --------------------------- layout tracking -------------------------- */
  useEffect(() => {
    const el = box.current;
    const v = video.current;
    if (!el || !v) return;
    const update = () => setDims({ cw: el.clientWidth, ch: el.clientHeight, vw: v.videoWidth, vh: v.videoHeight });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    v.addEventListener("loadedmetadata", update);
    v.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      v.removeEventListener("loadedmetadata", update);
      v.removeEventListener("resize", update);
    };
  }, []);

  /* ---------------------------- detection loop -------------------------- */
  useEffect(() => {
    if (cam.kind !== "live" || engineStatus.state !== "ready") return;
    let stop = false;
    let timer = 0;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const tick = async () => {
      if (stop) return;
      const v = video.current;
      const t0 = performance.now();
      if (v && ctx && v.videoWidth && document.visibilityState === "visible" && !capturing) {
        const s = DETECT_EDGE / Math.max(v.videoWidth, v.videoHeight);
        const w = Math.round(v.videoWidth * s);
        const h = Math.round(v.videoHeight * s);
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
        try {
          // UI-thread part (frame readback + downscale) vs worker part, for the diagnostics
          ctx.drawImage(v, 0, 0, w, h);
          const img = ctx.getImageData(0, 0, w, h);
          const prep = performance.now() - t0;
          const { result: r, ms: workerMs } = await getEngine().detectFrame(img);
          diag.frame(prep, workerMs, performance.now() - t0);
          if (stop) return;
          if (r) {
            missed.current = 0;
            const prev = smoothed.current;
            // jump straight to a quad that moved a lot (new page / big pan),
            // otherwise ease towards it; the smoothing gets stronger the
            // smaller the change so a still page does not jitter
            const moved = prev ? Math.max(...r.quad.map((p, i) => Math.hypot(p[0] - prev[i][0], p[1] - prev[i][1]))) : 1;
            const a = moved > 0.12 ? 1 : moved > 0.03 ? 0.55 : 0.3;
            const next = (prev
              ? r.quad.map((p, i) => [prev[i][0] + (p[0] - prev[i][0]) * a, prev[i][1] + (p[1] - prev[i][1]) * a])
              : r.quad) as Quad;
            smoothed.current = next;
            history.current = [...history.current.slice(-(STABLE_FRAMES - 1)), r.quad];
            setQuad(next);
          } else if (smoothed.current && ++missed.current <= 2) {
            // a frame or two without a detection (motion blur, glare): keep
            // showing the last outline instead of flickering
          } else {
            smoothed.current = null;
            history.current = [];
            setQuad(null);
          }
          // stability for auto-capture
          const hist = history.current;
          let stable = 0;
          if (hist.length >= 2) {
            const last = hist[hist.length - 1];
            for (let i = hist.length - 2; i >= 0; i--) {
              const moved = Math.max(...hist[i].map((p, k) => Math.hypot(p[0] - last[k][0], p[1] - last[k][1])));
              if (moved > 0.018) break;
              stable++;
            }
          }
          setStableProgress(Math.min(1, stable / (STABLE_FRAMES - 1)));
          if (auto && stable >= STABLE_FRAMES - 1 && Date.now() > cooldownUntil.current) {
            cooldownUntil.current = Date.now() + 2500;
            history.current = [];
            captureRef.current();
          }
        } catch {
          /* engine busy or failed for a frame */
        }
      }
      const elapsed = performance.now() - t0;
      timer = window.setTimeout(tick, Math.max(16, DETECT_INTERVAL - elapsed));
    };
    timer = window.setTimeout(tick, 50);
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [cam.kind, engineStatus.state, auto, capturing]);

  /* ------------------------------- capture ------------------------------- */
  const capture = useCallback(async () => {
    const v = video.current;
    if (!v || !v.videoWidth || capturing) return;
    setCapturing(true);
    vibrate(30, "heavy");
    setFlash((f) => f + 1);
    const quadAtShutter = smoothed.current;
    const t0 = performance.now();
    try {
      const track = stream.current?.getVideoTracks()[0];
      const still = track ? await takeStill(track, v, torch.on) : { skipped: "no track" };
      if ("blob" in still) {
        diag.capture({ path: "still", stillMs: Math.round(performance.now() - t0), totalMs: Math.round(performance.now() - t0), width: still.width, height: still.height });
        onCapture({ ...still, quad: quadAtShutter });
        return;
      }
      // Native-resolution video frame: exactly what the preview shows.
      const c = document.createElement("canvas");
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      c.getContext("2d")!.drawImage(v, 0, 0, v.videoWidth, v.videoHeight);
      const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/jpeg", 0.92));
      diag.capture({ path: "frame", stillMs: still.ms, stillSkipped: still.skipped, totalMs: Math.round(performance.now() - t0), width: c.width, height: c.height });
      if (blob) onCapture({ blob, width: c.width, height: c.height, quad: quadAtShutter });
      c.width = c.height = 0;
    } finally {
      setCapturing(false);
    }
  }, [capturing, onCapture, torch.on]);
  useEffect(() => {
    captureRef.current = () => void capture();
  });

  const toggleTorch = async () => {
    const track = stream.current?.getVideoTracks()[0];
    if (!track) return;
    const on = !torch.on;
    try {
      await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
      setTorch({ supported: true, on });
    } catch {
      setTorch({ supported: false, on: false });
    }
  };

  /* ------------------------------- overlay ------------------------------- */
  const { cw, ch, vw, vh } = dims;
  let overlay: string | null = null;
  if (quad && vw && vh && cw && ch) {
    // the preview is letterboxed (object-contain): map into the drawn video rect
    const sc = Math.min(cw / vw, ch / vh);
    const dw = vw * sc;
    const dh = vh * sc;
    const ox = (cw - dw) / 2;
    const oy = (ch - dh) / 2;
    overlay = quad.map((p) => `${ox + p[0] * dw},${oy + p[1] * dh}`).join(" ");
  }

  const fileInputs = (
    <>
      <input
        ref={galleryInput}
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
      <input
        ref={cameraInput}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const f = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (f.length) onFiles(f);
        }}
      />
    </>
  );

  const loadingEngine = engineStatus.state === "loading";
  const pct = engineStatus.total ? Math.round((engineStatus.loaded / engineStatus.total) * 100) : 0;

  return (
    // data-haptic-zone="off": no global tap haptics in the viewfinder (the shutter has its own)
    <div className="fixed inset-0 flex flex-col bg-black text-white" data-haptic-zone="off">
      {fileInputs}
      {/* top bar */}
      <div className="absolute inset-x-0 top-0 z-20 flex items-center gap-2 bg-gradient-to-b from-black/70 to-transparent px-2 pt-[calc(var(--sat)+6px)] pb-8">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close scanner"
          className="focus-ring inline-flex size-11 items-center justify-center rounded-lg hover:bg-white/10"
        >
          <X className="size-6" />
        </button>
        <div className="min-w-0 flex-1 truncate text-center text-[13px] font-medium text-white/80">
          {retaking ? "Retake page" : cam.kind === "live" ? (quad ? "Document found" : "Point at a document") : ""}
        </div>
        {lenses.length > 1 && cam.kind !== "denied" && cam.kind !== "unavailable" && (
          <button
            type="button"
            onClick={switchLens}
            aria-label={`Switch lens${lensLabel ? ` (now ${lensLabel})` : ""}`}
            title="Switch lens"
            className="focus-ring inline-flex h-11 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium hover:bg-white/10"
          >
            <SwitchCamera className="size-5" />
            {lensLabel && <span className="max-w-[72px] truncate">{lensLabel}</span>}
          </button>
        )}
        {torch.supported ? (
          <button
            type="button"
            onClick={toggleTorch}
            aria-label={torch.on ? "Turn flash off" : "Turn flash on"}
            className={cx(
              "focus-ring inline-flex size-11 items-center justify-center rounded-lg",
              torch.on ? "bg-white text-black" : "hover:bg-white/10",
            )}
          >
            {torch.on ? <Zap className="size-5" /> : <ZapOff className="size-5" />}
          </button>
        ) : (
          <span className="size-11" />
        )}
      </div>

      {/* viewfinder */}
      <div ref={box} className="relative min-h-0 flex-1 overflow-hidden">
        <video
          ref={video}
          playsInline
          muted
          autoPlay
          className={cx("absolute inset-0 size-full object-contain", cam.kind !== "live" && "opacity-0")}
        />
        {overlay && (
          <svg className="pointer-events-none absolute inset-0 size-full" width={cw} height={ch}>
            <polygon
              points={overlay}
              fill="rgb(124 77 255 / 0.2)"
              stroke="#b9a6ff"
              strokeWidth={3}
              strokeLinejoin="round"
              className="transition-all duration-100"
            />
          </svg>
        )}
        {flash > 0 && <div key={flash} className="pointer-events-none absolute inset-0 bg-white opacity-0" style={{ animation: "shutter 300ms ease-out" }} />}

        {cam.kind === "starting" && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="size-8 animate-spin text-white/60" />
          </div>
        )}
        {(cam.kind === "denied" || cam.kind === "unavailable") && (
          <div className="absolute inset-0 flex flex-col items-center justify-center px-8 text-center">
            <div className="mb-5 flex size-12 items-center justify-center rounded-xl bg-white/8">
              <Camera className="size-6 text-white/80" />
            </div>
            <h2 className="text-[22px] leading-tight font-semibold tracking-[-0.01em]">
              {cam.kind === "denied" ? "Camera is blocked" : "No camera here"}
            </h2>
            <p className="mt-2 max-w-xs text-sm text-white/65">{cam.message}</p>
            <div className="mt-7 flex w-full max-w-xs flex-col gap-2">
              <button
                type="button"
                onClick={() => cameraInput.current?.click()}
                className="focus-ring flex h-12 items-center justify-center gap-2 rounded-xl bg-accent-strong text-[15px] font-medium"
              >
                <Camera className="size-5" /> Take a photo
              </button>
              <button
                type="button"
                onClick={() => galleryInput.current?.click()}
                className="focus-ring flex h-12 items-center justify-center gap-2 rounded-xl bg-white/10 text-[15px] font-medium"
              >
                <ImagePlus className="size-5" /> Choose from gallery
              </button>
            </div>
          </div>
        )}

        {loadingEngine && cam.kind === "live" && (
          <div className="absolute inset-x-0 bottom-4 flex justify-center">
            <div className="flex items-center gap-2 rounded-lg bg-black/70 px-3 py-1.5 text-[13px] text-white/85">
              <Loader2 className="size-3.5 animate-spin" />
              {pct >= 100 ? "Preparing edge detection" : `Loading edge detection${pct ? ` ${pct}%` : ""}`}
            </div>
          </div>
        )}
      </div>

      {/* controls */}
      <div className="relative z-20 bg-black px-4 pt-3 pb-[calc(var(--sab)+18px)]">
        <div className="mb-3 flex justify-center gap-2">
          <ModePill active={batch} onClick={() => onBatchChange(!batch)} icon={<Layers className="size-3.5" />}>
            Batch
          </ModePill>
          <ModePill
            active={auto}
            onClick={() => setAuto(!auto)}
            icon={<Wand2 className="size-3.5" />}
            disabled={engineStatus.state !== "ready" || cam.kind !== "live"}
          >
            Auto capture
          </ModePill>
        </div>
        <div className="mx-auto flex max-w-md items-center justify-between">
          <button
            type="button"
            onClick={() => galleryInput.current?.click()}
            aria-label="Import from gallery"
            className="focus-ring flex size-14 items-center justify-center rounded-2xl bg-white/8 hover:bg-white/14"
          >
            <Images className="size-6" />
          </button>
          <button
            type="button"
            onClick={() => (cam.kind === "live" ? void capture() : cameraInput.current?.click())}
            disabled={capturing || cam.kind === "starting"}
            aria-label="Capture page"
            data-haptic="none"
            className="focus-ring relative flex size-[78px] items-center justify-center rounded-full disabled:opacity-60"
          >
            <svg className="absolute inset-0 -rotate-90" viewBox="0 0 78 78">
              <circle cx="39" cy="39" r="36" fill="none" stroke="rgb(255 255 255 / 0.9)" strokeWidth="4" />
              {auto && (
                <circle
                  cx="39"
                  cy="39"
                  r="36"
                  fill="none"
                  stroke="#8a5fff"
                  strokeWidth="4.5"
                  strokeLinecap="round"
                  strokeDasharray={`${stableProgress * 226} 226`}
                  className="transition-[stroke-dasharray] duration-100"
                />
              )}
            </svg>
            <span
              className={cx(
                "size-[62px] rounded-full bg-white transition-transform duration-100 active:scale-90",
                capturing && "scale-90",
              )}
            />
          </button>
          {pageCount > 0 ? (
            <button
              type="button"
              onClick={onDone}
              aria-label={`Review ${pageCount} pages`}
              className="focus-ring relative size-14 overflow-hidden rounded-2xl border-2 border-white/80 bg-white/10"
            >
              {lastThumb && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={lastThumb} alt="" className="size-full object-cover" />
              )}
              <span className="absolute -top-0 -right-0 flex h-5 min-w-5 items-center justify-center rounded-bl-md bg-accent-strong px-1 text-[11px] font-semibold tabular-nums">
                {pageCount}
              </span>
              <span className="absolute inset-x-0 bottom-0 flex items-center justify-center bg-black/55 py-0.5">
                <Check className="size-3.5" />
              </span>
            </button>
          ) : (
            <span className="size-14" />
          )}
        </div>
      </div>
    </div>
  );
}

function ModePill({
  active,
  onClick,
  icon,
  children,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cx(
        "focus-ring flex h-9 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium transition-colors disabled:opacity-40",
        active ? "bg-white text-black" : "bg-white/10 text-white/85 hover:bg-white/15",
      )}
    >
      {icon}
      {children}
    </button>
  );
}
