// Instance-wide key/value settings for the single-owner Community edition.
import { getDb } from "./db";
import { nowIso } from "./ids";

export function getAppSetting(key: string): string | null {
  const r = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return r ? r.value : null;
}

export function setAppSetting(key: string, value: string | null): void {
  const db = getDb();
  if (value === null) db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  else
    db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    ).run(key, value, nowIso());
}
