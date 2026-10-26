"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, EyeOff, Trash2 } from "lucide-react";
import { copyText } from "@/lib/client/device";
import { clearDiagnostics, diagnosticsText, readDiagnostics, type ScanDiagSession } from "@/lib/client/scanner/diagnostics";
import { Group, Row } from "@/components/ui/primitives";
import { toast } from "@/components/ui/toast";

const VISIBLE_KEY = "waraq:diag-visible";

/** 5 taps on a version row within 3 s show the panel (remembered on this device until hidden). */
export function useDiagnosticsUnlock() {
  const [visible, setVisible] = useState(false);
  const taps = useRef<number[]>([]);
  useEffect(() => {
    try {
      // localStorage only exists on the client: read after mount
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (window.localStorage.getItem(VISIBLE_KEY) === "1") setVisible(true);
    } catch {
      /* ignore */
    }
  }, []);
  const tap = useCallback(() => {
    const now = Date.now();
    taps.current = [...taps.current.filter((t) => now - t < 3000), now];
    if (taps.current.length >= 5) {
      taps.current = [];
      setVisible(true);
      try {
        window.localStorage.setItem(VISIBLE_KEY, "1");
      } catch {
        /* ignore */
      }
      toast("Scanner diagnostics on");
    }
  }, []);
  const hide = useCallback(() => {
    setVisible(false);
    try {
      window.localStorage.removeItem(VISIBLE_KEY);
    } catch {
      /* ignore */
    }
  }, []);
  return { visible, tap, hide };
}

const ms = (n: number | undefined) => (n === undefined || n === null ? "–" : `${Math.round(n)} ms`);

function Line({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3 text-[13px]">
      <span className="shrink-0 text-muted">{k}</span>
      <span className="min-w-0 text-right font-mono text-[12px] break-words text-ink tabular-nums">{v}</span>
    </div>
  );
}

function SessionCard({ s }: { s: ScanDiagSession }) {
  const e = s.engine;
  const f = s.frames;
  const cam = s.camera;
  return (
    <div className="space-y-1 px-3.5 py-3">
      <div className="mb-1 text-[13px] font-medium text-ink">
        {new Date(s.at).toLocaleString()} · {s.env.app ? `App ${s.env.app}` : "Browser"}
        {s.env.sw ? " · SW" : ""}
      </div>
      <Line k="Open → camera live" v={ms(s.openToCameraMs)} />
      {cam && <Line k="Camera" v={`${cam.width ?? "?"}×${cam.height ?? "?"} @${cam.fps ?? "?"}fps #${cam.attempt ?? "?"}${cam.resizeMode ? ` ${cam.resizeMode}` : ""}`} />}
      <Line k="Open → edge detection ready" v={e?.warm ? "already warm" : ms(s.openToEngineMs)} />
      {e && !e.warm && (
        <Line
          k="Engine start"
          v={`${ms(e.ms)} (${e.cached ? "from cache" : "downloaded"}${e.streaming ? ", streaming" : ""}; wasm ${ms(e.wasmMs)})`}
        />
      )}
      {f && (
        <>
          <Line k={`Detect / frame (${f.n}, ${f.fps} fps)`} v={`${f.roundTripAvg} ms · p95 ${f.roundTripP95}`} />
          <Line k="  UI thread prep" v={`${f.prepAvg} ms · p95 ${f.prepP95}`} />
          <Line k="  worker" v={`${f.workerAvg} ms · p95 ${f.workerP95}`} />
        </>
      )}
      {s.captures.slice(0, 3).map((c, i) => (
        <Line
          key={`c${i}`}
          k={i === 0 ? "Shutter → page" : ""}
          v={`${ms(c.totalMs)} ${c.path}${c.stillSkipped ? ` (still: ${c.stillSkipped}${c.stillMs ? ` ${c.stillMs} ms` : ""})` : ""} ${c.width}×${c.height}`}
        />
      ))}
      {s.processed.slice(0, 3).map((p, i) => (
        <Line key={`p${i}`} k={i === 0 ? "Process page" : ""} v={`${ms(p.ms)} ${p.filter} ${p.where} ${p.width}×${p.height}`} />
      ))}
      {s.uploads.slice(0, 3).map((u, i) => (
        <Line key={`u${i}`} k={i === 0 ? "Upload" : ""} v={`${ms(u.ms)} ${(u.bytes / 1e6).toFixed(1)} MB ${u.pages}p${u.ok ? "" : " failed"}`} />
      ))}
    </div>
  );
}

/** Settings → About (hidden): timings of the last scanner sessions on this device. */
export function ScannerDiagnostics({ onHide }: { onHide: () => void }) {
  const [sessions, setSessions] = useState<ScanDiagSession[]>([]);
  useEffect(() => {
    // localStorage only exists on the client: read after mount
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSessions(readDiagnostics());
  }, []);
  return (
    <Group
      title="Scanner diagnostics"
      footer="Last scanner sessions on this device. Copy them when you report a scanner problem."
    >
      {sessions.length ? (
        sessions.map((s) => <SessionCard key={s.id} s={s} />)
      ) : (
        <p className="px-3.5 py-3 text-[13px] text-muted">No scans recorded yet. Open the scanner, scan a page, then come back.</p>
      )}
      <Row
        icon={<Copy />}
        label="Copy report"
        onClick={async () => {
          const ok = await copyText(diagnosticsText(readDiagnostics()));
          if (ok) toast.success("Copied");
          else toast.error("Could not copy");
        }}
      />
      <Row
        icon={<Trash2 />}
        label="Clear"
        onClick={() => {
          clearDiagnostics();
          setSessions([]);
        }}
      />
      <Row icon={<EyeOff />} label="Hide diagnostics" onClick={onHide} />
    </Group>
  );
}
