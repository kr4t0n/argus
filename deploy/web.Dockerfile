# syntax=docker/dockerfile:1.7
# Multi-stage build for the Argus React/Vite web app.
#
# This image renders runtime configuration into `/config.js` at
# container start (see `deploy/web.entrypoint.sh`), so a single image
# can be retargeted across environments by setting `ARGUS_API_URL` /
# `ARGUS_WS_URL` env vars on the container — no rebuild required.
#
# The build-time `VITE_API_URL` / `VITE_WS_URL` args are still
# supported as a fallback for users who want a fully self-contained
# image with no entrypoint behaviour. The runtime values win when both
# are present (see `apps/web/src/lib/host.ts`).

# ── Stage 1: install deps ─────────────────────────────────────────────
FROM node:20-alpine AS deps
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /repo

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
COPY packages/shared-types/package.json ./packages/shared-types/

RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ── Stage 2: build the SPA ────────────────────────────────────────────
FROM deps AS builder
COPY packages/shared-types ./packages/shared-types
COPY apps/web ./apps/web

# Build args are passed through Vite's `import.meta.env.VITE_*`. Empty
# strings are the default and the recommended setting — leave the
# bundle untouched and let the entrypoint inject runtime config.
ARG VITE_API_URL=""
ARG VITE_WS_URL=""
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_WS_URL=$VITE_WS_URL

RUN pnpm --filter @argus/shared-types build \
 && pnpm --filter @argus/web build

# ── Stage 3: nginx static-serve ───────────────────────────────────────
FROM nginx:alpine AS runtime
COPY deploy/web.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /repo/apps/web/dist /usr/share/nginx/html

# nginx:alpine's stock entrypoint sources every executable script under
# /docker-entrypoint.d/ before exec'ing nginx, which is the cleanest
# hook point. Numeric prefix orders us after the official 10-/20-/30-
# scripts (env templating, listen tweaks, …) so we don't fight them.
COPY deploy/web.entrypoint.sh /docker-entrypoint.d/40-argus-runtime-config.sh
RUN chmod +x /docker-entrypoint.d/40-argus-runtime-config.sh

EXPOSE 80
