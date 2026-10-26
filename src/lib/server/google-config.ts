/** Google OAuth client for "Continue with Google" (same client as the Drive grant; env only). */
export function googleCredentials(): { clientId: string; clientSecret: string } | null {
  const clientId = (process.env.GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || "").trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}
