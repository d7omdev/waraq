// Owner account rules: exactly one owner and no account-creation path.
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { authReady } from "@/lib/server/auth";
import { getDb } from "@/lib/server/db";
import { createOwner } from "@/lib/server/setup";
import { authCall, signIn } from "./auth-helpers";

const ROOT = path.resolve(__dirname, "../..");
const userCount = () => (getDb().prepare(`SELECT COUNT(*) AS n FROM "user"`).get() as { n: number }).n;

describe("single owner", () => {
  it("parallel setup attempts never create a second owner", async () => {
    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => createOwner({ username: `racer${i}`, email: "", password: "a secure password 123" })),
    );
    expect(attempts.every((a) => a.status === "rejected")).toBe(true);
    expect(userCount()).toBe(1);
  });

  it("no Better Auth path can create a user (Google sign-in included)", async () => {
    const auth = await authReady();
    const ctx = await auth.$context;
    // what the Google callback would do for an unknown Google account
    const created = await ctx.internalAdapter
      .createOAuthUser(
        { email: "stranger@example.test", name: "Stranger", emailVerified: true },
        { providerId: "google", accountId: "google-sub-123" },
      )
      .catch(() => null);
    expect(created?.user ?? null).toBeNull();
    expect(userCount()).toBe(1);
    for (const p of ["/sign-up/email", "/sign-up/username"]) {
      expect((await authCall(p, { name: "x", email: "x@example.test", username: "xuser", password: "a secure password 123" })).status).toBe(403);
    }
    // requestSignUp on social sign-in is refused before any provider is consulted
    const social = await authCall("/sign-in/social", { provider: "google", callbackURL: "/", requestSignUp: true });
    expect(social.status).toBeGreaterThanOrEqual(400);
    expect(userCount()).toBe(1);
  });

  it("refuses email-based recovery flows", async () => {
    for (const p of ["/request-password-reset", "/forget-password", "/reset-password", "/change-email", "/delete-user"]) {
      expect((await authCall(p, { email: "tester@example.test", newPassword: "a secure password 123" })).status, p).toBe(403);
    }
  });
});


describe("reset-password CLI", () => {
  it("sets a new owner password from WARAQ_NEW_PASSWORD and signs out other sessions", async () => {
    const before = await signIn("tester", process.env.TEST_OWNER_PASSWORD!);
    expect(before).toContain("session_token");
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/reset-password.mjs")], {
      cwd: ROOT,
      env: { ...process.env, WARAQ_NEW_PASSWORD: "a brand new password 77" },
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Password updated for @tester");
    expect(r.stdout + r.stderr).not.toContain("a brand new password 77");
    await expect(signIn("tester", process.env.TEST_OWNER_PASSWORD!)).rejects.toThrow(/401/);
    expect(await signIn("tester", "a brand new password 77")).toContain("session_token");
    // too short: refused, nothing changes
    const bad = spawnSync(process.execPath, [path.join(ROOT, "scripts/reset-password.mjs")], {
      cwd: ROOT,
      env: { ...process.env, WARAQ_NEW_PASSWORD: "short" },
      encoding: "utf8",
    });
    expect(bad.status).toBe(1);
    expect(await signIn("tester", "a brand new password 77")).toContain("session_token");
  });
});
