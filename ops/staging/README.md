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
| `ops/staging/env-file.mjs` | Generation and validation of the local env file, used by the rehearsal. Tests: `node --test ops/staging/env-file.test.mjs`. |
| `backend/test/staging/otp-store.smoke.ts` | The OTP smoke test the rehearsal runs in the `tools` image. Its own e2e spec is `backend/test/staging/otp-store-smoke.e2e-spec.ts`. |

## Stack

| Service | Image | Exposure | Notes |
|---|---|---|---|
| `postgres` | `postgres:16` | private network only | database `pharmalink_staging`, user `pharmalink`; data in the project's `pgdata` volume |
| `redis` | `redis:7` | private network only | no persistence; holds caches and this stack's live OTP challenges |
| `backend` | built from `backend/` (`runtime`) | `127.0.0.1:${BACKEND_HOST_PORT:-3000}` only | `OTP_STORE=redis`; health check on `GET /health/ready`; exactly one instance |
| `tools` | built from `backend/` (`tools`) | none | profile `tools`: never started by `up`; run explicitly for migrations, the seed and the OTP smoke test |

`compose.staging.yml` sets `DATABASE_URL` and `REDIS_URL` to the stack's own services (overriding the env file), so the backend and the tools can only reach this disposable database and Redis. No host networking, privileged mode, Docker socket mounts or added capabilities. The containers run the app as the image's unprivileged `node` user.

### OTP storage: Redis, explicitly (Work 61)

The backend and the `tools` service both set **`OTP_STORE=redis`** in `compose.staging.yml`. This stack therefore keeps OTP challenges in its own Redis through `RedisOtpService`, the adapter production must use. The setting is explicit, not a default: with `NODE_ENV=development`, leaving it unset would select the in-memory store. Using Redis here means the rehearsal exercises the same hashing, TTL, attempt limit, single use and resend cooldown as production would, and fails closed the same way when Redis is down (`backend/docs/otp-storage.md`).

- **`OTP_HASH_SECRET`** reaches Compose by interpolation from `--env-file backend/.env.staging`, not only through `env_file`. `${OTP_HASH_SECRET:?…}` makes `docker compose` stop before starting anything if it is missing, so always pass `--env-file backend/.env.staging`.
- **`NODE_ENV` stays `development`** (see the Fayda decision below), so production-mode startup is still not exercised.
- **Still exactly one backend.** Redis-backed OTPs would work across instances, but in-memory proof-of-delivery storage and the in-process event bus still don't.
- **This Redis is not a production Redis:** no authentication, TLS, persistence, replication, backup or recovery. A restart drops live challenges, and users request a new code.

Migrations and the seed are **not** part of the backend's start command. They are explicit one-off steps, so a restart can never migrate a database by surprise.

## Prerequisites

- Docker with Compose v2.24 or later (`docker compose version`)
- Node.js 22 (only for the rehearsal script)
- Host port 3000 free on 127.0.0.1, or set `BACKEND_HOST_PORT` in the env file

## Create the local env file

```bash
node ops/staging/rehearse-clean-install.mjs --init-env
```

This creates `backend/.env.staging` from `backend/.env.example` with random local-only values for `POSTGRES_PASSWORD`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `MASTER_ENCRYPTION_KEY` and `OTP_HASH_SECRET`, and never prints them. It refuses to overwrite an existing file. Alternatively, copy the example and fill in each `REPLACE_ME` with the command shown next to it.

**`OTP_HASH_SECRET`** is 32 bytes from Node's CSPRNG (`crypto.randomBytes`), base64url-encoded (43 characters), generated fresh for each new file. Before the file is written, the value is checked against the rules the backend applies at boot (`assertOtpHashSecret`):
- at least 32 characters;
- no placeholder text, and at least 8 distinct characters;
- not a copy of `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` or `MASTER_ENCRYPTION_KEY`.

The rehearsal checks it again before every run, and the backend and the smoke test check it a third time at startup. No check prints the value: messages name the variable and the rule only.

