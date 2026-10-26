# Google sign-in and Drive mirror (optional)

Waraq works fully without Google. Configure it only if you want either of these:

- **Continue with Google**: a second way for the owner to sign in, after linking a Google account in Settings > Account.
- **Google Drive mirror**: a PDF copy of every document in a `Waraq` folder in your Drive.

Neither can create an account. Waraq refuses every sign-up path, and Google sign-in only succeeds for a Google account the signed-in owner linked earlier.

## 1. Create an OAuth client

1. Open the [Google Cloud console](https://console.cloud.google.com/) and create or pick a project.
2. **APIs & Services > Library**: enable the **Google Drive API** (only needed for the mirror).
3. **APIs & Services > OAuth consent screen**: choose *External*, fill in the app name and your email, and add yourself as a test user. Testing mode is fine for personal use. Scopes requested by Waraq:
   - sign-in: `openid`, `email`, `profile`
   - Drive mirror: `https://www.googleapis.com/auth/drive.file`
4. **APIs & Services > Credentials > Create credentials > OAuth client ID**, type **Web application**.
5. Under **Authorized redirect URIs** add both, using your exact `PUBLIC_BASE_URL`:

   ```text
   https://scan.example.com/api/auth/callback/google
   https://scan.example.com/api/drive/callback
   ```

6. Copy the client ID and secret.

## 2. Configure Waraq

Put them in `.env` (Docker) or `/etc/waraq.env` (systemd) and restart:

```sh
GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=<client secret>
```

For the Drive mirror only, you can instead paste the client ID and secret in Settings > Google Drive. Waraq stores the secret in its database, encrypted with a key derived from `SESSION_SECRET`. Values from the environment take precedence.

## 3. Link Google sign-in

Sign in with your password, open Settings > Account and tap **Link** next to Google. After that, **Continue with Google** on the sign-in page signs you in. The button is visible whenever Google is configured, but it only works for the linked account. Your password keeps working, and you can unlink Google at any time.

## 4. Connect the Drive mirror

Open Settings > Google Drive and tap **Connect**. Google asks for access to "files created by this app". After connecting:

- Waraq creates `Waraq/` in your Drive and uploads each document as a PDF, mirroring your folder tree.
- Edits, renames and moves are synced in the background. Settings > Google Drive shows progress and has **Sync everything now** and an **Auto mirror** switch.
- Moving a document to the Waraq trash moves its PDF to `Waraq/Trash`. Deleting it permanently moves the Drive file to the Drive trash. Waraq never permanently deletes Drive files.
- The `drive.file` scope only covers files Waraq created. Waraq cannot read or list anything else in your Drive.

Disconnecting stops syncing and deletes the stored token. Files already in Drive stay there. Your documents on the server are never affected by Drive.

## Troubleshooting

| Message | Fix |
| --- | --- |
| `redirect_uri_mismatch` | The redirect URI in Google Cloud must match `PUBLIC_BASE_URL` exactly, including `https` and any port. |
| "This Google account isn't linked to the owner" | Sign in with your password and link Google in Settings > Account first. |
| `access_denied` while the app is in testing | Add your Google account as a test user on the consent screen. |
| Drive "needs reconnect" | The grant was revoked or `SESSION_SECRET` changed. Connect again. |
