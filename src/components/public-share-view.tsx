"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Clock, Download, FileQuestion, Loader2, Lock, Maximize2 } from "lucide-react";
import { api, ApiRequestError, errorMessage, type PublicShare } from "@/lib/client/api";
import { plural } from "@/lib/client/format";
import { Button, TextField } from "@/components/ui/primitives";
import { PageViewer } from "@/components/doc/page-viewer";
import { LogoMark } from "@/components/brand";

type State =
  | { kind: "loading" }
  | { kind: "ok"; data: PublicShare }
  | { kind: "locked"; error?: string }
  | { kind: "gone" }
  | { kind: "missing" }
  | { kind: "error"; message: string };

export function PublicShareView() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [viewer, setViewer] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.publicShare(token);
      setState({ kind: "ok", data });
    } catch (e) {
      if (e instanceof ApiRequestError) {
        if (e.status === 403 && e.code === "password_required") return setState({ kind: "locked" });
        if (e.status === 410) return setState({ kind: "gone" });
        if (e.status === 404) return setState({ kind: "missing" });
      }
      setState({ kind: "error", message: errorMessage(e) });
    }
  }, [token]);

  useEffect(() => {
    let alive = true;
    api
      .publicShare(token)
      .then((data) => alive && setState({ kind: "ok", data }))
      .catch((e: unknown) => {
        if (!alive) return;
        if (e instanceof ApiRequestError) {
          if (e.status === 403 && e.code === "password_required") return setState({ kind: "locked" });
          if (e.status === 410) return setState({ kind: "gone" });
          if (e.status === 404) return setState({ kind: "missing" });
        }
        setState({ kind: "error", message: errorMessage(e) });
      });
    return () => {
      alive = false;
    };
  }, [token]);

  return (
    <div className="min-h-dvh">
      <header className="bar sticky top-0 z-20 border-b border-line pt-[var(--sat)]">
        <div className="mx-auto flex h-14 max-w-3xl min-w-0 items-center gap-2.5 px-4">
          <LogoMark className="size-7" />
          <span className="display text-[21px] leading-none">Waraq</span>
          <span className="min-w-0 truncate text-[13px] whitespace-nowrap text-faint max-[420px]:hidden">· Shared with you</span>
          <div className="flex-1" />
          {state.kind === "ok" && state.data.allowDownload && (
            <a
              href={api.publicFileUrl(token)}
              download
              className="focus-ring inline-flex h-10 shrink-0 items-center gap-2 rounded-xl bg-accent-strong bg-[linear-gradient(180deg,rgb(255_255_255/0.14),rgb(255_255_255/0))] px-3.5 text-sm font-semibold text-white shadow-accent hover:bg-accent-hover"
            >
              <Download className="size-4" /> <span className="max-[360px]:hidden">Download</span> PDF
            </a>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-3xl min-w-0 px-4 pb-[calc(var(--sab)+48px)]">
        {state.kind === "loading" && (
          <div className="flex min-h-[60dvh] items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted" />
          </div>
        )}
        {state.kind === "locked" && <Unlock token={token} onUnlocked={load} />}
        {state.kind === "gone" && (
          <Message
            icon={<Clock />}
            title="This link has expired"
            body="The person who shared it turned it off or it reached its expiry date. Ask them for a new link."
          />
        )}
        {state.kind === "missing" && (
          <Message icon={<FileQuestion />} title="Link not found" body="Check that the address was copied completely." />
        )}
        {state.kind === "error" && (
          <Message
            icon={<FileQuestion />}
            title="Could not open"
            body={state.message}
            action={<Button onClick={load}>Try again</Button>}
          />
        )}
        {state.kind === "ok" && (
          <>
            <div className="min-w-0 pt-8 pb-6">
              <h1 dir="auto" className="display text-[26px] leading-[1.12] [overflow-wrap:anywhere] sm:text-[34px]">
                {state.data.title}
              </h1>
              <p className="mt-1 text-sm text-muted">{plural(state.data.pageCount, "page")}</p>
            </div>
            <ol className="space-y-6">
              {state.data.pages.map((p, i) => (
                <li key={i}>
                  <button
                    type="button"
                    onClick={() => setViewer(i)}
                    className="focus-ring group relative block w-full overflow-hidden rounded-md bg-white shadow-[0_2px_4px_rgb(0_0_0/0.4),0_24px_50px_-20px_rgb(0_0_0/0.9)]"
                    aria-label={`Open page ${i + 1}`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={p.imageUrl}
                      alt={`Page ${i + 1}`}
                      loading={i < 2 ? "eager" : "lazy"}
                      decoding="async"
                      className="block h-auto w-full"
                      style={{ minHeight: 200 }}
                    />
                    <span className="absolute right-3 bottom-3 flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-[12px] font-medium text-white tabular-nums">
                      {i + 1} / {state.data.pageCount}
                      <Maximize2 className="size-3 opacity-70" />
                    </span>
                  </button>
                </li>
              ))}
            </ol>
            <p className="mt-10 text-center text-[13px] text-faint">Shared privately with Waraq. This page is not indexed.</p>
          </>
        )}
      </main>
      {state.kind === "ok" && viewer !== null && (
        <PageViewer pages={state.data.pages} startIndex={viewer} title={state.data.title} onClose={() => setViewer(null)} />
      )}
    </div>
  );
}

function Unlock({ token, onUnlocked }: { token: string; onUnlocked: () => void }) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="mx-auto flex min-h-[70dvh] max-w-sm flex-col justify-center">
      <div className="surface mb-6 flex size-14 items-center justify-center rounded-2xl text-accent">
        <Lock className="size-5" />
      </div>
      <h1 className="display text-[26px] leading-[1.1]">Password protected</h1>
      <p className="mt-2 mb-6 text-sm text-muted">Enter the password you received with this link.</p>
      <form method="post"
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api.unlockShare(token, pw);
            onUnlocked();
          } catch (err) {
            setError(
              err instanceof ApiRequestError && (err.status === 401 || err.status === 403)
                ? "That password is not right"
                : err instanceof ApiRequestError && err.status === 429
                  ? "Too many attempts. Try again later."
                  : errorMessage(err),
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <TextField
          type="password"
          autoComplete="off"
          placeholder="Password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          error={error}
          autoFocus
        />
        <Button type="submit" variant="primary" block size="lg" loading={busy} disabled={!pw}>
          Open document
        </Button>
      </form>
    </div>
  );
}

function Message({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mx-auto flex min-h-[70dvh] max-w-sm flex-col items-center justify-center text-center">
      <div className="surface mb-6 flex size-14 items-center justify-center rounded-2xl text-accent [&_svg]:size-6">
        {icon}
      </div>
      <h1 className="display text-[26px] leading-[1.1]">{title}</h1>
      <p className="mt-2 text-sm text-muted">{body}</p>
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
