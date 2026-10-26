import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./config";

type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT REFERENCES folders(id) ON DELETE SET NULL, color TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  tags TEXT NOT NULL DEFAULT '[]', starred INTEGER NOT NULL DEFAULT 0, page_count INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0, pages_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'ready',
  processing_json TEXT, processing_error TEXT, ocr_status TEXT NOT NULL DEFAULT 'none', ocr_text TEXT,
  ocr_layer_text TEXT, ocr_engine TEXT, version INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, trashed_at TEXT
);
CREATE INDEX IF NOT EXISTS documents_folder ON documents(folder_id);
CREATE INDEX IF NOT EXISTS documents_updated ON documents(updated_at);
CREATE INDEX IF NOT EXISTS documents_trashed ON documents(trashed_at);
CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  password_hash TEXT, allow_download INTEGER NOT NULL DEFAULT 0, expires_at TEXT, views INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS shares_doc ON shares(doc_id);
CREATE INDEX IF NOT EXISTS shares_created ON shares(created_at);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, payload TEXT, error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, id);
CREATE INDEX IF NOT EXISTS jobs_kind_status ON jobs(kind, status, id);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS drive_docs (
  doc_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE, file_id TEXT, web_view_link TEXT,
  synced_version INTEGER, synced_name TEXT, synced_parent TEXT, synced_at TEXT, last_error TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS drive_folders (
  folder_id TEXT PRIMARY KEY REFERENCES folders(id) ON DELETE CASCADE, drive_id TEXT NOT NULL,
  synced_name TEXT, synced_parent TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS drive_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, target_id TEXT NOT NULL, status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, manual INTEGER NOT NULL DEFAULT 0, due_at INTEGER NOT NULL,
  error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS drive_jobs_due ON drive_jobs(status, due_at, id);
CREATE INDEX IF NOT EXISTS drive_jobs_target ON drive_jobs(kind, target_id);
CREATE TABLE IF NOT EXISTS ocr_pages (
  doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, page INTEGER NOT NULL, engine TEXT NOT NULL,
  hash TEXT, text TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (doc_id, page)
);
CREATE INDEX IF NOT EXISTS ocr_pages_hash ON ocr_pages(hash, engine);
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(doc_id UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2');
`;

function initialize(db: DB): void {
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version > 1) throw new Error("This Waraq Community release requires a fresh DATA_DIR");
  db.transaction(() => {
    db.exec(SCHEMA);
    db.pragma("user_version = 1");
  })();
}

const g = globalThis as unknown as { __waraqDb?: { db: DB; dir: string } };

export function getDb(): DB {
  if (process.env.NEXT_PHASE === "phase-production-build") throw new Error("waraq: database access during next build");
  const dir = dataDir();
  if (g.__waraqDb?.dir === dir) return g.__waraqDb.db;
  g.__waraqDb?.db.close();
  fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
  fs.mkdirSync(path.join(dir, "tmp"), { recursive: true });
  const db = new Database(path.join(dir, "waraq.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  initialize(db);
  g.__waraqDb = { db, dir };
  return db;
}

export function closeDb(): void {
  g.__waraqDb?.db.close();
  g.__waraqDb = undefined;
}
