import { connection } from "next/server";
import { getDb } from "@/lib/server/db";

export async function GET() {
  await connection();
  try {
    const row = getDb().prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
    if (row?.quick_check !== "ok") throw new Error("database check failed");
    return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
