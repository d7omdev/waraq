"use client";

import { useEffect, useMemo, useState } from "react";
import { Link2, Trash2 } from "lucide-react";
import { api, errorMessage } from "@/lib/client/api";
import { mutate, useQuery } from "@/lib/client/query";
import { plural } from "@/lib/client/format";
import { updatePrefs, usePrefs } from "@/lib/client/prefs";
import type { ShareLinkWithDoc } from "@/lib/types";
import { Button, EmptyState, Group, Segmented, Skeleton, Switch, TextField } from "@/components/ui/primitives";
import { toast } from "@/components/ui/toast";
import { ConfirmSheet } from "@/components/library/folder-sheets";
import { EXPIRY_OPTIONS, ShareLinkCard } from "@/components/share/share-link-card";
import { FieldBlock, SettingsPage } from "./settings-page";

type Tab = "active" | "expired" | "revoked" | "all";

export function SharingSettings() {
  const prefs = usePrefs();
  const [tab, setTab] = useState<Tab>("active");
  const [q, setQ] = useState("");
  const [confirm, setConfirm] = useState(false);
  // one list, filtered locally, so tab counts are always right
  const all = useQuery<ShareLinkWithDoc[]>("/api/shares?status=all", () => api.allShares("all"));
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const t0 = window.setTimeout(tick, 0);
    const t = window.setInterval(tick, 60_000);
    return () => {
      window.clearTimeout(t0);
      window.clearInterval(t);
    };
  }, []);
  const items = useMemo(() => all.data ?? [], [all.data]);
  const counts = useMemo(() => {
    const c = { active: 0, expired: 0, revoked: 0, all: items.length };
    for (const s of items) c[s.status]++;
    return c;
  }, [items]);
  const ql = q.trim().toLowerCase();
  const shown = items
    .filter((s) => tab === "all" || s.status === tab)
    .filter((s) => !ql || s.docTitle.toLowerCase().includes(ql) || s.url.toLowerCase().includes(ql));
  const totalViews = items.reduce((n, s) => n + s.views, 0);

  return (
    <SettingsPage
      title="Sharing"
      description={all.data ? `${plural(counts.active, "active link")} · ${plural(totalViews, "view")} in total` : "Every link you created, across all documents."}
    >
      <section className="min-w-0">
        <div className="mb-3 space-y-2.5">
          <Segmented
            size="sm"
            value={tab}
            onChange={setTab}
            options={(["active", "expired", "revoked", "all"] as const).map((t) => ({
              value: t,
              label: (
                <>
                  {t[0].toUpperCase() + t.slice(1)}
                  {all.data && <span className="text-faint tabular-nums">{counts[t]}</span>}
                </>
              ),
            }))}
          />
          {items.length > 6 && <TextField type="search" placeholder="Filter by document" value={q} onChange={(e) => setQ(e.target.value)} />}
        </div>
        {all.loading && !all.data ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-[132px] w-full rounded-2xl" />
            ))}
          </div>
        ) : all.error && !all.data ? (
          <p className="rounded-2xl border border-line px-4 py-4 text-sm text-danger">{errorMessage(all.error)}</p>
        ) : shown.length === 0 ? (
          <EmptyState
            icon={<Link2 />}
            title={tab === "active" ? "No active links" : `No ${tab === "all" ? "" : tab + " "}links`}
            body={tab === "active" ? "Open a document and tap Share to create a link." : undefined}
          />
        ) : (
          <ul className="space-y-2" data-share-list>
            {shown.map((s) => (
              <ShareLinkCard
                key={s.id}
                share={s}
                now={now}
                title={s.docTitle}
                showDoc
                onChanged={(u) => {
                  if (u === null) mutate("/api/shares?status=all", items.filter((x) => x.id !== s.id));
                  else if (u) mutate("/api/shares?status=all", items.map((x) => (x.id === s.id ? { ...x, ...u, status: u.status ?? x.status } : x)));
                  void all.refresh();
                }}
              />
            ))}
          </ul>
        )}
        {(counts.active > 0 || counts.expired + counts.revoked > 0) && (
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            {tab !== "active" && counts.expired + counts.revoked > 0 && (
              <Button
                size="sm"
                variant="ghost"
                icon={<Trash2 className="size-4" />}
                onClick={async () => {
                  const old = items.filter((s) => s.status !== "active" && (tab === "all" || s.status === tab));
                  const r = await Promise.allSettled(old.map((s) => api.purgeShare(s.id)));
                  const okN = r.filter((x) => x.status === "fulfilled").length;
                  void all.refresh();
                  toast.success(`Removed ${plural(okN, "old link")}`);
                }}
              >
                Clear {tab === "all" ? "expired and revoked" : tab}
              </Button>
            )}
            {counts.active > 0 && (
              <Button size="sm" variant="ghost" className="text-danger" icon={<Trash2 className="size-4" />} onClick={() => setConfirm(true)}>
                Revoke all active
              </Button>
            )}
          </div>
        )}
      </section>

      <Group title="Defaults for new links" footer="Used by Send link and bulk sharing. You can still change each link.">
        <FieldBlock label="Links expire after">
          <Segmented
            size="sm"
            value={prefs.sharing.defaultExpiry}
            onChange={(v) => updatePrefs({ sharing: { defaultExpiry: v } })}
            options={EXPIRY_OPTIONS}
          />
        </FieldBlock>
        <div className="px-3.5 py-1">
          <Switch
            checked={prefs.sharing.defaultAllowDownload}
            onChange={(v) => updatePrefs({ sharing: { defaultAllowDownload: v } })}
            label="Allow download"
            description="Viewers can save the PDF"
          />
        </div>
      </Group>

      <ConfirmSheet
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Revoke every link?"
        body={`${plural(counts.active, "active link")} will stop working immediately.`}
        confirmLabel="Revoke all"
        onConfirm={async () => {
          await api.revokeAllShares();
          await all.refresh();
          toast.success("All links revoked");
        }}
      />
    </SettingsPage>
  );
}
