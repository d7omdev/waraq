# Security model

Waraq is built for one trusted owner running their own server behind HTTPS. This page describes what it protects, how, and what stays your responsibility. To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## What is protected

| Asset | Protection |
| --- | --- |
| The owner account | One account only. Setup is a single atomic transaction and closes for good. Every sign-up path is refused, Google cannot create users, and there are no roles to escalate to. |
| Passwords | Hashed with scrypt by Better Auth, at least 12 characters. Share passwords use bcrypt. The reset tool never takes the password as an argument and never prints it. |
| Sessions | Database-backed Better Auth sessions in an HttpOnly, SameSite=Lax cookie, `Secure` when `PUBLIC_BASE_URL` is HTTPS. Settings > Devices lists and revokes them. A password reset revokes all of them. |
| Writes | Every mutating request must come from your own origin (`Origin` checked against `PUBLIC_BASE_URL` and the request host), on top of SameSite cookies. |
| Brute force | Sign-in: 10 attempts per 15 minutes. Setup: 10 per 15 minutes. Share unlock: 20 per 15 minutes. Google sign-in and linking are rate limited too. |
| Documents | Served only to the owner session, or through an active share link. IDs are validated against a strict alphabet, so they cannot traverse paths. SQL uses prepared statements. |
| Share links | 24-character random tokens (about 143 bits). Optional expiry, password and download flag. Revocation takes effect immediately. Unlock cookies are signed, scoped to one share and bound to the current password. Share pages send `noindex`. |
| Google credentials | Refresh token and any client secret entered in Settings are encrypted with AES-256-GCM, with a key derived from `SESSION_SECRET` by HKDF. Drive access is limited to `drive.file`. |
| Privacy | No analytics, telemetry, tracking cookies or third-party scripts. Next.js telemetry is disabled in the Docker image. |

Response headers include `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin` and a restrictive `Permissions-Policy`. Large uploads are capped (60 MB per file, 300 MB per request), and uploads are parsed and normalized with pdf-lib and sharp (with pixel limits) before they are stored.

## What you are responsible for

- **HTTPS.** Run Waraq behind a TLS reverse proxy. Set `PUBLIC_BASE_URL` to the `https://` origin so cookies are `Secure`.
- **Do not expose the Node port.** The compose file binds to `127.0.0.1`. Rate limiting relies on the proxy's `X-Forwarded-For`; see `TRUSTED_PROXY_CIDRS` in [Setup](SETUP.md).
- **Secrets.** Keep `.env` or `/etc/waraq.env` readable only by root or the service account. Use a long random `SESSION_SECRET` and keep it stable.
- **Data at rest.** Waraq does not encrypt the database or PDFs. Use full-disk or volume encryption if the host may be lost or seized, and protect backups the same way.
- **Updates.** Keep the host, Docker image, Node.js and the PDF and OCR tools patched. Pull new Waraq releases.
- **Share links.** Anyone holding an active link can open that document. Prefer expiry and a password for sensitive files, and revoke links you no longer need.

## Out of scope

- A compromised host, root user or reverse proxy.
- Malicious browser extensions or a compromised phone of the owner.
- Multiple users. Waraq has no isolation between people, because there is only one account. Anyone you give the password to has full access.
