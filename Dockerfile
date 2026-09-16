# ── Stage 1: build ───────────────────────────────────────────────────────────
# Debian trixie (glibc 2.41) is required: @wireapp/wire-apps-js-sdk depends on
# @wireapp/core-crypto's native library, which needs glibc >= 2.38 on x86-64.
# Alpine (musl) and Debian bookworm (glibc 2.36) cannot load it.
FROM node:22-trixie-slim AS builder

WORKDIR /app

# OpenSSL is needed by the Prisma engines at generate time.
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json tsconfig.json ./
COPY prisma ./prisma

# Full install — devDependencies required for tsc.
#
# --ignore-scripts: npm 10's `npm ci` reads package metadata from the lockfile, which
# does not carry better-sqlite3's `gypfile: false`, so it wrongly runs an implicit
# `node-gyp rebuild` that fails on this toolchain-free image. better-sqlite3 13 ships
# prebuilt binaries in its tarball and needs no build step. Prisma is the only
# dependency whose install hooks we actually need, so rebuild just those.
RUN npm ci --ignore-scripts \
 && npm rebuild prisma @prisma/client @prisma/engines

# Generate the Prisma client from the schema before compiling TypeScript.
RUN npx prisma generate

COPY src ./src
RUN npm run build

# Drop devDependencies so the runner stage gets a clean prod-only node_modules.
RUN npm prune --omit=dev

# ── Stage 2: run ─────────────────────────────────────────────────────────────
FROM node:22-trixie-slim AS runner

WORKDIR /app

ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY entrypoint.sh ./entrypoint.sh
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
# Migrations run at startup via entrypoint.sh
COPY prisma ./prisma

# The Wire SDK keeps its SQLite DB and CoreCrypto keystore under ./storage
# (relative to WORKDIR). Mount a persistent volume at /app/storage.
RUN mkdir -p /app/storage && chmod +x entrypoint.sh

ENTRYPOINT ["./entrypoint.sh"]
