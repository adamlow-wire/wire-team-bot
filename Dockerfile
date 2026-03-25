# ── Stage 1: build ───────────────────────────────────────────────────────────
# Install all dependencies (including devDeps so pbjs is available for the
# SDK's proto:generate step), compile TypeScript, then prune to prod-only deps.
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
COPY wire-apps-js-sdk ./wire-apps-js-sdk
COPY prisma ./prisma

# Full install — devDependencies required for sdk:setup (pbjs) and tsc.
RUN npm ci

# npm hoists @wireapp/core-crypto to the root node_modules, but the SDK's
# fix-core-crypto-main script only patches wire-apps-js-sdk/node_modules/.
# Run it again from the project root so it targets the hoisted copy.
RUN node wire-apps-js-sdk/scripts/fix-core-crypto-main.js

# Generate the Prisma client from the schema before compiling TypeScript.
# Without this the @prisma/client types (InputJsonValue etc.) don't exist.
RUN npx prisma generate

COPY src ./src
RUN npm run build

# Drop devDependencies so the runner stage gets a clean prod-only node_modules.
RUN npm prune --omit=dev

# ── Stage 2: run ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY package.json ./
COPY entrypoint.sh ./entrypoint.sh
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/wire-apps-js-sdk ./wire-apps-js-sdk
# Migrations run at startup via entrypoint.sh
COPY prisma ./prisma

RUN chmod +x entrypoint.sh

ENTRYPOINT ["./entrypoint.sh"]
