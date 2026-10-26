# PharmaLink backend image, for the LOCAL staging rehearsal (ops/staging/README.md).
# Not a production artifact: see that README for what this does and does not verify.
#
# Targets:
#   runtime (default) - production dependencies + compiled dist/, runs `node dist/main.js`.
#   tools             - full dev dependencies + sources, for explicit one-off commands:
#                       `prisma migrate deploy` and `npm run prisma:seed` (ts-node).
# Migrations and seeding are deliberately NOT part of the runtime start command.

FROM node:22-bookworm-slim AS base
# OpenSSL is required by the Prisma query and schema engines.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# No Prisma telemetry/update checks from inside containers.
ENV CHECKPOINT_DISABLE=1

# Reproducible install from the committed lockfile (all dependencies, for build and tools).
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# Compile: `npm run build` runs `prisma generate` (prebuild) and then `nest build` -> dist/.
FROM deps AS build
COPY . .
RUN npm run build

# One-off tooling: migrations and the idempotent role/permission seed.
FROM build AS tools
USER node
CMD ["npx", "prisma", "migrate", "status"]

# Runtime: production dependencies only, plus the generated Prisma client and dist/.
FROM base AS runtime
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
# The generated client (and its query engine) comes from the build stage, which ran
# `prisma generate` against the committed schema with this same base image.
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
