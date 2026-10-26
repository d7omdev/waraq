# Setup

Waraq runs as one Node.js process with a SQLite database and a data folder. Pick Docker (recommended) or bare metal.

- [Requirements](#requirements)
- [Docker Compose](#docker-compose)
- [Reverse proxy with HTTPS](#reverse-proxy-with-https)
- [Bare metal with systemd](#bare-metal-with-systemd)
- [Environment variables](#environment-variables)
- [First run](#first-run)

## Requirements

| | Docker | Bare metal |
| --- | --- | --- |
| Runtime | Docker Engine 24+ with Compose v2 | Node.js 22 LTS and a C/C++ toolchain for native modules |
| Memory | 2 GB recommended (OCR and PDF rendering) | same |
| Disk | about 1.5 GB for the image, plus your documents | about 1 GB for `node_modules` and the build |
| OCR tools | included | `ocrmypdf`, `tesseract-ocr-ara`, `tesseract-ocr-eng`, `qpdf`, `poppler-utils`, `ghostscript` |

Without the OCR tools Waraq still works, but documents are not text-searchable. Settings > OCR shows the engine status.

## Docker Compose

```sh
git clone https://github.com/d7omdev/waraq.git
cd waraq
cp .env.example .env
sed -i "s/^SESSION_SECRET=.*/SESSION_SECRET=$(openssl rand -hex 32)/" .env
# set PUBLIC_BASE_URL in .env to the URL you will open, for example https://scan.example.com
docker compose up -d --build
docker compose ps        # STATUS becomes "healthy" after about 20 seconds
```

What the compose file does:

- builds the image from the `Dockerfile` (Node 22 on Debian bookworm, OCR tools, non-root user `waraq` with uid 1001)
- publishes the app on `127.0.0.1:3000` only. Change the address and port with `WARAQ_BIND` and `WARAQ_PORT`, for example `WARAQ_PORT=8080 docker compose up -d`
- keeps everything in the named volume `waraq-data`, mounted at `/app/data`. The volume survives `docker compose down`, rebuilds and upgrades. Only `docker compose down -v` deletes it
- runs a health check against `/api/health` every 30 seconds

The command-line tools are bundled into the image as `dist/ops.mjs` and `dist/reset-password.mjs`:

```sh
docker compose exec waraq node dist/ops.mjs doctor
docker compose exec -it waraq node dist/reset-password.mjs
```

## Reverse proxy with HTTPS

Phones need HTTPS for the camera, and secure cookies need it too. Any reverse proxy works. With Caddy, which gets certificates automatically, start from [`deploy/Caddyfile.example`](../deploy/Caddyfile.example):

```caddyfile
scan.example.com {
  encode zstd gzip
  request_body {
    max_size 310MB
  }
  reverse_proxy 127.0.0.1:3000
}
```

Then set `PUBLIC_BASE_URL=https://scan.example.com` in `.env` and restart Waraq. The value must match the address in the browser exactly. Waraq uses it for cookies, the Origin check on every write, share links and the Google redirect URIs.

Waraq reads the client address for rate limiting from `X-Forwarded-For` and trusts only loopback hops by default. If your proxy reaches Waraq from another host or container network, add that network to `TRUSTED_PROXY_CIDRS` (for example `172.16.0.0/12`). If Cloudflare proxies your domain, add the keyword `cloudflare`. Do not publish the Node port to the internet without a proxy, because clients could then forge `X-Forwarded-For`.

Uploads can be large (up to 300 MB per request and 60 MB per file), so keep the proxy body limit above 300 MB.

## Bare metal with systemd

```sh
sudo apt install ocrmypdf tesseract-ocr-ara tesseract-ocr-eng qpdf poppler-utils ghostscript build-essential python3
# install Node.js 22 LTS from nodejs.org or your distribution
sudo useradd --system --home-dir /var/lib/waraq --create-home waraq
sudo mkdir -p /opt/waraq && sudo chown waraq: /opt/waraq

sudo -u waraq git clone https://github.com/d7omdev/waraq.git /opt/waraq/src
cd /opt/waraq/src
sudo -u waraq npm ci
sudo -u waraq npm run build
sudo -u waraq npm run build:ops

# assemble the standalone server
sudo -u waraq mkdir -p /opt/waraq/current/.next
sudo -u waraq cp -r .next/standalone/. /opt/waraq/current/
sudo -u waraq cp -r .next/static /opt/waraq/current/.next/static
sudo -u waraq cp -r public dist /opt/waraq/current/
```

Create `/etc/waraq.env` from [`.env.example`](../.env.example), readable only by root (`sudo chmod 600 /etc/waraq.env`). At least:

```sh
SESSION_SECRET=<output of: openssl rand -hex 32>
PUBLIC_BASE_URL=https://scan.example.com
DATA_DIR=/var/lib/waraq
HOSTNAME=127.0.0.1
PORT=3000
NODE_ENV=production
```

Install the unit from [`deploy/waraq.service`](../deploy/waraq.service):

```sh
sudo cp deploy/waraq.service /etc/systemd/system/waraq.service
sudo systemctl daemon-reload
sudo systemctl enable --now waraq
systemctl status waraq
```

The unit runs as `waraq`, keeps the file system read-only except `/var/lib/waraq`, and restarts on failure. Adjust `ExecStart` if Node is not at `/usr/bin/node`.

Run the command-line tools against the same data folder, for example:

```sh
sudo sh -c 'set -a; . /etc/waraq.env; exec runuser -u waraq -- node /opt/waraq/current/dist/ops.mjs doctor'
```

## Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `SESSION_SECRET` | yes | none | At least 32 characters. Signs share-unlock cookies, derives the Better Auth secret (unless `BETTER_AUTH_SECRET` is set) and encrypts stored Google credentials. Changing it signs you out and makes Waraq forget the Drive connection. |
| `PUBLIC_BASE_URL` | yes in production | `http://localhost:3000` | Exact public origin, no trailing slash. |
| `DATA_DIR` | no | `./.data` (Docker: `/app/data`) | Database, PDFs and render cache. |
| `BETTER_AUTH_SECRET` | no | derived | Separate auth secret, 32+ characters. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | no | empty | Optional. Enables linking Google sign-in to the owner, and is the default client for the Drive mirror. See [Google OAuth](GOOGLE-OAUTH.md). |
| `TRUSTED_PROXY_CIDRS` | no | empty | Extra reverse-proxy networks to trust, comma separated, or `cloudflare`. |
| `WARAQ_OCR_LANGS` | no | from Settings | Tesseract languages, for example `ara+eng`. Overrides Settings > OCR. |
| `WARAQ_OCR_JOBS` | no | `2` | Parallel OCRmyPDF workers per document (1 to 4). |
| `WARAQ_OCR_ROTATE` | no | off | `1` adds `--rotate-pages` (needs `osd.traineddata`). |
| `WARAQ_TESSDATA_DIR` | no | system | Alternative tessdata folder, used only when it has every selected language. |
| `WARAQ_TZ` | no | server time zone | Time zone for default titles such as "Scan 2026-01-31 14:05". |
| `HOSTNAME`, `PORT` | no | `0.0.0.0`, `3000` | Listen address of the standalone server. |

## First run

1. Open `PUBLIC_BASE_URL`. You land on **Set up Waraq**.
2. Choose a username and a password of at least 12 characters. Email is optional and only shown in your profile.
3. Waraq creates the owner and sends you to the sign-in page. From then on `/setup` redirects to sign-in and `POST /api/setup` answers `409`.
4. Sign in, then open Settings to pick OCR languages and scanner defaults, and optionally connect Google.

Run `npm run doctor` (or `node dist/ops.mjs doctor` in Docker) any time to check the configuration.
