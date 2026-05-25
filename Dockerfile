# Multi-stage Next.js build for HoskSaid. Mirrors the cardano402 pattern:
# small final image, non-root user, no build tools in the runtime layer.

# ----- Stage 1: deps + build -------------------------------------------------
FROM node:20-alpine AS build

WORKDIR /app

# Install deps with the lockfile in place so the layer caches across code
# changes. We need devDependencies (next, typescript, tsx) to compile.
COPY package.json package-lock.json ./
RUN npm ci

# Source
COPY tsconfig.json next.config.ts postcss.config.mjs eslint.config.mjs ./
COPY public/ public/
COPY src/ src/

ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ----- Stage 2: runtime ------------------------------------------------------
FROM node:20-alpine AS runtime

WORKDIR /app

# yt-dlp + ffmpeg are required by src/lib/whisper.ts, which is the
# fallback path for videos whose YouTube auto-captions are missing.
# Without these, ingest silently fails on caption-less videos and the
# `failed` status piles up. Cost: ~80MB image growth.
RUN apk add --no-cache yt-dlp ffmpeg

RUN addgroup -g 1001 -S app && adduser -S -u 1001 -G app app

# Next standalone output bundles only the runtime deps the app traces. This
# is what `node server.js` starts.
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public

# For the scheduler profile we run the TypeScript scripts directly with tsx.
# Standalone trims node_modules to web-app deps only, so we layer the full
# tree on top of the standalone one. Anything standalone needs is already
# present in the full tree (superset), so this is safe.
COPY --from=build --chown=app:app /app/src ./src
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app package.json tsconfig.json ./

USER app

EXPOSE 3000
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/ || exit 1

CMD ["node", "server.js"]
