#!/usr/bin/env node
// Recovery: set a new password for the Waraq owner directly in the database (run on the host).
//
//   npm run reset-password                               # prompts twice for the new password (hidden input)
//   WARAQ_NEW_PASSWORD='...' npm run reset-password      # non-interactive (keep it out of shell history)
//   npm run reset-password -- --data /path/to/data --keep-sessions
//
// The password is never accepted as a command-line argument and is never printed. Uses DATA_DIR (or --data <dir>)
// to find waraq.db, writes a Better Auth scrypt hash to the owner's password account, clears the sign-in rate limit
// and, unless --keep-sessions is given, signs the owner out everywhere. Safe while the server runs (SQLite WAL).
import { createRequire } from "node:module";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const unknown = args.filter((a, i) => !["--data", "--keep-sessions"].includes(a) && !(i > 0 && args[i - 1] === "--data"));
if (unknown.length) {
  console.error("Usage: npm run reset-password [-- --data <dir>] [--keep-sessions]  (the password is prompted, or read from WARAQ_NEW_PASSWORD)");
  process.exit(2);
}
const dataDir = path.resolve(opt("--data") || process.env.DATA_DIR || path.join(process.cwd(), ".data"));
const dbPath = path.join(dataDir, "waraq.db");
if (!existsSync(dbPath)) {
  console.error(`No database at ${dbPath} (set DATA_DIR or pass --data <dir>)`);
  process.exit(2);
}

async function readHidden(prompt) {
  if (!process.stdin.isTTY) throw new Error("No terminal for a hidden prompt: set WARAQ_NEW_PASSWORD instead");
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let s = "";
    const on = (ch) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", on);
          process.stdout.write("\n");
          return resolve(s);
        }
        if (c === "\u0003") {
          process.stdin.setRawMode(false);
          return reject(new Error("cancelled"));
        }
        if (c === "\u007f" || c === "\b") s = s.slice(0, -1);
        else s += c;
      }
    };
    process.stdin.on("data", on);
  });
}

const Database = require("better-sqlite3");
const db = new Database(dbPath);
db.pragma("busy_timeout = 5000");
const owner = db.prepare(`SELECT id, username FROM "user" ORDER BY "createdAt" LIMIT 1`).get();
if (!owner) {
  console.error("No owner yet: open /setup in the browser to create one.");
  process.exit(1);
}

let password = process.env.WARAQ_NEW_PASSWORD;
if (!password) {
  try {
    password = await readHidden(`New password for @${owner.username}: `);
    const again = await readHidden("Repeat: ");
    if (again !== password) {
      console.error("Passwords don't match");
      process.exit(1);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
if (password.length < 12 || password.length > 128) {
  console.error("Password must be 12-128 characters");
  process.exit(1);
}

const { hashPassword } = await import("better-auth/crypto");
const hash = await hashPassword(password);
password = "";
const now = new Date().toISOString();
const keep = flag("--keep-sessions");
const revoked = db.transaction(() => {
  const acc = db.prepare(`SELECT id FROM account WHERE "userId" = ? AND "providerId" = 'credential'`).get(owner.id);
  if (acc) db.prepare(`UPDATE account SET password = ?, "updatedAt" = ? WHERE id = ?`).run(hash, now, acc.id);
  else
    db.prepare(`INSERT INTO account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt") VALUES (?, ?, 'credential', ?, ?, ?, ?)`).run(
      randomUUID().replaceAll("-", ""),
      owner.id,
      owner.id,
      hash,
      now,
      now,
    );
  // clear the sign-in rate limit so the owner can sign in right away
  try {
    db.prepare(`DELETE FROM "rateLimit" WHERE key LIKE '%sign-in%'`).run();
  } catch {
    /* table not created yet */
  }
  return keep ? 0 : db.prepare(`DELETE FROM session WHERE "userId" = ?`).run(owner.id).changes;
})();
db.close();
console.log(`Password updated for @${owner.username}.${keep ? "" : ` Signed out ${revoked} session(s).`}`);
