"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { KeyRound, LogOut, MonitorX } from "lucide-react";
import { api, errorMessage } from "@/lib/client/api";
import { useQuery } from "@/lib/client/query";
import { formatBytes, formatDate } from "@/lib/client/format";
import { Badge, Button, Group, Row, Skeleton } from "@/components/ui/primitives";
import { toast } from "@/components/ui/toast";
import { ConfirmSheet } from "@/components/library/folder-sheets";
import { GoogleMark } from "@/components/auth/login-form";
import type { LinkedAccount, Me } from "@/lib/types";
import { SettingsPage } from "./settings-page";

export function Avatar({ me, size = 56 }: { me: { name: string; username: string | null; image: string | null } | undefined; size?: number }) {
  const initial = (me?.name || me?.username || "?").trim().slice(0, 1).toUpperCase();
  if (me?.image)
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={me.image} alt="" referrerPolicy="no-referrer" className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }} />
    );
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full bg-accent-strong font-semibold text-white"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
      aria-hidden
    >
      {initial}
    </span>
  );
}

const LINK_ERRORS: Record<string, string> = {
  account_already_linked_to_different_user: "That Google account is already linked elsewhere.",
  email_doesn: "That Google account's email doesn't match.",
  access_denied: "Google linking was cancelled.",
};

function linkErrorMessage(code: string): string {
  const c = code.toLowerCase();
  for (const [k, v] of Object.entries(LINK_ERRORS)) if (c.includes(k)) return v;
  if (c.includes("already")) return LINK_ERRORS.account_already_linked_to_different_user;
  return "Couldn't link Google. Try again.";
}

export function AccountSettings() {
  const router = useRouter();
  const params = useSearchParams();
  const me = useQuery<Me>("/api/auth/me", api.me);
  const acc = useQuery<{ accounts: LinkedAccount[]; googleAvailable: boolean }>("/api/account/accounts", api.accounts);
  const [unlink, setUnlink] = useState<LinkedAccount | null>(null);
  const [everywhere, setEverywhere] = useState(false);
  const [busy, setBusy] = useState<"link" | "logout" | null>(null);
  const handled = useRef(false);

  // OAuth link round trip result (?linked=google / ?error=...)
  useEffect(() => {
    if (handled.current) return;
    const linked = params.get("linked");
    const error = params.get("error");
    if (!linked && !error) return;
    handled.current = true;
    if (error) toast.error(linkErrorMessage(error));
    else if (linked === "google") toast.success("Google account linked");
    void acc.refresh();
    void me.refresh();
    router.replace("/settings/account");
  }, [params, router, acc, me]);

  const accounts = acc.data?.accounts ?? [];
  const password = accounts.find((a) => a.providerId === "credential");
  const google = accounts.find((a) => a.providerId === "google");
  const googleCount = accounts.filter((a) => a.providerId === "google").length;
  const onlyOne = googleCount + (password ? 1 : 0) <= 1;

  const signOut = async () => {
    setBusy("logout");
    try {
      await api.logout();
    } catch {
      /* still leave */
    }
    window.location.replace("/login");
  };

  return (
    <SettingsPage title="Account" description="Your profile and how you sign in.">
      <Group>
        <div className="flex min-w-0 items-center gap-4 px-4 py-4">
          <Avatar me={me.data} />
          <div className="min-w-0 flex-1">
            {me.data ? (
              <>
                <p className="truncate text-[17px] font-medium text-ink">{me.data.name || me.data.username}</p>
                {me.data.username && <p className="truncate text-[14px] text-muted">@{me.data.username}</p>}
                <p className="truncate text-[13px] text-faint">{me.data.email}</p>
              </>
            ) : (
              <div className="space-y-2">
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-4 w-44" />
              </div>
            )}
          </div>
          {me.data && <Badge tone="accent">Owner</Badge>}
        </div>
        {me.data && (
          <Row
            label="Storage"
            detail={
              `${formatBytes(me.data.storage.usedBytes)} used on this host`
            }
          />
        )}
      </Group>

      <Group
        title="Sign-in"
        footer={
          acc.data?.googleAvailable || google
            ? "Google sign-in is optional and only works for the Google account you link here. It never creates an account."
            : "Google sign-in is off on this server (no GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET). Forgot your password? Run npm run reset-password on the host."
        }
      >
        {acc.loading && !acc.data ? (
          <div className="space-y-2 px-4 py-3.5">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-5 w-40" />
          </div>
        ) : (
          <>
            {(acc.data?.googleAvailable || google) && (
              <Row
                icon={<GoogleMark className="size-[18px]" />}
                label={
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">Google</span>
                    {google && <Badge tone="ok">Linked</Badge>}
                  </span>
                }
                detail={google ? `Linked since ${formatDate(google.createdAt)}` : "Not linked"}
                trailing={
                  google ? (
                    onlyOne ? null : (
                      <Button size="sm" variant="ghost" className="text-danger" onClick={() => setUnlink(google)}>
                        Unlink
                      </Button>
                    )
                  ) : (
                    <Button
                      size="sm"
                      variant="primary"
                      loading={busy === "link"}
                      onClick={async () => {
                        setBusy("link");
                        try {
                          const { url } = await api.linkGoogle();
                          window.location.href = url;
                        } catch (e) {
                          setBusy(null);
                          toast.error(errorMessage(e, "Couldn't start Google linking"));
                        }
                      }}
                    >
                      Link
                    </Button>
                  )
                }
              />
            )}
            {password && <Row icon={<KeyRound />} label="Password" detail={`Set ${formatDate(password.createdAt)} · reset on the host with npm run reset-password`} />}
          </>
        )}
      </Group>

      <Group
        title="Sessions"
        footer={
          <>
            Waraq keeps only the sessions needed to keep your signed-in devices secure. It has no usage analytics or telemetry.
          </>
        }
      >
        <Row
          icon={<LogOut />}
          label={busy === "logout" ? "Signing out…" : "Sign out"}
          detail="On this device"
          disabled={busy === "logout"}
          onClick={() => void signOut()}
        />
        <Row
          icon={<MonitorX />}
          tone="danger"
          label="Sign out everywhere"
          detail="Every browser, including this one"
          onClick={() => setEverywhere(true)}
        />
      </Group>

      <ConfirmSheet
        open={!!unlink}
        onClose={() => setUnlink(null)}
        title="Unlink Google?"
        body="You won't be able to use this Google account to sign in to Waraq any more. Your password keeps working."
        confirmLabel="Unlink"
        onConfirm={async () => {
          try {
            await api.unlinkAccount(unlink!.id);
            toast.success("Google unlinked");
          } catch (e) {
            toast.error(errorMessage(e, "Couldn't unlink"));
          }
          await acc.refresh();
        }}
      />
      <ConfirmSheet
        open={everywhere}
        onClose={() => setEverywhere(false)}
        title="Sign out everywhere?"
        body="Every device, including this one, will need to sign in again."
        confirmLabel="Sign out everywhere"
        onConfirm={async () => {
          try {
            await api.revokeOtherSessions();
          } catch {
            /* continue to sign out here */
          }
          await signOut();
        }}
      />
    </SettingsPage>
  );
}
