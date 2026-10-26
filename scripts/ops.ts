#!/usr/bin/env node
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { closeDb, getDb } from "../src/lib/server/db";
import { dataDir } from "../src/lib/server/config";

const command = process.argv[2];
const args = process.argv.slice(3);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dir = dataDir();
const dbPath = path.join(dir, "waraq.db");

async function migrate() {
  getDb().prepare("SELECT 1").get();
  closeDb();
  console.log(`Database ready in ${dir}`);
}

async function doctor() {
  const errors: string[] = [];
  if ((process.env.SESSION_SECRET ?? "").length < 32) errors.push("SESSION_SECRET must be at least 32 characters");
  if (!process.env.PUBLIC_BASE_URL) console.warn("PUBLIC_BASE_URL is not set (defaults to http://localhost:3000)");
  await migrate();
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    errors.push(`DATA_DIR is not writable: ${dir}`);
  }
  const db = new Database(dbPath, { readonly: true });
  const integrity = (db.pragma("integrity_check", { simple: true }) as string) || "unknown";
  let owners = 0;
  try {
    owners = (db.prepare(`SELECT COUNT(*) AS n FROM "user"`).get() as { n: number }).n;
  } catch {
    /* auth tables are created on first server start */
  }
  db.close();
  if (integrity !== "ok") errors.push(`SQLite integrity check: ${integrity}`);
  if (owners === 0) console.warn("No owner yet: open /setup in the browser to create one");
  else if (owners > 1) errors.push(`Expected exactly one owner account, found ${owners}`);
  // Poppler tools only understand -v
  for (const [binary, versionFlag] of [["qpdf", "--version"], ["pdftoppm", "-v"], ["pdftotext", "-v"], ["ocrmypdf", "--version"], ["tesseract", "--version"]]) {
    if (spawnSync(binary, [versionFlag], { stdio: "ignore" }).status !== 0) console.warn(`Optional command unavailable: ${binary}`);
  }
  if (errors.length) {
    for (const error of errors) console.error(`ERROR: ${error}`);
    process.exitCode = 1;
  } else console.log("Waraq doctor: healthy");
}

async function backup() {
  if (!fs.existsSync(dbPath)) throw new Error(`No database at ${dbPath}`);
  const destination = path.resolve(option("--output") || `waraq-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz`);
  const staging = await fsp.mkdtemp(path.join(path.dirname(destination), ".waraq-backup-"));
  try {
    const targetDb = path.join(staging, "waraq.db");
    const source = new Database(dbPath, { readonly: true });
    await source.backup(targetDb);
    source.close();
    // documents only: page renders under docs/<id>/cache are rebuilt on demand
    const docs = path.join(dir, "docs");
    if (fs.existsSync(docs)) {
      await fsp.cp(docs, path.join(staging, "docs"), {
        recursive: true,
        force: true,
        filter: (src) => !src.split(path.sep).includes("cache"),
      });
    }
    const files: string[] = [];
    async function walk(base: string) {
      for (const entry of await fsp.readdir(base, { withFileTypes: true })) {
        const p = path.join(base, entry.name);
        if (entry.isDirectory()) await walk(p);
        else files.push(path.relative(staging, p));
      }
    }
    await walk(staging);
    const manifest = [];
    for (const file of files.sort()) manifest.push({ file, sha256: createHash("sha256").update(await fsp.readFile(path.join(staging, file))).digest("hex") });
    await fsp.writeFile(path.join(staging, "manifest.json"), JSON.stringify({ format: 1, createdAt: new Date().toISOString(), files: manifest }, null, 2));
    const result = spawnSync("tar", ["-czf", destination, "-C", staging, "."], { stdio: "inherit" });
    if (result.status !== 0) throw new Error("tar failed");
    console.log(`Backup written to ${destination} (${files.length} file(s)). Keep SESSION_SECRET with it: it decrypts the stored Google credentials.`);
  } finally {
    await fsp.rm(staging, { recursive: true, force: true });
  }
}

async function restore() {
  const archive = option("--input");
  if (!archive || !flag("--confirm")) throw new Error("Usage: npm run restore -- --input /path/backup.tar.gz --confirm");
  if (fs.existsSync(dbPath)) throw new Error(`Refusing to overwrite ${dbPath}; move the existing DATA_DIR aside first`);
  await fsp.mkdir(dir, { recursive: true });
  const result = spawnSync("tar", ["-xzf", path.resolve(archive), "-C", dir, "--no-same-owner"], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("tar failed");
  const manifestPath = path.join(dir, "manifest.json");
  const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8")) as { files: { file: string; sha256: string }[] };
  for (const entry of manifest.files) {
    const target = path.resolve(dir, entry.file);
    if (!target.startsWith(dir + path.sep)) throw new Error(`Unsafe path in manifest: ${entry.file}`);
    const sum = createHash("sha256").update(await fsp.readFile(target)).digest("hex");
    if (sum !== entry.sha256) throw new Error(`Checksum mismatch for ${entry.file}; the backup is damaged`);
  }
  await fsp.rm(manifestPath);
  console.log(`Restored and verified ${manifest.files.length} file(s) in ${dir}. Run npm run doctor before starting Waraq.`);
}

async function main() {
  if (command === "setup" || command === "migrate") await migrate();
  else if (command === "doctor") await doctor();
  else if (command === "backup") await backup();
  else if (command === "restore") await restore();
  else throw new Error("Usage: ops.ts setup|migrate|doctor|backup|restore");
}

void main().catch((error) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