**An env file from before Work 61** has no `OTP_HASH_SECRET`, and the rehearsal rejects it (`OTP_HASH_SECRET is missing or still a placeholder`). Either add the variable with the command in `backend/.env.example`, or move the old file aside and run `--init-env` again.

`backend/.env.staging` is gitignored (`backend/.gitignore`: `.env.*`, with only `.env.example` re-included). Never commit it, and never put production credentials or working provider keys in it. Do **not** set `DATABASE_URL`, `REDIS_URL`, `NODE_ENV`, `PORT` or `OTP_STORE` there: the rehearsal rejects them, because the stack sets them itself (`BACKEND_HOST_PORT` changes the host-side port).

## Run the rehearsal

```bash
node ops/staging/rehearse-clean-install.mjs          # run, then remove everything it created
node ops/staging/rehearse-clean-install.mjs --keep   # run and leave the stack up for inspection
```

It uses the dedicated Compose project **`pharmalink-staging-rehearsal`** and these steps, stopping at the first failure with the step name and a non-zero exit code:

1. Checks Node 22, Docker, Compose and the env file (placeholders, lengths, 32-byte key, `OTP_HASH_SECRET`, forbidden variables). Then validates the Compose file with `config --quiet`, which never prints the resolved values.
2. Records the running containers outside its project and lists what already exists under its project name. If a container of that project was created from a different compose file, ownership is unclear, so it stops without deleting anything. Otherwise it removes any leftovers of **its own project only**, so the database is brand new.
3. Starts PostgreSQL and Redis, waits for both health checks, and confirms the database has **zero** tables.
4. Builds the `runtime` and `tools` images.
5. Runs `npx prisma migrate deploy` and reports applied/total migrations.
6. Runs `npm run prisma:seed` and records the role, permission and grant counts.
7. Runs the seed again and fails unless the counts are identical (and 14 roles exist).
8. Starts the backend, calls `GET /health/live` and `GET /health/ready` from the host (no token), then waits for the container health check.
9. Checks Redis and the backend's effective OTP store:
   - `redis-cli ping` returns `PONG`;
   - inside the backend container, `OTP_STORE` is `redis`, and `OTP_HASH_SECRET` (at least 32 characters) and `REDIS_URL` are set. Only the store name and yes/no answers leave the container;
   - the backend log has `Redis connected.` and `OTP challenges are stored in Redis (OTP_STORE=redis).`, and no in-memory OTP warning;
   - without an e-mail provider (no `RESEND_*` in the env file), `POST /auth/resend-otp` for a synthetic `.invalid` address and for a phone number both get `503 DEPENDENCY_UNAVAILABLE`, and the OTP key count in the stack's Redis doesn't change. That is Work 62's truthful delivery: nothing is issued when nothing can be sent. Keys are counted inside the Redis container. With Resend configured, this check is skipped so that no undeliverable address is mailed; use the e-mail OTP smoke test below instead.
10. Runs the OTP smoke test in the `tools` image (below).
11. Runs `npx prisma migrate deploy` again and fails unless it reports `No pending migrations to apply`.

After a normal run, it removes the project (see below). It then checks that no container, volume, network or image of the project is left, and that the unrelated containers it recorded in step 2 are still running.

Each HTTP probe has a timeout, and the script keeps itself alive until it finishes, so a connection held open by Docker's port proxy before the app listens can't end the run early.

Its child processes get a sanitised environment. These variables from your shell are removed: `DATABASE_URL`, `REDIS_URL`, `POSTGRES_PASSWORD`, `OTP_STORE`, `OTP_HASH_SECRET`, `BACKEND_HOST_PORT` and `COMPOSE_*`. So nothing outside the stack can be targeted, and a shell value can't replace one from the env file (Compose prefers the shell over `--env-file` when interpolating).

### The OTP smoke test

```bash
docker compose -p pharmalink-staging-rehearsal -f compose.staging.yml --env-file backend/.env.staging run --rm tools npx ts-node test/staging/otp-store.smoke.ts
```

