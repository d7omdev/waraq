# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 NEXT_PHASE=phase-production-build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build && npm run build:ops

FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl ghostscript ocrmypdf poppler-utils qpdf tesseract-ocr-ara tesseract-ocr-eng && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 1001 waraq && useradd --system --uid 1001 --gid waraq --home /app waraq
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 DATA_DIR=/app/data HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build --chown=waraq:waraq /app/.next/standalone ./
COPY --from=build --chown=waraq:waraq /app/.next/static ./.next/static
COPY --from=build --chown=waraq:waraq /app/public ./public
COPY --from=build --chown=waraq:waraq /app/dist ./dist
RUN mkdir -p /app/data && chown waraq:waraq /app/data
USER waraq
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD curl -fsS http://127.0.0.1:3000/api/health >/dev/null || exit 1
CMD ["node", "server.js"]
