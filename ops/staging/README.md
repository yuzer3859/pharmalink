# Local staging stack and clean-install rehearsal

A **local-only** Docker Compose stack for the PharmaLink backend, plus a script that rehearses a clean installation on a brand-new, disposable database.

> [!IMPORTANT]
> **This is not a deployment and not evidence of production readiness.** It runs on your machine, with synthetic data only, in `NODE_ENV=development`. It proves the backend can be packaged, migrated, seeded and started from a clean database; it does **not** verify production-mode startup, real integrations, hosting, HTTPS, backups or security hardening. See [What this does not verify](#what-this-does-not-verify).

| File | Purpose |
|---|---|
| `backend/Dockerfile` | Node 22 image. `runtime` target (production dependencies + `dist/`, runs `node dist/main.js`) and `tools` target (dev dependencies, for `prisma migrate deploy` and the seed). |
| `backend/.dockerignore` | Keeps `node_modules`, build output, logs and every `.env*` file out of the build context. |
| `backend/.env.example` | Placeholders and generation commands for the local env file. |
| `compose.staging.yml` | PostgreSQL 16, Redis 7, one backend instance, and the one-off `tools` service. |
| `ops/staging/rehearse-clean-install.mjs` | The clean-install rehearsal (Node 22, no dependencies). |

## Stack

| Service | Image | Exposure | Notes |
|---|---|---|---|
| `postgres` | `postgres:16` | private network only | database `pharmalink_staging`, user `pharmalink`; data in the project's `pgdata` volume |
| `redis` | `redis:7` | private network only | no persistence (hot cache, never a system of record) |
| `backend` | built from `backend/` (`runtime`) | `127.0.0.1:${BACKEND_HOST_PORT:-3000}` only | health check on `GET /health/ready`; exactly one instance |
| `tools` | built from `backend/` (`tools`) | none | profile `tools`: never started by `up`; run explicitly for migrations and the seed |

`compose.staging.yml` sets `DATABASE_URL` and `REDIS_URL` to the stack's own services (overriding the env file), so the backend and the tools can only reach this disposable database. No host networking, privileged mode, Docker socket mounts or added capabilities. The containers run the app as the image's unprivileged `node` user.

Migrations and the seed are **not** part of the backend's start command. They are explicit one-off steps, so a restart can never migrate a database by surprise.

## Prerequisites

- Docker with Compose v2.24 or later (`docker compose version`)
- Node.js 22 (only for the rehearsal script)
- Host port 3000 free on 127.0.0.1, or set `BACKEND_HOST_PORT` in the env file

## Create the local env file

```bash
node ops/staging/rehearse-clean-install.mjs --init-env
```

This creates `backend/.env.staging` from `backend/.env.example` with random local-only values for `POSTGRES_PASSWORD`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` and `MASTER_ENCRYPTION_KEY`, and never prints them. It refuses to overwrite an existing file. Alternatively, copy the example and fill in each `REPLACE_ME` with the command shown next to it.

`backend/.env.staging` is gitignored (`backend/.gitignore`: `.env.*`, with only `.env.example` re-included). Never commit it, and never put production credentials or working provider keys in it. Do **not** set `DATABASE_URL`, `REDIS_URL`, `NODE_ENV` or `PORT` there: the rehearsal rejects them, because the stack sets them itself (`BACKEND_HOST_PORT` changes the host-side port).

## Run the rehearsal

```bash
node ops/staging/rehearse-clean-install.mjs          # run, then remove everything it created
node ops/staging/rehearse-clean-install.mjs --keep   # run and leave the stack up for inspection
```

It uses the dedicated Compose project **`pharmalink-staging-rehearsal`** and these steps, stopping at the first failure with the step name and a non-zero exit code:

1. Checks Node 22, Docker, Compose and the env file (placeholders, lengths, 32-byte key, forbidden variables), then validates the Compose file.
2. Removes any leftovers of **its own project only**, so the database is brand new.
3. Starts PostgreSQL and Redis, waits for both health checks, and confirms the database has **zero** tables.
4. Builds the `runtime` and `tools` images.
5. Runs `npx prisma migrate deploy` and reports applied/total migrations.
6. Runs `npm run prisma:seed` and records the role, permission and grant counts.
7. Runs the seed again and fails unless the counts are identical (and 14 roles exist).
8. Starts the backend, calls `GET /health/live` and `GET /health/ready` from the host (no token), then waits for the container health check.
9. Runs `npx prisma migrate deploy` again and fails unless it reports `No pending migrations to apply`.

Each HTTP probe has a 5-second timeout, and the script keeps itself alive until it finishes, so a connection held open by Docker's port proxy before the app listens can't end the run early. Its child processes get a sanitised environment: `DATABASE_URL`, `REDIS_URL`, `POSTGRES_PASSWORD` and `COMPOSE_*` from your shell are removed, so nothing outside the stack can be targeted.

It does **not** run `ops/predeploy/predeploy-readonly-checks.v2.1.sql`. That script reviews existing data before an upgrade; a clean install has no data to review (see below).

### What it creates and removes

Everything belongs to Compose project `pharmalink-staging-rehearsal`: its containers, its network, its `pgdata` volume, and the two images built for it. Without `--keep`, the script ends (on success or failure) with:

```bash
docker compose -p pharmalink-staging-rehearsal -f compose.staging.yml --env-file backend/.env.staging --profile tools down --volumes --remove-orphans --rmi local
```

That command is scoped to the project. The script never uses `docker system prune`, `docker volume prune` or any other global cleanup, and never touches other containers, volumes or images. Base images (`node`, `postgres`, `redis`) stay cached. `backend/.env.staging` is kept for the next run.

## Manual use

```bash
docker compose -f compose.staging.yml --env-file backend/.env.staging up -d postgres redis
docker compose -f compose.staging.yml --env-file backend/.env.staging run --rm tools npx prisma migrate deploy
docker compose -f compose.staging.yml --env-file backend/.env.staging run --rm tools npm run prisma:seed
docker compose -f compose.staging.yml --env-file backend/.env.staging up -d --build backend
curl http://127.0.0.1:3000/health/ready
```

This uses the project name `pharmalink-staging` from the Compose file, separate from the rehearsal's project. Stop it with `down`; add `--volumes` to delete its database.

## Logs and troubleshooting

- **Logs:** `docker compose -f compose.staging.yml --env-file backend/.env.staging logs -f backend` (add `-p pharmalink-staging-rehearsal` for a `--keep` rehearsal). In development mode OTP codes are written to these logs; treat them as sensitive even with synthetic users.
- **`Invalid environment configuration`:** a required variable is missing or invalid; compare with `backend/.env.example` and `backend/src/shared/config/env.validation.ts`.
- **`set POSTGRES_PASSWORD in backend/.env.staging`:** the env file is missing or not passed with `--env-file`.
- **Port already allocated:** something else uses 127.0.0.1:3000; set `BACKEND_HOST_PORT`.
- **`database is not empty`:** the rehearsal found tables in its fresh database; it never continues on a non-empty database.
- **Backend unhealthy:** read the logs; `/health/ready` fails when PostgreSQL is unreachable. A `401` from `/health/*` means the image predates #8.
- **Image build fails at `npm ci`:** `backend/package-lock.json` and `package.json` disagree; fix the lockfile, never switch to `npm install` in the image.

## Fresh install versus existing-data upgrade

This rehearsal is a **fresh install**: a new, empty database, every committed migration applied in order, then the idempotent seed. That is the path in `ops/predeploy/README.md` §0.1. A rehearsal on a throwaway database is not itself fresh-install evidence for a real environment; that evidence is recorded for the actual target database, as §0.1 describes.

An **existing-data upgrade** is different and not rehearsed here: follow `ops/predeploy/README.md` §0.2 and §3–7, including the read-only checks and Check 4b returning zero before `20261015000000_module05_bind_match_request_order` runs.

## Fayda decision: production-mode startup is not verified

**Decision (Work 57):**

- `MockFaydaProvider` throws at construction when `NODE_ENV=production`, so a mock identity check can never pass for real national-registry verification. **This guard is kept as is.**
- `NodeEnv` accepts only `development`, `test` and `production`. `test` disables the background jobs. The local stack therefore runs `NODE_ENV=development`, set in `compose.staging.yml`, with synthetic data only; `IDENTITY_VERIFICATION_PROVIDER` is left unset, which selects the mock outside production.
- **This rehearsal does not verify production-mode startup.** Nothing here should be described as a production-mode boot.
- **Production startup stays blocked** until a real `IIdentityVerificationProvider` is implemented, configured and wired, and verified.
- **Update (Work 58, ADR-027):** provider selection is now its own setting, `IDENTITY_VERIFICATION_PROVIDER` (`mock` | `fayda`). Production must set `fayda`; `mock` or unset is rejected at boot, and `fayda` fails at startup until a real adapter is bound to `FAYDA_VERIFICATION_PROVIDER`. The fail-closed paths and the wiring of a supplied adapter (with a test-only fake) are covered by tests. **Successful production startup with a real provider has not been tested**, because no real provider exists. See `backend/docs/runtime-identity-verification.md`.

  No `staging` value is added to `NodeEnv`; adding one needs every `isProduction`/`isTest`/`NODE_ENV` use traced and tested first.

### Other production blockers (not addressed here)

Fayda is not the only one. These development stand-ins have no production guard of their own:

| Area | Current state | Production implication |
|---|---|---|
| OTP | `InMemoryOtpService`: code logged, not delivered; lost on restart; per-process | Users can't receive codes; codes exposed in logs; single instance only |
| SMS | `UnconfiguredSmsTransport` | No SMS delivery |
| Payments | `MockPaymentProvider` approves gateway methods in-process; Telebirr adapter deliberately unimplemented | No real payment collection; mock approvals must never reach real customers |
| Proof of delivery | `InMemoryProofArtifactStorage` | Artifacts lost on restart; single instance only |
| Routing / ETA | `HaversineRoutingAdapter` (straight-line) | Approximate distances, fees and ETAs |
| HTTP hardening | No rate limiting, security headers or trusted-proxy setting | Required before any hosted exposure |
| Logging | JSON logs only when `NODE_ENV=production` | Development-mode logs are plain text |

## What this does not verify

- Production-mode (`NODE_ENV=production`) startup: blocked by the Fayda guard above.
- Real integrations: e-mail (Resend), push (FCM), SMS, payments, identity verification, routing.
- Hosting: HTTPS, reverse proxy, private access, multiple instances, resource limits.
- Backups, restore, monitoring and alerting.
- Front ends: `web/` and `app/` are not part of this stack.
- Any existing-data upgrade.

## Defects found by the rehearsal (fixed in #8)

The first rehearsal runs exposed two application defects. Both were fixed in a separate PR (#8) and merged into this branch from `main`:

1. `GET /health/live` and `GET /health/ready` were not public, so the global `JwtAuthGuard` answered every probe with `401`. They are now `@Public()`.
2. `PORT` from the environment always failed validation (untyped property). It is now typed, and `compose.staging.yml` sets `PORT: "3000"`.

## Rehearsal results (2026-10-26, local Docker 29.7.2, Compose v5.3.1, after merging #8)

`node ops/staging/rehearse-clean-install.mjs` exited 0 with `REHEARSAL PASSED`.

| Step | Result |
|---|---|
| 1. Prerequisites, env file, `docker compose config --quiet` | passed |
| 2. Scoped cleanup of the rehearsal project | passed |
| 3. PostgreSQL 16 and Redis 7 healthy; database empty | passed (0 public tables before install) |
| 4. Image build (`runtime` and `tools`): `npm ci` from the lockfile, `prisma generate`, `nest build` | passed |
| 5. `prisma migrate deploy` | passed: 33 migrations found, 33/33 applied, none rolled back |
| 6. Seed | passed: `Seeded 14 roles and 65 permissions.`; 14 roles, 65 permissions, 130 grants |
| 7. Seed again | passed: identical counts (14 / 65 / 130) |
| 8. Backend health, no token | passed: `/health/live` 200 `{"status":"ok"}`; `/health/ready` 200 with `database: up`; container health check `healthy` |
| 9. Second `prisma migrate deploy` | passed: `No pending migrations to apply.` |
| Cleanup | passed: no containers, volumes or images of the project remained; unrelated containers untouched |

From an earlier `--keep` run of the same stack: the backend runs as the unprivileged `node` user, logs `Redis connected.`, only the backend is published (on `127.0.0.1:3000`), and no container is privileged or has added capabilities.

Not run: production-mode startup (blocked by design, see the Fayda decision), host-side `npm ci` (the image build ran it instead), front-end builds, and anything involving real integrations or hosting. **A passing rehearsal shows the backend can be packaged and installed cleanly on your machine; it is not production readiness.**