It builds a small Nest context from the backend's own config module (`validateEnv`), logger, Redis module and the identity module's OTP binding (`otpProviders`), and resolves `OTP_SERVICE` from it. It deliberately does not boot the whole application: that would start a second backend (background jobs, outbox relay, event bus) beside the stack's single instance.

Using a synthetic address under `.invalid` with a random suffix, it checks:

1. `OTP_SERVICE` is `RedisOtpService`, not the in-memory store, and Redis is connected;
2. a `REGISTER` challenge is issued with a six-digit code, kept in the process's memory only;
3. an immediate second issue for the same address and purpose is refused with `COOLDOWN`;
4. a wrong code returns `INVALID`;
5. the right code then returns `OK`;
6. replaying it returns `EXPIRED`;
7. a live challenge for another purpose (`LOGIN`) rejects the `REGISTER` code with `INVALID` and still accepts its own.

**Output and exit code:** it prints only `PASS <check>` lines and a summary, never a code, hash, address, secret or connection string. It exits `1` on the first failed check, or on any configuration or Redis error.

**Clean-up:** it always closes its Nest context and Redis connections. Its own checks consume the challenges it creates; the cooldown keys expire by themselves after `OTP_RESEND_COOLDOWN_SECONDS`. It deletes nothing in Redis.

**What it proves:** the stack's configuration selects the Redis store, and that store issues, rate-limits, verifies once and isolates codes against the stack's real Redis.

**What it doesn't prove:** that anyone receives a code. Nothing is delivered; the check reads the code inside its own process.

It does **not** run `ops/predeploy/predeploy-readonly-checks.v2.1.sql`. That script reviews existing data before an upgrade; a clean install has no data to review (see below).

### E-mail OTP smoke test (manual, sends real e-mail)

Run this only with your own Resend account and your own inbox; never use a customer address. It checks the full registration journey by e-mail against a `--keep` stack. Without credentials, skip it: nothing else in this README sends e-mail.

1. Add both settings to `backend/.env.staging` (gitignored):
   - `RESEND_API_KEY=re_…` — a key with sending access;
   - `RESEND_FROM_EMAIL=PharmaLink <otp@your-verified-domain>`.

   With Resend's shared test sender (`onboarding@resend.dev`), only your own Resend account address receives mail.
2. Run the rehearsal with `--keep`. Step 1 reports `e-mail provider (Resend): configured`.
3. Register with your own address, with nothing echoed to the terminal but the response:

   ```bash
   curl -s -X POST http://127.0.0.1:3000/auth/register -H 'content-type: application/json' -d '{"email":"you@your-inbox","password":"<a strong password>"}'
   ```

   Expect `201` with `verification.channel: "EMAIL"`. The code arrives at your inbox ("Your PharmaLink verification code"). Read it there; it is never in the logs or the response.
4. Verify:

   ```bash
   curl -s -X POST http://127.0.0.1:3000/auth/verify-otp -H 'content-type: application/json' -d '{"identifier":"you@your-inbox","code":"<code from the e-mail>","purpose":"REGISTER"}'
   ```

   Expect `201` with `verified: true`.
5. Remove the stack with the `down` command printed by `--keep`.

If a request returns `503 DEPENDENCY_UNAVAILABLE` with `reason: FAILED`, Resend refused the message. The backend log names the template and Resend's result code only, e.g. `result=NOT_CONFIGURED`: a key without sending access, an unverified sender domain, or a recipient that Resend's test sender doesn't allow.

### What it creates and removes

Everything belongs to Compose project `pharmalink-staging-rehearsal`: its containers, its network, its `pgdata` volume, and the two images built for it. With `--keep`, the stack stays up for inspection and the script prints the command to remove it. Without `--keep`, the script ends (on success or failure) with:

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

