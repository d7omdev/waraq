# Operations

Day-two tasks for a running Waraq. Commands are shown for a source checkout (`npm run ...`). In Docker use `docker compose exec waraq node dist/ops.mjs <command>` and `node dist/reset-password.mjs` instead. On bare metal use `node /opt/waraq/current/dist/ops.mjs <command>` with the same environment as the service.

- [Health checks](#health-checks)
- [Doctor](#doctor)
- [Backups](#backups)
- [Restore](#restore)
- [Forgotten password](#forgotten-password)
- [Updates and rollback](#updates-and-rollback)
- [Data layout](#data-layout)
- [Troubleshooting](#troubleshooting)

## Health checks

`GET /api/health` runs `PRAGMA quick_check` and answers `200 {"status":"ok"}` or `503 {"status":"unavailable"}`. It reveals nothing else, so it is safe for uptime monitors. `GET /api/version` returns the build id the PWA uses to detect updates.

Waraq logs to stdout and stderr. Docker keeps them in `docker compose logs waraq`, systemd in `journalctl -u waraq`. Nothing is sent anywhere else.

## Doctor

```sh
npm run doctor
```

Checks that `SESSION_SECRET` is long enough, creates or upgrades the schema, checks that `DATA_DIR` is writable, runs SQLite `integrity_check`, confirms there is exactly one owner, and lists missing optional tools (`qpdf`, `pdftoppm`, `pdftotext`, `ocrmypdf`, `tesseract`). It exits non-zero on errors.

## Backups

```sh
npm run backup -- --output /safe/place/waraq-$(date +%F).tar.gz
```

The archive contains a consistent copy of the database (SQLite online backup API, safe while Waraq runs), every document PDF, and `manifest.json` with a SHA-256 checksum for each file. Page render caches are skipped because Waraq rebuilds them.

Docker:

```sh
docker compose exec waraq node dist/ops.mjs backup --output /app/data/backup.tar.gz
docker compose cp waraq:/app/data/backup.tar.gz ./waraq-$(date +%F).tar.gz
docker compose exec waraq rm /app/data/backup.tar.gz
```

Keep `SESSION_SECRET` together with your backups, in a password manager for example. Stored Google credentials are encrypted with a key derived from it. Without it a restore still has all documents, but you need to reconnect Google.

## Restore

Restore only writes into an empty data folder. It refuses to overwrite an existing `waraq.db`, and it verifies every checksum after unpacking.

Source checkout or bare metal:

```sh
sudo systemctl stop waraq                     # if it runs under systemd
mv /var/lib/waraq /var/lib/waraq.old          # keep the old data until you are happy
DATA_DIR=/var/lib/waraq npm run restore -- --input /safe/place/waraq.tar.gz --confirm
DATA_DIR=/var/lib/waraq npm run doctor
sudo systemctl start waraq
```

Docker, into a fresh volume:

```sh
docker compose down
docker volume rm waraq_waraq-data             # or keep it and restore into a new project directory
docker compose run --rm --no-deps -v "$PWD:/backup:ro" waraq \
  node dist/ops.mjs restore --input /backup/waraq.tar.gz --confirm
docker compose up -d
```

The volume name is `<project>_waraq-data`, where the project is the directory name by default. Check with `docker volume ls`.

## Forgotten password

There is no email reset. Reset the password on the host:

```sh
npm run reset-password                      # prompts twice, input is hidden
```

For automation, pass the password through the environment, never as an argument:

```sh
read -rs WARAQ_NEW_PASSWORD && export WARAQ_NEW_PASSWORD
npm run reset-password && unset WARAQ_NEW_PASSWORD
```

The tool writes a new password hash for the owner, clears the sign-in rate limit and signs out every session. Add `--keep-sessions` to stay signed in elsewhere, or `--data /path` to point at a data folder without setting `DATA_DIR`. It is safe to run while Waraq is running.

## Updates and rollback

Read [CHANGELOG.md](../CHANGELOG.md) first, then back up.

Docker:

```sh
git pull
docker compose up -d --build
docker compose ps                               # wait for "healthy"
docker image prune -f                           # optional: remove the old image
```

Bare metal: build the new version in a separate checkout, assemble it into a new folder such as `/opt/waraq/releases/<version>`, point `/opt/waraq/current` at it (a symlink makes rollback easy), run `node dist/ops.mjs migrate`, then `sudo systemctl restart waraq`. Check `/api/health` and open a document.

The schema only grows (new tables and columns), and migrations run automatically at start. To roll back, switch the code back. If a release note says the schema changed in a way older versions cannot read, restore the backup you took before updating.

## Data layout

```text
DATA_DIR/
  waraq.db              SQLite database (WAL mode): documents, folders, tags, shares, settings, OCR text, auth
  waraq.db-wal, -shm    SQLite write-ahead log, part of the database while Waraq runs
  docs/<id>/doc.pdf     the canonical PDF of each document
  docs/<id>/cache/v<n>/ page thumbnails and images, rebuilt on demand
  tmp/                  scratch space for uploads and OCR, cleaned automatically
```

Copying `DATA_DIR` while Waraq is stopped is also a valid backup.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `403` on every save, upload or sign-in | `PUBLIC_BASE_URL` does not match the address in the browser. Set the exact origin (scheme, host and port) and restart. |
| Camera does not open on the phone | The page is not served over HTTPS. Use a reverse proxy with a certificate. |
| Signed out after a restart | `SESSION_SECRET` or `BETTER_AUTH_SECRET` changed. Keep them stable. |
| Documents not searchable | OCR tools missing, or OCR still queued. Check Settings > OCR and `npm run doctor`. |
| `429 Too many attempts` at sign-in | Ten failed sign-ins in 15 minutes. Wait, or run `npm run reset-password`, which also clears the limit. |
| All visitors share one rate-limit bucket (log line from Better Auth about the client IP) | Waraq is reached without a trusted proxy header. Put a reverse proxy in front, and set `TRUSTED_PROXY_CIDRS` if it is not on loopback. |
| Drive shows "needs reconnect" | Google revoked the grant, or `SESSION_SECRET` changed. Reconnect in Settings > Google Drive. |
