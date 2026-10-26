"use client";

import { useSearchParams } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { Eye, EyeOff, Lock } from "lucide-react";
import { api, ApiRequestError, errorMessage } from "@/lib/client/api";
import { Button, TextField } from "@/components/ui/primitives";
import { LogoMark, Wordmark } from "@/components/brand";
import { InstallBanner } from "@/components/install/install-banner";

/** Same-site paths only: never an absolute / protocol-relative URL (open redirect). */
export function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  if (raw.startsWith("/login") || raw.startsWith("/api/")) return "/";
  return raw;
}

const noop = () => () => {};
/** false during SSR and before hydration: a submit before then would be a native form post, so keep it inert */
export function useHydrated(): boolean {
  return useSyncExternalStore(noop, () => true, () => false);
}

/** Messages for Better Auth's ?error=<code> on the Google OAuth error redirect. */
export function oauthErrorMessage(code: string | null): string | null {
  if (!code) return null;
  const c = code.toLowerCase();
  if (c.includes("too_many") || c.includes("rate_limit")) return "Too many attempts from this network. Wait a while and try again.";
  if (c.includes("user_not_found") || c.includes("unable_to_create_user") || c.includes("signup_disabled") || c.includes("account_not_linked"))
    return "This Google account isn't linked to the owner. Sign in with your password, then link Google in Settings > Account.";
  if (c.includes("access_denied")) return "Google sign-in was cancelled.";
  if (c.includes("state")) return "That sign-in attempt expired. Try again.";
  return "Google sign-in failed. Try again.";
}

/** Official multi-colour Google "G" mark. */
export function GoogleMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden>
      <path
        fill="#FFC107"
        d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.6-.4-3.9z"
      />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z" />
    </svg>
  );
}

/** Google's sign-in button: white surface, the G mark, 48px target. */
export function GoogleButton({ label, onClick, loading, disabled }: { label: string; onClick: () => void; loading?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || loading}
      className="focus-ring inline-flex h-12 w-full min-w-0 items-center justify-center gap-3 rounded-xl border border-black/10 bg-white px-4 text-[15px] font-medium text-[#1f1f1f] shadow-[0_1px_2px_rgb(0_0_0/0.25)] transition-[background-color,opacity,transform] hover:bg-[#f2f2f2] active:scale-[0.98] disabled:pointer-events-none disabled:opacity-60"
    >
      {loading ? (
        <span className="size-5 animate-spin rounded-full border-2 border-[#1f1f1f]/25 border-t-[#1f1f1f]" aria-hidden />
      ) : (
        <GoogleMark className="size-5 shrink-0" />
      )}
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

export function Divider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 text-[12.5px] text-faint" role="separator">
      <span className="h-px flex-1 bg-line-strong" />
      {label}
      <span className="h-px flex-1 bg-line-strong" />
    </div>
  );
}

export function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  name,
  error,
  hint,
  minLength,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
  name: string;
  error?: string | null;
  hint?: string;
  minLength?: number;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <TextField
        label={label}
        name={name}
        type={show ? "text" : "password"}
        autoComplete={autoComplete}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
        minLength={minLength}
        error={error}
        hint={hint}
        className="pr-12"
      />
      <button
        type="button"
        onClick={() => setShow(!show)}
        aria-label={show ? "Hide password" : "Show password"}
        aria-pressed={show}
        className="focus-ring absolute top-[26px] right-0 inline-flex size-11 items-center justify-center rounded-xl text-muted hover:text-ink"
      >
        {show ? <EyeOff className="size-[18px]" /> : <Eye className="size-[18px]" />}
      </button>
    </div>
  );
}

export function FormError({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="rounded-xl border border-danger/25 bg-danger/8 px-3 py-2.5 text-sm leading-snug text-danger">
      {children}
    </p>
  );
}

export function LoginForm({ googleEnabled, setupOpen = false }: { googleEnabled: boolean; setupOpen?: boolean }) {
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const [busy, setBusy] = useState<"password" | "google" | null>(null);
  const [error, setError] = useState<string | null>(() => oauthErrorMessage(params.get("error")));

  if (setupOpen) {
    return (
      <p className="text-sm text-muted">
        This server has no owner yet. <a className="text-accent underline" href="/setup">Start setup</a>.
      </p>
    );
  }

  const google = async () => {
    setBusy("google");
    setError(null);
    try {
      const errorURL = `/login?next=${encodeURIComponent(next)}`;
      const { url } = await api.googleSignIn({ callbackURL: next, errorCallbackURL: errorURL });
      window.location.href = url;
    } catch (err) {
      setBusy(null);
      setError(
        err instanceof ApiRequestError && err.status === 429
          ? "Too many attempts. Wait a minute and try again."
          : errorMessage(err, "Could not start Google sign-in"),
      );
    }
  };

  return (
    <div className="w-full space-y-5">
      <OwnerPasswordForm next={next} busy={busy} setBusy={setBusy} />
      {error && <FormError>{error}</FormError>}
      {googleEnabled && (
        <>
          <Divider label="or" />
          <GoogleButton label="Continue with Google" onClick={() => void google()} loading={busy === "google"} disabled={busy === "password"} />
          <p className="text-center text-[12.5px] text-faint">Google works after you link it in Settings &gt; Account.</p>
        </>
      )}
    </div>
  );
}

function OwnerPasswordForm({ next, busy, setBusy }: { next: string; busy: "password" | "google" | null; setBusy: (b: "password" | "google" | null) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const hydrated = useHydrated();
  return (
    <div data-owner-password>
      <form method="post"
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy("password");
          setError(null);
          try {
            await api.login(username.trim().toLowerCase(), password);
            window.location.replace(next);
          } catch (err) {
            setBusy(null);
            if (err instanceof ApiRequestError && (err.status === 401 || err.status === 400)) setError("Wrong username or password");
            else if (err instanceof ApiRequestError && err.status === 429) setError("Too many attempts. Wait a few minutes and try again.");
            else setError(errorMessage(err, "Could not sign in"));
          }
        }}
      >
        <TextField
          label="Username"
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />
        <PasswordField label="Password" name="password" autoComplete="current-password" value={password} onChange={setPassword} />
        {error && <FormError>{error}</FormError>}
        <Button type="submit" variant="primary" size="lg" block loading={busy === "password"} disabled={busy === "google" || !hydrated}>
          Sign in
        </Button>
      </form>
    </div>
  );
}

export function LoginScreen({ children, title, subtitle }: { children: React.ReactNode; title?: React.ReactNode; subtitle?: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col px-5 pt-[calc(var(--sat)+20px)] pb-[calc(var(--sab)+20px)]">
      <div className="mx-auto flex w-full max-w-sm min-w-0 flex-1 flex-col">
        <Wordmark className="sm:hidden" />
        <div className="my-auto py-10">
          <LogoMark className="mb-7 hidden size-12 sm:block" />
          <h1 className="display text-[28px] leading-[1.08]">
            {title ?? (
              <>
                Sign in to <span className="text-accent">Waraq</span>
              </>
            )}
          </h1>
          <p className="mt-2.5 mb-7 text-[15px] text-muted">{subtitle ?? "Your private document archive."}</p>
          {children}
          <p className="mt-6 flex items-center justify-center gap-1.5 text-[13px] text-faint">
            <Lock className="size-3.5" /> Stored on your own server
          </p>
        </div>
        <InstallBanner />
      </div>
    </div>
  );
}
