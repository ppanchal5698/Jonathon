# syntax=docker/dockerfile:1
#
# Jonathon images: one Dockerfile, two runtime targets.
#   target "server" → API + MCP (apps/server/src/main.ts), the worker (src/worker.ts) and the ops CLIs (src/cli/*).
#   target "web"    → Next.js standalone server for the UI (port 3005), proxying /api/v1 to the API.
#
# Base image: Docker Official Image node, Debian 13 (trixie) slim, pinned by tag AND multi-arch index digest.
# Verified on 2026-11-20 with `docker buildx imagetools inspect node:24.22.3-trixie-slim`:
#   index digest sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0
#   platforms: linux/amd64, linux/arm64/v8 (also ppc64le, s390x; only amd64 is built and tested here)
# SQLite is Node's built-in node:sqlite (bundled SQLite with FTS5): no native addon, no compiler, no apt packages.
ARG NODE_IMAGE=node:24.22.3-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0

# ---------------------------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    NEXT_TELEMETRY_DISABLED=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# pnpm version comes from package.json "packageManager" (pnpm@12.16.1); corepack verifies the download's signature.
RUN corepack enable && corepack prepare pnpm@12.16.1 --activate
WORKDIR /app

# Manifests only, so dependency layers are cached until the lockfile or a package.json changes.
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
COPY packages/test-fixtures/package.json packages/test-fixtures/

# ---------------------------------------------------------------------------------------------------------------------
# Web build: full dependency install (build tools), then `next build` with standalone output.
FROM manifests AS web-build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --filter "@jonathon/web..."
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/web apps/web
# Next.js resolves rewrites at build time: the browser talks only to the UI origin, which proxies /api/v1 to this URL.
ARG JONATHON_API_URL=http://server:4100
ENV JONATHON_API_URL=${JONATHON_API_URL} \
    JONATHON_NEXT_STANDALONE=1 \
    NODE_ENV=production
RUN pnpm --filter @jonathon/web build

# ---------------------------------------------------------------------------------------------------------------------
# Server dependencies: production only, for the server and the workspace packages it uses.
FROM manifests AS server-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --prod --filter "@jonathon/server..."

# ---------------------------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS server
ENV NODE_ENV=production \
    JONATHON_DATA_DIR=/data \
    JONATHON_HEALTH_FILE=/tmp/worker-health
WORKDIR /app
# Root-owned, read-only to the app user: the running process cannot modify its own code.
COPY --from=server-deps /app/node_modules ./node_modules
COPY --from=server-deps /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=server-deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=server-deps /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY packages/core packages/core
COPY apps/server/package.json apps/server/tsconfig.json apps/server/
COPY apps/server/src apps/server/src
# /data is the data mount (owner: the uid the container runs as; see compose.yaml `user:`). Never chmod 777.
RUN mkdir -p /data /imports /backups && chown node:node /data
USER node
WORKDIR /app/apps/server
EXPOSE 4100
# `node --import tsx` runs TypeScript in-process: node is the signal-receiving process (tini from `init: true` is PID 1).
CMD ["node", "--import", "tsx", "src/main.ts"]

# ---------------------------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS web
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3005
WORKDIR /app
COPY --from=web-build /app/apps/web/.next/standalone ./
COPY --from=web-build /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3005
CMD ["node", "apps/web/server.js"]
