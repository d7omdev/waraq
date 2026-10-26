"use client";

import { useState } from "react";
import { Button, TextField } from "@/components/ui/primitives";
import { FormError, PasswordField, useHydrated } from "./login-form";

export function SetupForm() {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // until React has hydrated, a click would submit the form natively; keep the button inert until then
  const ready = useHydrated();
  return <form method="post" className="space-y-4" onSubmit={async (event) => {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      const response = await fetch("/api/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, email, password }) });
      if (response.ok) { window.location.replace("/login"); return; }
      const body = await response.json().catch(() => ({})) as { error?: string };
      setError(response.status === 409 ? "Setup is already complete. Sign in instead." : (body.error ?? "Could not complete setup"));
    } catch {
      setError("Could not reach the server. Try again.");
    }
    setBusy(false);
  }}>
    <TextField label="Username" name="username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required minLength={3} maxLength={32} />
    <TextField label="Email (optional)" name="email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} />
    <PasswordField label="Password" name="password" autoComplete="new-password" value={password} onChange={setPassword} minLength={12} hint="Use at least 12 characters." />
    {error && <FormError>{error}</FormError>}
    <Button type="submit" variant="primary" size="lg" block loading={busy} disabled={!ready}>Create owner</Button>
  </form>;
}
