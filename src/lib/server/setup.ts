import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { z } from "zod";
import { authReady } from "./auth";
import { getDb } from "./db";
import { HttpError } from "./errors";

export const setupInput = z.object({
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._-]{2,31}$/),
  email: z.union([z.email(), z.literal("")]).optional().transform((value) => value || undefined),
  password: z.string().min(12).max(128),
});

export async function setupOpen(): Promise<boolean> {
  await authReady();
  return !(getDb().prepare(`SELECT 1 FROM "user" LIMIT 1`).get());
}

export async function createOwner(input: z.infer<typeof setupInput>): Promise<void> {
  await authReady();
  const value = setupInput.parse(input);
  const password = await hashPassword(value.password);
  const db = getDb();
  const now = new Date().toISOString();
  const id = randomUUID().replaceAll("-", "");
  const email = value.email ?? `${value.username}@localhost.invalid`;
  try {
    db.transaction(() => {
      if (db.prepare(`SELECT 1 FROM "user" LIMIT 1`).get()) throw new HttpError(409, "setup_closed", "Setup is already complete");
      db.prepare(
        `INSERT INTO "user" (id, name, email, "emailVerified", image, "createdAt", "updatedAt", username, "displayUsername")
         VALUES (?, ?, ?, 1, NULL, ?, ?, ?, ?)`,
      ).run(id, value.username, email, now, now, value.username, value.username);
      db.prepare(
        `INSERT INTO account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
         VALUES (?, ?, 'credential', ?, ?, ?, ?)`,
      ).run(randomUUID().replaceAll("-", ""), id, id, password, now, now);
    }).immediate();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if ((error as Error).message.includes("UNIQUE")) throw new HttpError(409, "setup_closed", "Setup is already complete");
    throw error;
  }
}
