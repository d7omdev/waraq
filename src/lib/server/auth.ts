import { createHash } from "node:crypto";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { getMigrations } from "better-auth/db/migration";
import { username } from "better-auth/plugins";
import { SqliteDialect } from "kysely";
import type Database from "better-sqlite3";
import type { SessionInfo } from "@/lib/types";
import { getDb } from "./db";
import { publicBaseUrl } from "./config";
import { authSecret } from "./auth-secret";
import { googleCredentials } from "./google-config";
import { AUTH_IP_OPTIONS } from "./client-ip";

export const AUTH_COOKIE_PREFIX = "waraq";
export const SESSION_TTL_S = 180 * 24 * 3600;

function trustedOrigins(): string[] {
  const base = new URL(publicBaseUrl());
  const origins = new Set([base.origin]);
  if (process.env.NODE_ENV !== "production") {
    const port = base.port ? `:${base.port}` : "";
    origins.add(`${base.protocol}//localhost${port}`);
    origins.add(`${base.protocol}//127.0.0.1${port}`);
  }
  return [...origins];
}

function createAuth(db: Database.Database) {
  const google = googleCredentials();
  const secure = publicBaseUrl().startsWith("https://");
  return betterAuth({
    appName: "Waraq",
    baseURL: publicBaseUrl(),
    basePath: "/api/auth",
    secret: authSecret(),
    trustedOrigins: trustedOrigins(),
    telemetry: { enabled: false },
    database: { dialect: new SqliteDialect({ database: db }), type: "sqlite", transaction: false },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      autoSignIn: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      password: { hash: (password) => hashPassword(password), verify: ({ hash, password }) => verifyPassword({ hash, password }) },
    },
    session: { expiresIn: SESSION_TTL_S, updateAge: 24 * 3600, freshAge: 0 },
    account: {
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        trustedProviders: ["google"],
        allowDifferentEmails: true,
        updateUserInfoOnLink: false,
        allowUnlinkingAll: false,
      },
    },
    socialProviders: google
      ? { google: { clientId: google.clientId, clientSecret: google.clientSecret, includeGrantedScopes: false, prompt: "select_account", disableImplicitSignUp: true, disableIdTokenSignIn: false } }
      : {},
    advanced: {
      cookiePrefix: AUTH_COOKIE_PREFIX,
      useSecureCookies: secure,
      defaultCookieAttributes: { sameSite: "lax", httpOnly: true, secure },
      ipAddress: AUTH_IP_OPTIONS,
      database: { validateSchema: false },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 120,
      customRules: {
        "/sign-in/username": { window: 15 * 60, max: 10 },
        "/sign-in/email": { window: 15 * 60, max: 10 },
        "/sign-up/email": { window: 60 * 60, max: 3 },
        "/sign-in/social": { window: 60, max: 20 },
        "/link-social": { window: 60, max: 10 },
        "/change-password": { window: 15 * 60, max: 10 },
        "/get-session": false,
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path.startsWith("/sign-up/")) {
          throw new APIError("FORBIDDEN", { code: "SETUP_CLOSED", message: "Account creation is closed" });
        }
        if (ctx.path === "/sign-in/social" && (ctx.body as { requestSignUp?: unknown } | undefined)?.requestSignUp) {
          throw new APIError("FORBIDDEN", { code: "SETUP_CLOSED", message: "Account creation is closed" });
        }
      }),
    },
    databaseHooks: { user: { create: { before: async () => false } } },
    plugins: [username({ minUsernameLength: 3, maxUsernameLength: 32 })],
  });
}

export type Auth = ReturnType<typeof createAuth>;
const state = globalThis as unknown as { __waraqAuth?: { db: Database.Database; auth: Auth; ready: Promise<Auth> | null } };

export function getAuth(): Auth {
  const db = getDb();
  if (!state.__waraqAuth || state.__waraqAuth.db !== db) state.__waraqAuth = { db, auth: createAuth(db), ready: null };
  return state.__waraqAuth.auth;
}

