import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { LoginForm, LoginScreen } from "@/components/auth/login-form";
import { googleCredentials } from "@/lib/server/google-config";
import { setupOpen } from "@/lib/server/setup";

export const metadata: Metadata = { title: "Sign in" };

// the Google button depends on runtime env (GOOGLE_CLIENT_ID / _SECRET), so read it at request time
async function Form() {
  await connection();
  if (await setupOpen()) return <LoginForm googleEnabled={false} setupOpen />;
  return <LoginForm googleEnabled={!!googleCredentials()} />;
}

export default function LoginPage() {
  return (
    <LoginScreen>
      <Suspense fallback={<div className="h-64" />}>
        <Form />
      </Suspense>
    </LoginScreen>
  );
}
