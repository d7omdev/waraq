import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { getDb } from "@/lib/server/db";
import { createOwner, setupOpen } from "@/lib/server/setup";
import { authCall, signIn } from "./auth-helpers";
import * as setupRoute from "@/app/api/setup/route";

describe("single-owner authentication", () => {
  it("has exactly one configured owner and setup is permanently closed", async () => {
    expect(await setupOpen()).toBe(false);
    expect((getDb().prepare(`SELECT COUNT(*) n FROM "user"`).get() as { n: number }).n).toBe(1);
    await expect(createOwner({ username: "second", email: "second@example.test", password: "a secure password 123" }))
      .rejects.toMatchObject({ status: 409, code: "setup_closed" });
  });

  it("rejects a second setup request and Better Auth sign-up", async () => {
    const request = new NextRequest("https://scan.example.test/api/setup", {
      method: "POST", headers: { origin: "https://scan.example.test", "content-type": "application/json" },
      body: JSON.stringify({ username: "second", email: "", password: "a secure password 123" }),
    });
    expect((await setupRoute.POST(request, { params: Promise.resolve({}) })).status).toBe(409);
    expect((await authCall("/sign-up/email", { name: "Second", email: "second@example.test", password: "a secure password 123" })).status).toBe(403);
  });

  it("signs the owner in with the local password", async () => {
    const cookie = await signIn("tester", process.env.TEST_OWNER_PASSWORD!);
    expect(cookie).toContain("waraq.session_token=");
  });
});
