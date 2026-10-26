# Contributing to Waraq

Thanks for helping. Waraq is a single-owner, self-hosted document scanner. Contributions that keep it simple, private and pleasant on a phone are very welcome.

## Ground rules

- **Single owner.** Waraq is built around one account on one server.
- **No telemetry.** No analytics, error-reporting services, tracking pixels or calls to third-party servers unless the owner explicitly configures them (like Google Drive).
- **Local first.** Everything must work without Google or any other cloud service.
- **Mobile first.** Check layouts at 360 px wide. Keep Arabic text and RTL content working.
- **Fictional data.** Use invented documents in tests, screenshots and bug reports. Never attach real documents, tokens or personal data.

Open an issue before large changes so we can agree on the approach.

## Development setup

Requirements: Node.js 22, and for OCR tests `ocrmypdf`, `tesseract-ocr-ara`, `tesseract-ocr-eng`, `qpdf` and `poppler-utils`.

```sh
git clone https://github.com/d7omdev/waraq.git && cd waraq
npm ci
cp .env.example .env
sed -i "s/^SESSION_SECRET=.*/SESSION_SECRET=$(openssl rand -hex 32)/" .env
DATA_DIR=./.data npm run dev
```

Open <http://localhost:3000> and create a throwaway owner.

## Checks

Run all of these before opening a pull request. CI runs the same set.

```sh
npm run lint
npm run typecheck
npm test                       # Vitest; every suite uses its own temporary DATA_DIR under /tmp
DATA_DIR=$(mktemp -d) npm run build
```

Add or update tests for behavior changes, especially anything in `src/lib/server` and the auth rules in `tests/server/owner.test.ts`. The project uses Next.js 16; its documentation ships in `node_modules/next/dist/docs/`, and some APIs differ from older versions.

## Pull requests

- One topic per pull request, with a short description of what and why.
- Keep commits focused and messages in the imperative ("Add page rotation shortcut").
- Update the docs in `docs/` when behavior or configuration changes, and add an entry to `CHANGELOG.md`.
- UI changes: include before and after screenshots with demo data, at phone and desktop widths.

## License

By contributing you agree that your contributions are licensed under the [GNU AGPL v3.0](LICENSE), the license of this project. Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).
