# HTTP API

Waraq's UI uses these routes. They are not a versioned public API, but they are stable enough for scripts on your own server.

## Conventions

- **Auth.** Private routes need the owner's session cookie (`waraq.session_token`, set by `POST /api/auth/sign-in/username`). Without it they answer `401`.
- **CSRF.** `POST`, `PATCH`, `PUT` and `DELETE` must send an `Origin` header equal to `PUBLIC_BASE_URL` (or the request host). Browsers do this automatically. Cross-site requests get `403`.
- **Errors** are JSON: `{"error": "human readable message", "code": "machine_code"}`.
- **Caching.** JSON responses are `private, no-store` unless noted. File and image routes support `Range` requests and use the document version for cache keys.
- **IDs** are 16-character random strings. Page indexes start at `0`.

## Public routes

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/health` | `200 {"status":"ok"}` or `503`. |
| `GET` | `/api/version` | Build id, used by the PWA to detect updates. |
| `GET` | `/api/setup` | `{"open": true}` until the owner exists. |
| `POST` | `/api/setup` | `{"username", "email"?, "password"}`. `201` once, then `409` forever. Rate limited. |
| `GET` `POST` | `/api/auth/*` | Better Auth, see below. |
| `GET` | `/api/public/s/:token` | Share metadata: title, page count, download flag, page list. `403` with `code: "password_required"` when locked, `404` unknown, `410` expired or revoked. |
| `POST` | `/api/public/s/:token/unlock` | `{"password"}`. Sets a share-scoped unlock cookie. Rate limited. |
| `GET` | `/api/public/s/:token/file` | The PDF, only when downloads are allowed. |
| `GET` | `/api/public/s/:token/pages/:index/thumb` | Page thumbnail. |
| `GET` | `/api/public/s/:token/pages/:index/image` | Page image. |

### Auth endpoints in use

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/auth/sign-in/username` | `{"username", "password"}`. 10 attempts per 15 minutes. |
| `POST` | `/api/auth/sign-out` | |
| `GET` | `/api/auth/get-session` | |
| `POST` | `/api/auth/sign-in/social` | `{"provider": "google", "callbackURL", "errorCallbackURL"}`. Works only for a Google account linked to the owner. |
| `POST` | `/api/auth/link-social` | Owner session required. Starts Google linking. |
| `POST` | `/api/auth/unlink-account` | Owner session required. |
| `POST` | `/api/auth/change-password` | Owner session required. |

Refused with `403` before Better Auth sees them: `/api/auth/sign-up/*`, `/request-password-reset`, `/forget-password`, `/reset-password`, `/change-email`, `/delete-user`, `/send-verification-email`, `/verify-email`.

## Owner routes

### Account and devices

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/auth/me` | Profile, local storage use and Drive status. |
| `GET` | `/api/account/accounts` | Linked sign-in methods, and whether Google is configured. |
| `GET` | `/api/sessions` | Signed-in sessions. |
| `DELETE` | `/api/sessions/:id` | Sign out one session. |
| `POST` | `/api/sessions/revoke-others` | Sign out every other session. |
| `GET` `PATCH` | `/api/prefs` | Owner preferences (scanner, library, OCR languages, sharing defaults, trash retention). |

### Documents

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/docs` | Query: `q`, `folderId`, `includeSubfolders`, `tag`, `starred`, `trash`, `sort` (`updated`, `created`, `title`, `size`), `dir`, `limit` (max 200), `cursor`. Returns `{items, nextCursor}`. |
| `POST` | `/api/docs` | Multipart: `files` (PDFs and images), `title`, `folderId`, `source` (`scan` or `import`). `201` with the document (status `processing`). |
| `GET` | `/api/docs/:id` | Document detail with pages. |
| `PATCH` | `/api/docs/:id` | `{"title"?, "folderId"?, "tags"?, "starred"?}`. |
| `DELETE` | `/api/docs/:id` | Moves to trash. `?permanent=1` deletes a trashed document for good. |
| `POST` | `/api/docs/:id/restore` | Restore from trash. |
| `POST` | `/api/docs/:id/retry` | Retry a failed build. |
| `GET` | `/api/docs/:id/file` | The PDF. |
| `GET` | `/api/docs/:id/text` | OCR text. |
| `GET` `POST` | `/api/docs/:id/export` | `format`: `pdf`, `jpg-zip`, `png-zip`, `txt`; optional `pages`; `POST` also takes a PDF `password`. |
| `POST` | `/api/docs/:id/ocr` | Queue OCR for this document. |
| `POST` | `/api/docs/:id/pages` | Multipart: append pages. |
| `POST` | `/api/docs/:id/pages/ops` | `{"ops": [...]}` with `rotate`, `delete`, `reorder`, `duplicate`. |
| `POST` | `/api/docs/:id/pages/:index/replace` | Multipart: replace one page (re-crop, new filter). |
| `GET` | `/api/docs/:id/pages/:index/thumb` | Page thumbnail (WebP). |
| `GET` | `/api/docs/:id/pages/:index/image` | Page image. |
| `POST` | `/api/docs/:id/extract` | `{"pages", "title"?, "removeFromSource"?}` into a new document. |
| `POST` | `/api/docs/:id/split` | `{"ranges"}` or `{"every"}`. |
| `POST` | `/api/docs/:id/duplicate` | Copy the document. |
| `POST` | `/api/docs/:id/compress` | `{"level": "low" \| "medium" \| "high"}`. |
| `POST` | `/api/docs/merge` | `{"ids", "title"?, "trashSources"?}`. |
| `GET` `POST` | `/api/docs/:id/shares` | List or create links: `{"expiresIn": "1h" \| "1d" \| "7d" \| "30d" \| "never", "password"?, "allowDownload"?}`. |
| `POST` | `/share-target` | PWA share target (multipart from the OS share sheet). Redirects into the app. |

### Folders, tags and OCR

| Method | Path | Notes |
| --- | --- | --- |
| `GET` `POST` | `/api/folders` | List, or create `{"name", "parentId"?, "color"?}`. |
| `GET` `PATCH` `DELETE` | `/api/folders/:id` | Rename, move or recolor; delete. |
| `GET` | `/api/tags` | Tags with counts. |
| `GET` | `/api/ocr/status` | Queue length, current document and engine availability. |
| `POST` | `/api/ocr/rerun` | `{"ids"}` or `{"all": true}`. |

### Shares

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/shares` | `?status=active\|expired\|revoked\|all`. |
| `GET` `PATCH` `DELETE` | `/api/shares/:id` | Inspect, change expiry, password or download flag, or revoke. |
| `GET` | `/api/shares/:id/qr` | QR code (PNG). |
| `POST` | `/api/shares/revoke-all` | Revoke all links, or `{"docId"}` for one document. |

### Google Drive mirror

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/drive/status` | Connection, sync progress, errors. |
| `GET` | `/api/drive/connect` | Redirects to Google consent (`drive.file`). |
| `GET` | `/api/drive/callback` | OAuth redirect target. |
| `POST` | `/api/drive/disconnect` | Stop mirroring and forget the token. |
| `PATCH` | `/api/drive/settings` | `{"autoSync"}`. |
| `POST` | `/api/drive/sync` | Sync everything now. |
| `POST` `DELETE` | `/api/drive/config` | Save or remove an OAuth client entered in Settings. |

## Not present

Waraq Community has no admin, invite, sign-up, user management, analytics, telemetry, billing or quota routes. Paths such as `/admin`, `/api/admin/*`, `/api/telemetry` and `/invite/*` return `404` (anonymous requests to unknown paths are first redirected to sign-in).
