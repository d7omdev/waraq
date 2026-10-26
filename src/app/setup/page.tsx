import type { Metadata } from "next";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { SetupForm } from "@/components/auth/setup-form";
import { LoginScreen } from "@/components/auth/login-form";
import { setupOpen } from "@/lib/server/setup";

export const metadata: Metadata = { title: "Set up Waraq" };
export const instant = false;

export default async function SetupPage() {
  await connection();
  if (!(await setupOpen())) redirect("/login");
  return <LoginScreen title="Set up Waraq" subtitle="Create the single owner account for this server."><SetupForm /></LoginScreen>;
}