- **Logs:** `docker compose -f compose.staging.yml --env-file backend/.env.staging logs -f backend` (add `-p pharmalink-staging-rehearsal` for a `--keep` rehearsal). OTP codes are never written to these logs (since Work 60). They arrive only by e-mail, and only when Resend is configured (Work 62).
- **`RESEND_API_KEY and RESEND_FROM_EMAIL must be set together`:** set both or neither. With neither, the stack runs, but every OTP request gets `503`.
- **OTP requests return `503` with `details.channel: "EMAIL"`:** with `reason: NOT_CONFIGURED`, Resend isn't configured; with `reason: FAILED`, Resend didn't accept the message (see the backend log's `result=…` code). No code was delivered in either case. After a `FAILED`, wait `details.retryAfterSeconds` before asking again.
- **OTP requests return `503` with `details.channel: "SMS"`, or registration returns `SMS_UNAVAILABLE`:** SMS has no provider; use an e-mail address.
- **`required variable OTP_HASH_SECRET is missing a value`:** Compose didn't get the env file for interpolation. Pass `--env-file backend/.env.staging`, and make sure the file has the variable.
- **`OTP_HASH_SECRET must be at least 32 characters`, `looks like a placeholder` or `must be a dedicated secret`:** regenerate it with the command in `backend/.env.example`.
  - Don't print the env file, or run `docker compose config` without `--quiet`, to debug this: both show every secret.
  - To check what the backend sees without revealing the value: `docker compose … exec -T backend node -e "console.log(process.env.OTP_STORE, (process.env.OTP_HASH_SECRET || '').length)"`.
- **OTP requests return `503 DEPENDENCY_UNAVAILABLE` without a `details.channel`:** the backend can't reach Redis. Check `docker compose … ps redis` and `docker compose … exec -T redis redis-cli ping`, and look for `Redis connected.` in the backend log. The store never falls back to memory.
- **The smoke test fails at check 1:** the `tools` service isn't getting `OTP_STORE=redis` or `REDIS_URL`. Check that `compose.staging.yml` wasn't changed, and that you ran the test with the same `-p`, `-f` and `--env-file` as the stack.
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
| OTP | `RedisOtpService` in this stack's Redis (`OTP_STORE=redis`, Work 61): hashed, never logged, not delivered. The stack's Redis has no auth, TLS or persistence | Users can't receive codes (no SMS); a production Redis still has to be provisioned and operated |
| SMS | `UnconfiguredSmsTransport` | No SMS delivery |
| Payments | `MockPaymentProvider` approves gateway methods in-process; Telebirr adapter deliberately unimplemented | No real payment collection; mock approvals must never reach real customers |
| Proof of delivery | `InMemoryProofArtifactStorage` | Artifacts lost on restart; single instance only |
| Routing / ETA | `HaversineRoutingAdapter` (straight-line) | Approximate distances, fees and ETAs |
| HTTP hardening | No rate limiting, security headers or trusted-proxy setting | Required before any hosted exposure |
| Logging | JSON logs only when `NODE_ENV=production` | Development-mode logs are plain text |

## What this does not verify

- Production-mode (`NODE_ENV=production`) startup: blocked by the Fayda guard above.
- Real integrations: push (FCM), SMS, payments, identity verification, routing. E-mail (Resend) is exercised only if you run the manual e-mail OTP smoke test with your own credentials. The OTP smoke test proves storage and verification, not delivery.
- Production Redis: authentication, TLS, persistence, replication, backup and recovery. This stack's Redis has none of them.
- Hosting: HTTPS, reverse proxy, private access, multiple instances, resource limits.
- Backups, restore, monitoring and alerting.
- Front ends: `web/` and `app/` are not part of this stack.
- Any existing-data upgrade.

## Defects found by the rehearsal (fixed in #8)

The first rehearsal runs exposed two application defects. Both were fixed in a separate PR (#8) and merged into this branch from `main`:

1. `GET /health/live` and `GET /health/ready` were not public, so the global `JwtAuthGuard` answered every probe with `401`. They are now `@Public()`.
2. `PORT` from the environment always failed validation (untyped property). It is now typed, and `compose.staging.yml` sets `PORT: "3000"`.

## Rehearsal results with e-mail OTP delivery (Work 62: 2026-10-29, local Docker 29.7.2, Compose v5.3.1)

`node ops/staging/rehearse-clean-install.mjs` exited 0 with `REHEARSAL PASSED`, on the Work 61 env file with **no Resend credentials** (none were available). This run therefore exercises the "provider not configured" path. No real e-mail was sent, and the manual e-mail OTP smoke test was not run.

| Step | Result |
|---|---|
| 1. Env file and Compose configuration | passed; `e-mail provider (Resend): not configured` |
| 2–7. Clean stack, empty database, images, migrations, seed twice | passed: 0 tables before install; 33/33 migrations; 14 roles, 65 permissions, 130 grants, identical both times |
| 8. Backend health, no token | passed: `/health/live` 200; `/health/ready` 200 (`database: up`); container `healthy` |
| 9. Redis and OTP behaviour | passed: `PONG`; `OTP_STORE=redis`, secret and `REDIS_URL` set; Redis OTP store in the log. `POST /auth/resend-otp` for an e-mail address and for a phone number both returned 503 `DEPENDENCY_UNAVAILABLE`; OTP keys in Redis 0 → 0 (nothing issued) |
| 10. OTP smoke test | passed: 7/7 |
| 11. Second `migrate deploy` | passed: `No pending migrations to apply.` |
| Cleanup | passed: 0 containers, volumes, networks and images of the project left; the 3 unrelated containers still running |

No env-file secret appeared in the output.

**A first attempt failed in step 9**, with `fetch failed (UND_ERR_SOCKET)` on the first POST. That was the rehearsal script, not the backend: `curl` and a fresh `fetch` against the kept stack both got the correct 503. The health-check `fetch` left a pooled keep-alive connection, which the server closed after its 5-second idle timeout while the Docker checks ran, and the POST reused it. The script now sends its POSTs on a fresh connection (`node:http` with no agent).

## Rehearsal results with Redis OTP storage (Work 61: 2026-10-28, local Docker 29.7.2, Compose v5.3.1)

A fresh `backend/.env.staging` was generated with `--init-env`. `node ops/staging/rehearse-clean-install.mjs` exited 0 with `REHEARSAL PASSED`.

| Step | Result |
|---|---|
| 1. Prerequisites, env file (including `OTP_HASH_SECRET`), `docker compose config --quiet` | passed; values not shown |
| 2. Ownership check and scoped cleanup of the rehearsal project | passed: nothing pre-existing; 3 unrelated running containers recorded |
| 3. PostgreSQL 16 and Redis 7 healthy; database empty | passed (0 public tables before install) |
| 4. Image build (`runtime` and `tools`) | passed |
| 5. `prisma migrate deploy` | passed: 33/33 applied |
| 6. Seed | passed: 14 roles, 65 permissions, 130 grants |
| 7. Seed again | passed: identical counts |
| 8. Backend health (`OTP_STORE=redis`), no token | passed: `/health/live` 200; `/health/ready` 200 with `database: up`; container health check `healthy` |
| 9. Redis and the effective OTP store | passed: `PONG`; backend container `OTP_STORE=redis`, secret set, `REDIS_URL` set; log shows `Redis connected.` and the Redis OTP store, no in-memory store; `POST /auth/resend-otp` 201 and OTP keys 0 → 2; immediate second request 429 `RATE_LIMITED` |
| 10. OTP smoke test | passed: 7/7 checks (`OTP SMOKE PASSED (7/7 checks)`) |
| 11. Second `prisma migrate deploy` | passed: `No pending migrations to apply.` |
| Cleanup | passed: 0 containers, 0 volumes, 0 networks and 0 images of the project left; the 3 unrelated containers still running |

No env-file secret, OTP code or synthetic address appeared in the rehearsal's output (checked against the env file's values after the run). Before generating the new file, the rehearsal refused the pre-Work 61 env file with `OTP_HASH_SECRET is missing or still a placeholder`, and `docker compose config` refused an env file without the secret.

## Earlier rehearsal results (2026-10-26, local Docker 29.7.2, Compose v5.3.1, after merging #8; in-memory OTP store)

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
