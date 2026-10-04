# PharmaLink Ethiopia — Quickstart

Get the backend running, verified, and answering authenticated API calls in about 10 minutes.

> **What actually runs today:** the NestJS backend (Phase 0 shared kit + Module 01 Identity & Authentication) and the `app/` customer prototype. See [Repository status](#repository-status) for the honest state of every folder.

---

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | **18+** (verified on 22.13.1) | ships with npm 10 |
| PostgreSQL | **14+** | vanilla Postgres is fine; no PostGIS needed for the current schema |
| Prisma CLI | 6.x | installed as a local dev dependency, no global install |

Redis is **not** required yet. `REDIS_URL` is accepted but unused — OTP storage and the permission cache are currently in-process (`InMemoryOtpService`, `PermissionCacheService`), both designed to be swapped for Redis adapters later.

---

## 1. Backend in five steps

```bash
cd backend
npm install
```

### Create `backend/.env`

`.env` is gitignored, so you must create it. Every variable below is **required** — the app validates its environment at boot ([env.validation.ts](backend/src/shared/config/env.validation.ts)) and refuses to start if anything is missing or too short.

```dotenv
NODE_ENV=development
PORT=3000

DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/pharmalink?schema=public"

# Minimum 16 characters each
JWT_ACCESS_SECRET="change-me-dev-access-secret-0123456789"
JWT_REFRESH_SECRET="change-me-dev-refresh-secret-0123456789"

# Base64 of exactly 32 random bytes (44 chars) — see command below
MASTER_ENCRYPTION_KEY="<generate>"
```

Generate a valid master key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

`MASTER_ENCRYPTION_KEY` must decode to exactly 32 bytes or `CryptoService` throws at startup. It wraps per-record data keys for envelope encryption (ADR-009); in production a KMS replaces the local wrap/unwrap behind the same interface.

Optional tuning variables (defaults shown), read by [app-config.service.ts](backend/src/shared/config/app-config.service.ts):

```dotenv
JWT_ACCESS_TTL_SECONDS=900      # 15 min
JWT_REFRESH_TTL_DAYS=30
OTP_TTL_SECONDS=300             # 5 min
OTP_MAX_ATTEMPTS=5
```

### Generate the Prisma client, migrate, seed

```bash
npm run prisma:generate                  # REQUIRED before build or test — see Troubleshooting
npm run prisma:migrate -- --name init    # creates prisma/migrations/ from the schema folder
npm run prisma:seed                      # 14 roles + 37 permissions, idempotent
```

The seed prints `Seeded 14 roles and 37 permissions.` and is safe to re-run. It creates **roles and permissions only — no user accounts**. See [Bootstrapping your first admin](#4-bootstrapping-your-first-admin).

### Verify

```bash
npm test          # expect: 43 suites, 194 tests, all passing
npm run build     # nest build -> dist/
npm run start:dev # watch mode on http://localhost:3000
```

```bash
curl http://localhost:3000/health/live     # liveness — no DB touch
curl http://localhost:3000/health/ready    # readiness — pings Postgres via Prisma
```

There is **no global route prefix** — endpoints live at the root (`/auth/login`, not `/api/v1/auth/login`).

---

## 2. Your first authenticated request

A complete register → verify → login → call flow. Every response is wrapped in the [standard envelope](#response-envelope).

### Register

```bash
curl -X POST http://localhost:3000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"phone":"+251911234567","password":"Str0ng!Passw0rd","preferredLanguage":"en"}'
```

Supply `phone` or `email` — each is individually optional, but you need one. Password minimum is 8 characters. Self-registration always creates a **CUSTOMER**; provider and staff accounts are invited/provisioned, not self-served.

### Grab the OTP from the server log

No SMS or email provider is wired up. `InMemoryOtpService` **logs the code instead of delivering it**:

```
[InMemoryOtpService] OTP issued for REGISTER (dev-mode, not actually delivered): 483920
```

The OTP lives in process memory — **restarting the server discards it**. Use `/auth/resend-otp` to get a new one (30-second cooldown between issues).

### Verify the OTP

```bash
curl -X POST http://localhost:3000/auth/verify-otp \
  -H 'Content-Type: application/json' \
  -d '{
    "identifier":"+251911234567",
    "code":"483920",
    "purpose":"REGISTER",
    "deviceInfo":{"fingerprint":"dev-machine-01","platform":"WEB","name":"curl"}
  }'
```

Passing `deviceInfo` auto-logs you in and returns tokens immediately. `purpose` is one of `REGISTER`, `LOGIN`, `RESET`, `STEP_UP`; `platform` is `ANDROID`, `IOS`, or `WEB`; `fingerprint` needs at least 4 characters.

### Log in

```bash
curl -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{
    "identifier":"+251911234567",
    "password":"Str0ng!Passw0rd",
    "deviceInfo":{"fingerprint":"dev-machine-01","platform":"WEB","name":"curl"}
  }'
```

Returns, inside `data`:

```json
{
  "accessToken": "eyJ...",
  "accessTokenExpiresAt": 1757160000,
  "refreshToken": "...",
  "refreshTokenExpiresAt": "2026-10-06T00:00:00.000Z"
}
```

### Call a protected route

```bash
curl http://localhost:3000/users/me -H "Authorization: Bearer <accessToken>"
```

**Access tokens carry a permission snapshot plus a `permVersion`.** Any role or permission change bumps that version, and `JwtAuthGuard` immediately rejects the now-stale token — so a revoked role takes effect at once rather than lingering until expiry. When that happens, call `/auth/token/refresh` to get a token with re-resolved permissions.

---

## 3. API reference

All routes are authenticated by default. `JwtAuthGuard` and `PermissionsGuard` are registered globally (in that order) by [identity.module.ts](backend/src/modules/identity/identity.module.ts); only routes marked `@Public()` skip authentication.

### Health — `/health` (public)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health/live` | liveness probe |
| GET | `/health/ready` | readiness, includes a Prisma DB check |

### Auth — `/auth`

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| POST | `/auth/register` | public | 201; CUSTOMER only |
| POST | `/auth/verify-otp` | public | optional `deviceInfo` auto-logs in |
| POST | `/auth/resend-otp` | public | 30s cooldown |
| POST | `/auth/login` | public | requires `deviceInfo` |
| POST | `/auth/token/refresh` | public | rotation with reuse detection |
| POST | `/auth/password/forgot` | public | |
| POST | `/auth/password/reset` | public | |
| POST | `/auth/password/change` | bearer | |
| POST | `/auth/logout` | bearer | 204; body carries `refreshToken` |
| POST | `/auth/logout-all` | bearer | 204 |
| GET | `/auth/sessions` | bearer | |
| DELETE | `/auth/sessions/:id` | bearer | 204 |
| GET | `/auth/devices` | bearer | |
| DELETE | `/auth/devices/:id` | bearer | 204 |
| GET | `/auth/login-history` | bearer | |

### Users — `/users`

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/users/me` | current principal |
| PATCH | `/users/me` | update profile |
| POST | `/users/me/deactivate` | self-service |
| POST | `/users/me/delete-request` | erasure request |

### Verification — `/verification`

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/verification/fayda` | 202; national-ID check via `MockFaydaProvider` |
| POST | `/verification/documents` | 202; `type` is `FAYDA`, `PHARMACY_LICENSE`, `DRIVER_DOCS`, or `DOCTOR_LICENSE`; carries `storageRef`s, never file bytes |
| GET | `/verification/status` | own status |

### Admin — permission-gated

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/admin/rbac/roles` | `rbac:read` |
| GET | `/admin/rbac/permissions` | `rbac:read` |
| POST | `/admin/rbac/roles/:id/permissions` | `rbac:manage` (replace semantics) |
| GET | `/admin/users/:id/roles` | `rbac:read` |
| POST | `/admin/users/:id/roles` | `rbac:manage` |
| DELETE | `/admin/users/:id/roles/:assignmentId` | `rbac:manage` |
| POST | `/admin/users/:id/suspend` | `user:suspend:any` |
| POST | `/admin/users/:id/reactivate` | `user:reactivate:any` |
| GET | `/admin/verification/queue` | `verification:queue:read` |
| POST | `/admin/verification/:id/approve` | `provider:verify:any` |
| POST | `/admin/verification/:id/reject` | `provider:verify:any` |

`SUPER_ADMIN` holds a single wildcard permission row (`*`) that the permission matcher honours, rather than an enumeration of every key. `rbac:read` is carved out from `rbac:manage` so Admin gets read-only RBAC while Super Admin can mutate it.

---

## 4. Bootstrapping your first admin

The seed creates no users, and assigning a role over the API needs `rbac:manage` — a chicken-and-egg you break once, directly in the database.

1. Register normally through `/auth/register` and complete OTP verification.
2. Promote that user:

```bash
npm run prisma:studio     # open user_roles / roles, or use psql
```

```sql
INSERT INTO user_roles (id, "userId", "roleId", "grantedAt")
SELECT gen_random_uuid(), u.id, r.id, now()
FROM users u, roles r
WHERE u.phone = '+251911234567' AND r.key = 'SUPER_ADMIN';
```

3. Call `/auth/token/refresh`. The permission-version check invalidates your old access token, and the new one carries super-admin rights.

Confirm exact table and column names against [01-identity.prisma](backend/prisma/schema/01-identity.prisma) before running the SQL — the schema is the source of truth. Prisma Studio is the lower-risk route.

---

## Response envelope

**Every** response — success and error alike — uses the same shape ([envelope.ts](backend/src/shared/errors/envelope.ts)):

```json
{ "success": true,  "data": {}, "error": null, "meta": { "requestId": "...", "timestamp": "..." } }
```

```json
{ "success": false, "data": null, "error": { "code": "AUTH_INVALID_CREDENTIALS", "message": "..." }, "meta": {} }
```

**Switch on `error.code`, never on HTTP status or message text.** Codes are append-only and never repurposed: `VALIDATION_ERROR`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `UNAUTHENTICATED`, `FORBIDDEN`, `TOKEN_EXPIRED`, `BUSINESS_RULE_VIOLATION`, plus the auth family (`AUTH_DUPLICATE_IDENTIFIER`, `AUTH_INVALID_CREDENTIALS`, `AUTH_ACCOUNT_SUSPENDED`, `AUTH_OTP_EXPIRED`, `AUTH_REFRESH_REUSE_DETECTED`, and more). Full list: [error-codes.ts](backend/src/shared/errors/error-codes.ts).

Validation is strict — the global `ValidationPipe` runs with `whitelist` **and** `forbidNonWhitelisted`, so an unrecognised body property is a `400`, not a silently ignored field.

---

## 5. Frontends

### `app/` — customer prototype (runnable)

```bash
cd app && npm install && npm run dev     # http://localhost:5173
```

React 18 + Vite + Tailwind + framer-motion. Pages: Home, Medicines, Doctors, Diagnostics, Checkout, Tracking, DesignSystem. Runs entirely on [mock.js](app/src/data/mock.js) — **no backend calls**.

### `web/` — operations console (incomplete, will not start)

```bash
cd web && npm install && npm run dev     # blank page — see below
```

[index.html](web/index.html) loads `/src/main.tsx`, **which does not exist**. The folder currently contains only the supporting layers — services, hooks, contexts, theme, types, navigation config — with no entry point, `App.tsx`, or page components. `npm run dev` serves a blank page and `npm run build` (`tsc -b && vite build`) fails. Treat it as a scaffold awaiting its UI shell.

Both prototypes are **mock-only**: [apiClient.ts](web/src/services/apiClient.ts) is a `setTimeout`-based latency simulator over `services/mock/seed.ts`, there is no `VITE_API_URL` anywhere, and [auth.service.ts](web/src/services/auth.service.ts) ships hard-coded `DEMO_USERS`. Wiring either app to the live backend is unstarted work.

Both are configured for port **5173** — run them one at a time, or Vite will shift the second to 5174.

---

## Repository status

| Folder | Contents | Status |
| --- | --- | --- |
| [backend/](backend/) | NestJS modular monolith + Prisma schema | **Phase 0 + Module 01 built; 194 tests green** |
| [architecture/](architecture/) | 16 module designs + 5 consolidation docs | Complete |
| [bussiness analysis/](bussiness%20analysis/) | Requirements, stakeholders, user stories, roadmap | Reference |
| [qa/](qa/) | Test plan, test cases, initial assessment | Reference |
| [app/](app/) | Customer web prototype (React/Vite/Tailwind) | Runnable, mock data |
| [web/](web/) | Pharmacy/Admin console (React/Vite/MUI) | Scaffold only — no entry point |

> The root [README.md](README.md) states the backend application code "has not been written yet." That is out of date: Phase 0 and Module 01 are implemented, tested, and wired.

**Backend layout** — Clean Architecture, one folder per bounded context:

```
backend/src/
  main.ts, app.module.ts
  shared/            # config, logging, prisma, crypto, events, outbox, audit, rbac, errors, health
  modules/identity/
    domain/          # entities, value objects, repository interfaces, enums, errors, events
    application/     # commands, queries, ports, services  (one class per use case)
    infrastructure/  # prisma repositories, jwt/scrypt, otp, rbac cache, mock Fayda, jobs
    interface/       # controllers, dtos, guards, decorators, event handlers
```

Only `IdentityModule` is registered in [app.module.ts](backend/src/app.module.ts) today. The other 15 modules are designed and schema'd but not implemented — add each to `AppModule` as it lands, per the roadmap.

The Prisma schema is complete for **all 16 modules** ([backend/prisma/schema/](backend/prisma/schema/), one file per module) and validates cleanly on Prisma 6, even though only Module 01 has application code.

Two background workers start automatically outside tests: `OutboxRelay` polls the outbox every 2s and dispatches to the in-process event bus, and `LicenseExpiryJob` sweeps expired verifications hourly. Both are disabled when `NODE_ENV=test` so suites can drive them deterministically.

---

## Troubleshooting

**`npm test` fails with `Namespace 'Prisma' has no exported member 'InputJsonValue'`** (17 suites failing to compile)
You skipped `prisma generate`. The installed `@prisma/client` is a stub until the schema is generated against it. Run `npm run prisma:generate` and re-run — all 43 suites pass. `npm run build` handles this automatically via the `prebuild` hook; `npm test` does not.

**`Error: Invalid environment configuration: ...`**
A required variable is missing or too short. `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` need 16+ characters; `MASTER_ENCRYPTION_KEY` needs 44+ (base64 of 32 bytes).

**`MASTER_ENCRYPTION_KEY must decode to 32 bytes (got N)`**
The value is base64 of the wrong length. Regenerate with the `randomBytes(32)` command above.

**`prisma generate` / `validate` complains `DATABASE_URL` is not set**
Both commands read the datasource block even though `generate` never connects. Ensure `.env` exists in `backend/`.

**OTP code doesn't work**
Codes are in-process and live 5 minutes; a server restart wipes them. Check the log line for the current code, or call `/auth/resend-otp`. After 5 failed attempts the code is destroyed — request a new one.

**`401` on a request that worked a moment ago**
A role or permission change bumped your `permVersion` and invalidated the access token by design. Call `/auth/token/refresh`.

**`warn The configuration property package.json#prisma is deprecated`**
Harmless on Prisma 6; it becomes a real requirement in Prisma 7 (migrate to `prisma.config.ts` then).

---

## Where to go next

Read in this order:

1. [00-architecture-index.md](architecture/00-architecture-index.md) — the map: 16 modules, 4 phases, dependencies.
2. [00-shared-conventions.md](architecture/00-shared-conventions.md) — rules every module follows.
3. [00-domain-event-catalog.md](architecture/00-domain-event-catalog.md) — inter-module contracts.
4. [00-implementation-roadmap.md](architecture/00-implementation-roadmap.md) — **the build playbook**: what to build, in what order, definition of done, and the full env-var table (§7).
5. [00-decision-log.md](architecture/00-decision-log.md) — why each key decision was made.
6. Your module's `module-NN-*.md`, then its `backend/prisma/schema/NN-*.prisma`.

Patterns you will meet everywhere and should not re-invent: scalar cross-module UUID references with no foreign keys (bounded-context isolation), integer minor units for money, append-only ledgers with derived balances, reservation + TTL for scarce resources, sagas with compensation, outbox eventing (at-least-once — **consumers must be idempotent**), a hash-chained audit log, and envelope-encrypted health data.

**Next implementation step:** Phase 1 modules per the roadmap. Phase 0 (shared kit) and Module 01 (Identity) are done.
