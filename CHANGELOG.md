# Changelog

All notable changes to Waraq Community are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-26

First public release of Waraq Community, the single-owner, self-hosted edition.

### Added

- First-run setup that creates the one owner account and then closes permanently
- Local password sign-in with rate limiting, session management and optional linked Google sign-in
- In-browser scanner with edge detection, perspective correction, crop, rotation and filters
- PDF and image import, PWA share target and a resumable upload queue
- Page editing, split, merge, extract, duplicate, compress and export (PDF, JPEG or PNG zip, text)
- OCR with OCRmyPDF and Tesseract, and Arabic and English full-text search
- Folders, tags, stars, and trash with configurable retention
- Public share links with expiry, password, download control, QR codes and revocation
- Optional Google Drive mirror using the `drive.file` scope
- Installable PWA with offline shell and update prompt
- Docker image and Compose file, systemd unit and Caddy example
- Command-line tools: `doctor`, `migrate`, `backup`, `restore` and `reset-password`