export function authReady(): Promise<Auth> {
  const auth = getAuth();
  const current = state.__waraqAuth!;
  current.ready ??= (async () => {
    const { runMigrations } = await getMigrations(auth.options);
    await runMigrations();
    return auth;
  })().catch((error) => {
    current.ready = null;
    throw error;
  });
  return current.ready;
}

export function resetAuth(): void {
  state.__waraqAuth = undefined;
}

export interface AuthUser { id: string; name: string; email: string; image: string | null; username: string | null }
export interface Session { id: string; userId: string; expiresAt: string; user: AuthUser }

export function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const date = new Date(typeof value === "string" && /^\d+$/.test(value) ? Number(value) : (value as string | number));
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

export async function resolveSession(headers: Headers): Promise<{ session: Session; setCookies: string[] } | null> {
  const auth = await authReady();
  const result = (await auth.api.getSession({ headers, returnHeaders: true }).catch(() => null)) as
    | { headers: Headers; response: { session: Record<string, unknown>; user: Record<string, unknown> } | null }
    | null;
  if (!result?.response?.session || !result.response.user) return null;
  const { session, user } = result.response;
  return {
    session: {
      id: String(session.id), userId: String(user.id), expiresAt: toIso(session.expiresAt),
      user: { id: String(user.id), name: String(user.name ?? ""), email: String(user.email ?? ""), image: (user.image as string | null) ?? null, username: (user.username as string | null) ?? null },
    },
    setCookies: result.headers.getSetCookie?.() ?? [],
  };
}

export function sessionCookieNames(): string[] {
  const names = [`${AUTH_COOKIE_PREFIX}.session_token`, `${AUTH_COOKIE_PREFIX}.session_data`, `${AUTH_COOKIE_PREFIX}.dont_remember`];
  return [...names, ...names.map((name) => `__Secure-${name}`)];
}

export function publicSessionId(id: string): string {
  return createHash("sha256").update(`waraq-session:${id}`).digest("base64url").slice(0, 22);
}

interface SessionRow { id: string; createdAt: unknown; updatedAt: unknown; expiresAt: unknown; userAgent: string | null }
function activeRows(userId: string): SessionRow[] {
  const rows = getDb().prepare(`SELECT id, "createdAt", "updatedAt", "expiresAt", "userAgent" FROM session WHERE "userId" = ?`).all(userId) as SessionRow[];
  return rows.filter((row) => Date.parse(toIso(row.expiresAt)) > Date.now()).sort((a, b) => Date.parse(toIso(b.updatedAt)) - Date.parse(toIso(a.updatedAt)));
}
export function listSessions(userId: string, currentId: string | null): SessionInfo[] {
  return activeRows(userId).map((row) => ({ id: publicSessionId(row.id), current: row.id === currentId, userAgent: row.userAgent, createdAt: toIso(row.createdAt), lastSeenAt: toIso(row.updatedAt), expiresAt: toIso(row.expiresAt) }));
}
export function revokeSessionByPublicId(userId: string, id: string): { found: boolean; rawId: string | null } {
  const row = activeRows(userId).find((item) => publicSessionId(item.id) === id);
  if (!row) return { found: false, rawId: null };
  getDb().prepare(`DELETE FROM session WHERE id = ? AND "userId" = ?`).run(row.id, userId);
  return { found: true, rawId: row.id };
}
export function revokeOtherSessions(userId: string, currentId: string): number { return getDb().prepare(`DELETE FROM session WHERE "userId" = ? AND id != ?`).run(userId, currentId).changes; }
export function revokeAllSessions(userId: string): number { return getDb().prepare(`DELETE FROM session WHERE "userId" = ?`).run(userId).changes; }
export function purgeExpiredSessions(): void {
  try {
    const rows = getDb().prepare(`SELECT id, "expiresAt" FROM session`).all() as { id: string; expiresAt: unknown }[];
    const del = getDb().prepare("DELETE FROM session WHERE id = ?");
    for (const row of rows) if (Date.parse(toIso(row.expiresAt)) <= Date.now()) del.run(row.id);
  } catch { /* auth tables may not exist during first boot */ }
}

export { googleCredentials };
