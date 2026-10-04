# Module 02 — Profiles: Vertical Slice 1 Implementation Specification

**Slice:** Customer Profile + Address Management
**Status:** **APPROVED / IMPLEMENTED — Module 02, Customer Profile + Address Management.** Passed QA exit review (2026-08-21): 247/247 backend unit tests passing, 88/88 e2e tests passing across 12 suites (real Postgres via Testcontainers), including a dedicated atomicity/rollback suite (`test/profiles/atomicity.e2e-spec.ts`). **Module 02 is FROZEN as a completed foundation — no further functional modifications are permitted against this slice's scope (§1.1) without a new ADR/spec revision.** Documentation-only or defect-fix changes remain in scope; new features belong in a new slice document.
**Parent design doc:** `architecture/module-02-user-profile.md` (§1–§13) — this document narrows that design into a buildable, end-to-end first slice per `architecture/00-implementation-roadmap.md` §1 ("vertical slices, not horizontal layers").
**Depends on:** Module 01 — Identity & Authentication (implemented at `backend/src/modules/identity`). Reused as-is: `JwtAuthGuard`, `PermissionsGuard`, `@RequirePermissions`, `@CurrentUser`/`AuthenticatedPrincipal`, `ApiException`/`ErrorCode`/response envelope, `AuditService`, `PrismaService`, event bus (`EVENT_BUS`/`IEventBus`), RBAC catalog seed (`prisma/rbac-catalog.ts`).
**Traceability:** BR-USR-01, BR-USR-04, FR-PRF-01/02, FR-ADR-01/02/03, BRULE-21, NFR-PRIV-01/02/06, NFR-AUDIT-01, NFR-LOC-01/03.

---

## 0. Implementation Closure Note (post-build amendment, supersedes §9's original "outbox not required" call)

The sections below (originally written pre-implementation) are preserved as the historical design record. The **as-built** implementation went beyond the original §9 decision once two defects were found and fixed during hardening (tracked as `DEFECT-PROFILES-001` and `DEFECT-PROFILES-002` in code comments across the module):

- **Transactional Outbox pattern (supersedes §9's "outbox is not required for this slice").** Every mutating command (`CreateAddressCommand`, `UpdateAddressCommand`, `DeleteAddressCommand`, `SetDefaultAddressCommand`, `UpdateProfileCommand`) now writes its state change, its audit entry, and its `OutboxService.write(...)` event into the **same** Prisma transaction (`PrismaUnitOfWork`, `src/modules/profiles/infrastructure/persistence/prisma-unit-of-work.ts`), relayed by the shared `OutboxRelayService` (`src/shared/outbox/outbox-relay.service.ts`) per ADR-010. A failure at any point in the closure (state write, audit write, or outbox write) rolls back all three — verified directly by `test/profiles/atomicity.e2e-spec.ts`, which injects a controlled outbox failure after the state mutation and asserts nothing persisted.
- **Comprehensive audit logging.** Every mutating action calls `AuditService.record(...)` **inside** the same transaction (rather than its own independent transaction), preserving the hash-chain's "no fork" guarantee under concurrent writers. Actions covered: `PROFILE_UPDATED`, `ADDRESS_ADDED`, `ADDRESS_UPDATED`, `ADDRESS_REMOVED`, `ADDRESS_DEFAULT_CHANGED` — matching §12's table exactly, with field-name-only (never field-value) context.
- **`Serializable` transaction isolation where required.** `PrismaUnitOfWork.run` executes every Profile/Address mutation at `Prisma.TransactionIsolationLevel.Serializable` (not the default `ReadCommitted`), because co-locating the audit write in the same transaction as the state change means two concurrent mutations for the same user could otherwise both read the same "last audit hash" and fork the chain. Serializable isolation lets Postgres itself abort one side of any genuine conflict.
- **Retry wrapper for both known write-conflict sources.** `runWithDefaultAddressRetry` (`src/modules/profiles/application/support/default-address-conflict.ts`) retries (up to `TRANSACTION_RETRY_MAX_ATTEMPTS = 5`) on: (1) the `addresses_one_default_per_user` partial unique index violation (§6.3, `DEFECT-PROFILES-001`), and (2) Postgres Serializable write-conflicts/deadlocks (`P2034`/`40001`/`40P01`, `DEFECT-PROFILES-002`). Every mutating command goes through this wrapper — direct `uow.run` calls are not used. Exhausting retries returns a deterministic `409 CONFLICT`, never an unhandled `500`.
- Repository methods that participate in a mutation transaction (`findById`, `countByUserId`, `clearDefaultForUser`, `findMostRecentlyUpdatedForUser`) all accept and thread through the transaction client (`tx`) rather than falling back to the ambient `PrismaService`, so reads-within-a-mutation are consistent with the transaction's isolation level.

No other sections of this spec (domain model, validation rules, API contracts, permissions, error codes) changed from the original design — implementation matched the plan. This note exists so a reader does not mistake §9's original "outbox is not required" text (left below, unedited, as the historical record) for the current behavior.

---

## 1. Slice Scope

### 1.1 In scope
- **Customer Profile**: read and edit the extended profile that hangs off a `User` (full name, gender, date of birth, secondary phone, timezone).
- **Address Management**: full CRUD over saved delivery addresses, default-address selection, and Ethiopia geofence validation (BRULE-21).
- Lazy/event-driven creation of the profile row on registration.
- Permissions, audit events, error codes, and DTO validation for the above.

### 1.2 Explicitly out of scope for this slice (tracked for later slices of Module 02)
| Deferred item | Why deferred | Covered by |
| --- | --- | --- |
| Beneficiaries / family healthcare / `Guardianship` | Independent aggregate with its own minor/guardian rules (BRULE-03); no dependency from Profile/Address. | Module 02 — Slice 2 |
| `BeneficiaryAccessPolicy` / health-record timeline | Depends on beneficiaries + Order/Prescription/Appointment read ports that don't exist yet. | Module 02 — Slice 4 (post Phase 1) |
| Notification-category preferences (`NotificationPreference`) | No notification-sending module yet (Module 13, Phase 0 epic 4, not started). | Module 02 — Slice 3 |
| Consent management (`Consent`) | No consent UI/flows specified yet beyond the shared table already owned by Module 01. | Module 02 — Slice 3 |
| Profile photo upload (F-PRF-05) | Requires a new `IStoragePort`/cloud-storage adapter — a separate infra concern from this data-only slice. | Module 02 — Slice 2 |
| Reverse geocoding (`POST /addresses/geocode`, F-ADR-04) | Requires a mapping-provider adapter (`IGeocodingPort`); this slice validates coordinates the client already has (device GPS or manual pin) without an external call. | Module 02 — Slice 2 |
| Account deactivation / data-deletion | **Already implemented in Module 01** (`POST /users/me/deactivate`, `POST /users/me/delete-request`) — not duplicated here. This slice only adds a hook so profile/address rows are purged when Identity's purge job runs (see §9). | — |

### 1.3 Definition of done for this slice
A logged-in customer can: view their profile, edit their name/gender/DOB/secondary phone/timezone, add/edit/delete a delivery address, and have exactly one default address enforced by the database — all through permission-guarded, audited, envelope-consistent endpoints, backed by tests per `00-implementation-roadmap.md` §5.

---

## 2. Integration with Module 01 (Identity)

- **No cross-module table reads or Prisma relations** (ADR-002). `CustomerProfile.userId` / `Address.userId` are plain `String` columns, already modeled that way in `prisma/schema/02-profiles.prisma` — no change needed there.
- **AuthN/AuthZ are fully reused, not reimplemented.** `IdentityModule` already registers `JwtAuthGuard` and `PermissionsGuard` as `APP_GUARD`s (see `identity.module.ts`), so every controller in the new `ProfilesModule` is protected automatically; it only needs `@RequirePermissions(...)` where scoping is required.
- **No new dependency on Identity's internals is required for this slice.** Rejected a design where `GET /profile/me` calls into Identity to mirror `preferredLanguage`:
  - **Decision:** `CustomerProfile.preferredLanguage` (column already in the Prisma model) is **not exposed or writable** by this slice's API. The authoritative, user-facing language preference remains `User.preferredLanguage`, owned and mutated exclusively via Identity's existing `PATCH /users/me`. The column stays in the schema for a future read-model denormalization (Slice 3, once Module 02 needs it for templating) but this slice's DTOs must not reference it.
  - **Rationale:** avoids dual-write divergence and a needless cross-module call on every profile read; keeps this slice's dependency surface at zero new ports. Flagged as an **open question for the Architect** in §14 in case the intended UX wants a single combined endpoint.
- **Profile row creation.** `CustomerProfile` has no data at registration time (Identity's `RegisterDto` only collects `phone`/`email`/`password`; see `UserRegisteredPayload { userId, role, locale }`). This slice creates the row reactively:
  - A new `ProfileModule` event handler subscribes to `identity.user.registered` (`IdentityEventType.UserRegistered`, exported from `modules/identity/domain/events.ts`) on the shared `EVENT_BUS` (same pattern as `UserRegisteredHandler` in Identity) and calls `EnsureCustomerProfileCommand.execute({ userId })`, which **upserts** an empty `CustomerProfile` row (`fullName: null`).
  - `GET /profile/me` also lazily upserts (idempotent `findOrCreate`) as a safety net for out-of-order event delivery — the read path must never 404 for a valid authenticated user.
  - This requires `fullName` to become nullable — see §6 required migration.

---

## 3. Domain Model

### 3.1 CustomerProfile (aggregate root, 1:1 with a `User`)
Existing Prisma model (`prisma/schema/02-profiles.prisma`) is reused as-is except for the `fullName` nullability change in §6.

| Field | Type | Nullable | Notes |
| --- | --- | --- | --- |
| `id` | UUID | no | PK, server-generated |
| `userId` | String | no | Unique; not a Prisma relation (ADR-002) |
| `fullName` | String | **yes** (change from current NOT NULL — see §6) | `null` until first completed |
| `gender` | `Gender` enum | yes | `MALE\|FEMALE\|OTHER\|UNKNOWN`, default omitted (no default = `null` until set) |
| `dateOfBirth` | Date | yes | Stored as `DateTime` (date-only semantics) |
| `photoUrl` | String | yes | **Not used by this slice** (Slice 2). DTOs never read/write it. |
| `preferredLanguage` | enum | n/a | **Not exposed by this slice's API** (§2) |
| `secondaryPhone` | String | yes | E.164 Ethiopian format |
| `timezone` | String | yes | IANA tz string; default `Africa/Addis_Ababa` applied at the application layer if omitted |
| `createdAt`/`updatedAt`/`deletedAt` | DateTime | — | standard |

**Invariant:** exactly one `CustomerProfile` row per `userId` (already enforced by the `@unique` on `userId`).

### 3.2 Address (entity, owned by a user)
Existing Prisma model reused as-is; `beneficiaryId` exists in the schema but **is not settable by this slice** (beneficiaries don't exist yet) — DTOs omit it, so `class-validator`'s `forbidNonWhitelisted` (already the global pipe config in `app.module.ts`) rejects any client attempt to set it with `422 VALIDATION_ERROR`.

| Field | Type | Nullable | Notes |
| --- | --- | --- | --- |
| `id` | UUID | no | PK |
| `userId` | String | no | Owner |
| `beneficiaryId` | String | yes | **Always `null` in this slice** |
| `label` | `AddressLabel` enum | no | `HOME\|WORK\|OTHER`, default `HOME` |
| `recipientName` | String | no | 2–120 chars |
| `recipientPhone` | String | no | E.164 Ethiopian format (reuse validation rule from Identity's `PhoneNumber`, see §6.3) |
| `region`/`city`/`subcity`/`woreda` | String | yes | Structured Ethiopian address; see §4.2 for the "at least one locator" rule |
| `landmark` | String | yes | Free text, ≤ 200 chars |
| `addressLine` | String | yes | Free text, ≤ 300 chars |
| `lat`/`lng` | Float | no | Required in this slice (client supplies GPS pin; no reverse geocoding yet) |
| `isDefault` | Boolean | no | Exactly one `true` per user — enforced by DB partial unique index, see §6 |
| `isWithinEthiopia` | Boolean | no | **Server-computed only**, never client-settable |
| `createdAt`/`updatedAt`/`deletedAt` | DateTime | — | standard |

**Invariants**
1. A user may have at most **20** non-deleted addresses (abuse/DoS guard; configurable later via `IConfigPort`, hardcoded constant `MAX_ADDRESSES_PER_USER = 20` for this slice).
2. At most one non-deleted address per user has `isDefault = true`.
3. The first address a user creates is auto-marked default.
4. Deleting the default address promotes the most-recently-updated remaining address to default; if none remain, no address is default.
5. An address whose coordinates fail the Ethiopia geofence is **rejected outright** (not saved with `isWithinEthiopia = false`) — the module design doc's flag-and-store approach is superseded here for simplicity/BRULE-21 strictness; see §14 open question if the Architect prefers store-and-flag instead.
6. Soft-delete only (`deletedAt`); no address referencing modules exist yet in this slice, so no "cannot delete: in use" guard is needed yet — flagged for Slice 2+ once Orders (Module 06) exists.

---

## 4. Validation Rules (DTO-level, `class-validator`, mirrors `ValidationPipe` config in `app.module.ts`: `whitelist: true, forbidNonWhitelisted: true, transform: true`)

### 4.1 Profile — `UpdateProfileDto` (`PATCH /profile/me`)
```ts
class UpdateProfileDto {
  @IsOptional() @IsString() @Length(2, 120) fullName?: string;
  @IsOptional() @IsIn(['MALE', 'FEMALE', 'OTHER', 'UNKNOWN']) gender?: string;
  @IsOptional() @IsISO8601() dateOfBirth?: string;       // validated further in the command (see below)
  @IsOptional() @IsString() @Matches(ET_PHONE_REGEX) secondaryPhone?: string;
  @IsOptional() @IsString() @Length(1, 64) @IsIn(IANA_TZ_ALLOWLIST) timezone?: string;
}
```
- All fields optional (PATCH semantics) but **at least one field must be present** — an empty body is `422 VALIDATION_ERROR` (`{ code: 'VALIDATION_ERROR', message: 'At least one field is required.' }`), checked in the command, not the DTO.
- `dateOfBirth` business validation (in `UpdateProfileCommand`, not the DTO, because it depends on "now"):
  - Must parse to a valid calendar date.
  - Must be **in the past** (not today or future) → `422 VALIDATION_ERROR` field `dateOfBirth`.
  - Implied age must be **≤ 120 years** → `422 VALIDATION_ERROR`.
  - No minimum-age rule in this slice (minors are Slice 2's beneficiary/guardianship concern — a `CustomerProfile` always belongs to an already-registered `User`, and Identity's own registration flow is the gate for account creation, not this endpoint).
- `IANA_TZ_ALLOWLIST`: for this slice, restrict to `['Africa/Addis_Ababa']` only (single supported timezone) rather than validating arbitrary IANA strings — avoids pulling in a tz database dependency for zero current business value. Documented as a simplification; revisit if diaspora-timezone display becomes a real requirement.

### 4.2 Address — `CreateAddressDto` / `UpdateAddressDto`
```ts
class CreateAddressDto {
  @IsOptional() @IsIn(['HOME', 'WORK', 'OTHER']) label?: string = 'HOME';
  @IsString() @Length(2, 120) recipientName!: string;
  @IsString() @Matches(ET_PHONE_REGEX) recipientPhone!: string;
  @IsOptional() @IsString() @Length(1, 100) region?: string;
  @IsOptional() @IsString() @Length(1, 100) city?: string;
  @IsOptional() @IsString() @Length(1, 100) subcity?: string;
  @IsOptional() @IsString() @Length(1, 100) woreda?: string;
  @IsOptional() @IsString() @Length(1, 200) landmark?: string;
  @IsOptional() @IsString() @Length(1, 300) addressLine?: string;
  @IsNumber() @Min(-90) @Max(90) lat!: number;
  @IsNumber() @Min(-180) @Max(180) lng!: number;
  @IsOptional() @IsBoolean() isDefault?: boolean;
}
class UpdateAddressDto extends PartialType(CreateAddressDto) {}  // Nest's PartialType, all optional
```
- **"At least one locator" rule** (application-layer, not DTO): at least one of `{region+city}` or `addressLine` must be present so the address is deliverable — `422 VALIDATION_ERROR` field `addressLine` if violated. (`landmark` alone is not sufficient.)
- `ET_PHONE_REGEX`: reuse the exact normalization contract of Identity's `PhoneNumber.normalize` (accepts `09XXXXXXXX`, `9XXXXXXXX`, `+2519XXXXXXXX`, `2519XXXXXXXX` and `7`-prefixed equivalents). **Recommendation:** hoist `PhoneNumber` (or just its `normalize`/`create` static) from `modules/identity/domain/value-objects/phone-number.ts` into `shared/domain/phone-number.ts` so both modules use one implementation instead of duplicating the regex. This is a small, additive, non-breaking refactor — flagged for Architect approval in §14; if rejected, Module 02 gets its own copy in `modules/profiles/domain/value-objects/phone-number.ts`.
- `lat`/`lng` are always required on create (no partial/geocode-later flow in this slice).

---

## 5. Business Rules — Ethiopia Geofence (BRULE-21)

- **`GeoPoint.withinEthiopia(lat, lng)`** domain value object/function, pure (no I/O), using a bounding-box check against Ethiopia's approximate extent:
  - `lat` between **3.397** and **14.894**
  - `lng` between **32.998** and **47.978**
- This is a coarse bounding box (not a precise polygon) — acceptable for MVP per module-02 doc §13 ("Geocoding behind `IGeocodingPort`" is future work); false positives near the border are a known, accepted limitation for this slice (documented in §14).
- On violation: `422 ADDRESS_OUTSIDE_ETHIOPIA`, address **not persisted**.
- The bounds are declared as named constants in `modules/profiles/domain/services/geo-bounds.ts` (not hardcoded inline), so a later `IConfigPort`-backed override is a one-line change.

---

## 6. Database Requirements

### 6.1 Already correct, no change needed
`prisma/schema/02-profiles.prisma` already defines `CustomerProfile` and `Address` with the right shape, no cross-module relations (ADR-002 compliant), `@@index([userId])` on `Address`, `@@map` table names matching the architecture doc. The baseline migration (`20260101000000_init`) already created both tables.

### 6.2 Required schema change — `CustomerProfile.fullName` becomes nullable
```prisma
model CustomerProfile {
  ...
  fullName          String?   // was: String (NOT NULL)
  ...
}
```
**Reason:** see §2 — the profile row is created at registration time before a name is known. This is a genuine, necessary amendment to the frozen Phase-0 schema (per `00-implementation-roadmap.md` §1, "schema changes after a module is 'done' go through a migration + ADR"). Module 02 has not been built yet, so this is a pre-build correction, not a post-hoc migration — **still requires Architect sign-off** before the migration is written, since the roadmap explicitly calls this out as a gated action.

### 6.3 Required migration — enforce "at most one default address" in the database
Prisma cannot express a **partial/filtered unique index** declaratively in this schema-folder setup (per `00-implementation-roadmap.md` §4.2, such constraints are added as raw-SQL follow-up migrations). Add, after the Prisma-generated migration for §6.2:
```sql
CREATE UNIQUE INDEX addresses_one_default_per_user
  ON addresses (user_id)
  WHERE is_default = true AND deleted_at IS NULL;
```
This makes the "exactly one default" invariant crash-safe under concurrency (two parallel `set-default` requests can't both win) instead of relying solely on application-layer sequencing. The application layer must catch the resulting unique-violation and retry the "clear old default, set new default" transaction, or perform both writes in one `UPDATE ... WHERE` statement ordered to avoid the race (see §8.2 sequence).

### 6.4 No other schema changes
`Beneficiary`, `Guardianship`, `NotificationPreference` remain untouched (out of scope, §1.2) — do not migrate or seed them in this slice.

---

## 7. Permissions (RBAC)

### 7.1 Reused, no change
- `profile:read:own`, `profile:update:own` — already seeded in `prisma/rbac-catalog.ts`, already granted to `CUSTOMER` (and most other roles). Reused as-is for `GET /profile/me` and `PATCH /profile/me`.

### 7.2 New permissions to add to `prisma/rbac-catalog.ts`
```ts
{ key: 'address:read:own',   resource: 'address', action: 'read',   scope: 'own' },
{ key: 'address:manage:own', resource: 'address', action: 'manage', scope: 'own' }, // create/update/delete/set-default
```
Grant to `CUSTOMER` only in this slice:
```ts
CUSTOMER: [
  ...existing,
  'address:read:own',
  'address:manage:own',
],
```
**Open question for Architect (§14):** should staff/driver/doctor roles also receive `address:manage:own` for their own contact address, or is the address book strictly a customer-checkout concept for now? Default recommendation: customer-only for this slice; extend per-role when a concrete need appears (e.g., driver pickup address in Module 08).

### 7.3 Guarding
- `GET /profile/me` → `@RequirePermissions('profile:read:own')`
- `PATCH /profile/me` → `@RequirePermissions('profile:update:own')`
- `GET /addresses`, `GET /addresses/:id` → `@RequirePermissions('address:read:own')`
- `POST /addresses`, `PATCH /addresses/:id`, `DELETE /addresses/:id`, `POST /addresses/:id/default` → `@RequirePermissions('address:manage:own')`
- **Scope enforcement** (the `own` part) happens in the application layer exactly as documented in `00-shared-conventions.md` §2: every query/command that loads an `Address`/`CustomerProfile` by id must additionally check `resource.userId === principal.userId`; on mismatch return `404 NOT_FOUND` (not `403`) to avoid confirming the resource's existence to a non-owner — consistent with the "no existence leak" rule in `00-shared-conventions.md` §1.

---

## 8. API Contracts

Base paths: `/api/v1/profile`, `/api/v1/addresses` (per `00-shared-conventions.md` §1: `/api/v1/<module>`). All routes require a bearer token (enforced globally by Identity's `JwtAuthGuard`). Standard success/error envelope from `shared/errors/envelope.ts` wraps every response — examples below show only the `data` payload unless noted.

### 8.1 Profile

**`GET /profile/me`** — `profile:read:own`
- 200:
```json
{ "id": "...", "userId": "...", "fullName": null, "gender": null, "dateOfBirth": null,
  "secondaryPhone": null, "timezone": "Africa/Addis_Ababa", "createdAt": "...", "updatedAt": "..." }
```
- Never 404 (lazily created, §2).

**`PATCH /profile/me`** — `profile:update:own`
- Body: `UpdateProfileDto` (§4.1), at least one field.
- 200: updated profile (same shape as GET).
- Errors: `422 VALIDATION_ERROR` (empty body, invalid DOB, non-ET phone, unsupported timezone).

### 8.2 Addresses

**`GET /addresses`** — `address:read:own`
- 200: `[{ id, label, recipientName, recipientPhone, region, city, subcity, woreda, landmark, addressLine, lat, lng, isDefault, createdAt, updatedAt }, ...]`, ordered `isDefault desc, updatedAt desc`. (No pagination in this slice — capped at 20 by the invariant in §3.2; add pagination if the cap is later raised.)

**`GET /addresses/:id`** — `address:read:own`
- 200: single address. 404 `NOT_FOUND` if missing or not owned by caller.

**`POST /addresses`** — `address:manage:own`
- Body: `CreateAddressDto` (§4.2).
- Flow: validate DTO → validate "at least one locator" rule → `GeoPoint.withinEthiopia` check (422 `ADDRESS_OUTSIDE_ETHIOPIA` if it fails) → enforce max-20 (422 `ADDRESS_LIMIT_REACHED`) → if this is the user's first address, or `isDefault: true` was requested, atomically clear any prior default and set this one (§6.3 constraint backs this) → persist → audit → emit `profiles.address.added`.
- 201: created address (same shape as GET one). Errors: `422 VALIDATION_ERROR`, `422 ADDRESS_OUTSIDE_ETHIOPIA`, `422 ADDRESS_LIMIT_REACHED`.

**`PATCH /addresses/:id`** — `address:manage:own`
- Body: `UpdateAddressDto` (all fields optional; at least one required, `422 VALIDATION_ERROR` otherwise).
- If `lat`/`lng` change, re-run the geofence check.
- If `isDefault: true` is included, same atomic default-swap as create; `isDefault: false` on the current default is a **no-op rejected** with `422 DEFAULT_ADDRESS_REQUIRED` (a user cannot unset the only default without either deleting it or setting another one as default — mirrors the module-02 doc's `DEFAULT_ADDRESS_REQUIRED` code).
- 200: updated address. 404 `NOT_FOUND` if not owned/missing.

**`DELETE /addresses/:id`** — `address:manage:own`
- Soft-delete (`deletedAt = now()`).
- If deleting the current default and other addresses remain: promote the most-recently-updated remaining address to default in the **same transaction** (never leave the user with zero default while addresses exist).
- 204 No Content. 404 `NOT_FOUND` if not owned/missing.

**`POST /addresses/:id/default`** — `address:manage:own`
- Explicit "set as default" action (kept separate from `PATCH` for a single unambiguous audit action name and to avoid overloading `PATCH` semantics — matches the module-02 architecture doc §8.3).
- Atomically clears the previous default and sets this one, in one DB transaction guarded by the partial unique index (§6.3): `UPDATE addresses SET is_default = false WHERE user_id = $1 AND is_default = true; UPDATE addresses SET is_default = true WHERE id = $2 AND user_id = $1;` inside `prisma.$transaction`.
- 200: updated address. 404 `NOT_FOUND` if not owned/missing.

---

## 9. Domain Events Emitted (published to `EVENT_BUS`, namespaced per `IdentityEventType` convention)

Add `ProfilesEventType` in `modules/profiles/domain/events.ts`:
```ts
export const ProfilesEventType = {
  ProfileUpdated: 'profiles.profile.updated',
  AddressAdded: 'profiles.address.added',
  AddressUpdated: 'profiles.address.updated',
  AddressRemoved: 'profiles.address.removed',
  DefaultAddressChanged: 'profiles.address.default_changed',
} as const;
```
- No current consumers exist for these yet (Orders/Delivery modules aren't built) — emitted now so those modules can subscribe later without a Module 02 change, per the "contracts first" principle in `00-implementation-roadmap.md` §1. **Outbox is not required for this slice**: these events have no external side effects or cross-transaction consumers yet, so publishing on the in-process bus (post-commit, matching the `UserRegisteredHandler` pattern) is sufficient. Revisit if/when a real consumer needs at-least-once delivery guarantees (per ADR-010, add outbox writes at that point — additive, non-breaking).
- Identity's `deletionRequestedAt`/purge job (Module 01, out of scope here) is expected to also purge `CustomerProfile`/`Address` rows for the same `userId`; this slice does not implement the purge job itself, only ensures its own tables are soft-delete-capable (`deletedAt` already present). **Open item for Architect**: confirm which module owns the actual purge-sweep job that touches Module 02 tables (§14).

---

## 10. NestJS Module Layout

Per `00-shared-conventions.md` §13 and `00-implementation-roadmap.md` §2 (`src/modules/profiles/`):

```
backend/src/modules/profiles/
  domain/
    entities/               CustomerProfile, Address (framework-free)
    value-objects/          GeoPoint (withinEthiopia), PersonName (optional), PhoneNumber (or shared, see §4.2)
    events.ts                ProfilesEventType + factory functions (mirrors identity/domain/events.ts)
    enums.ts                 re-export Prisma enums used at the domain layer (Gender, AddressLabel)
    errors.ts                ProfileErrors (mirrors identity/domain/errors.ts pattern)
    repositories/            IProfileRepository, IAddressRepository (interfaces only)
    services/                geo-bounds.ts (ET bounding box constants + withinEthiopia)
  application/
    commands/                EnsureCustomerProfileCommand, UpdateProfileCommand,
                              CreateAddressCommand, UpdateAddressCommand, DeleteAddressCommand,
                              SetDefaultAddressCommand
    queries/                 GetProfileQuery, ListAddressesQuery, GetAddressQuery
    dtos/                    (or colocate with interface/dtos per identity's convention — identity
                              puts request DTOs under interface/dtos; mirror that, keep this folder
                              empty/omit to stay consistent with the existing module)
  infrastructure/
    persistence/
      prisma-profile.repository.ts
      prisma-address.repository.ts
  interface/
    http/
      controllers/           ProfileController, AddressController
      dtos/                  profile.dto.ts, address.dto.ts
    events/
      user-registered.handler.ts   (subscribes to identity.user.registered → EnsureCustomerProfileCommand)
  profiles.module.ts          composition root; registers controllers + providers; NO new APP_GUARD
                               (guards are already global from IdentityModule)
```

Register in `app.module.ts`:
```ts
imports: [SharedModule, HealthModule, IdentityModule, ProfilesModule],
```

---

## 11. Edge Cases

| # | Scenario | Expected behavior |
| --- | --- | --- |
| 1 | `GET /profile/me` before the `UserRegistered` event handler has run (race) | Lazily upserts and returns an empty profile (`fullName: null`) — never 404/500. |
| 2 | `PATCH /profile/me` with an empty JSON body `{}` | `422 VALIDATION_ERROR`, "At least one field is required." |
| 3 | `PATCH /profile/me` with `dateOfBirth` in the future | `422 VALIDATION_ERROR`, field `dateOfBirth`. |
| 4 | `PATCH /profile/me` with `dateOfBirth` implying age > 120 | `422 VALIDATION_ERROR`, field `dateOfBirth`. |
| 5 | `POST /addresses` with `lat`/`lng` just outside the ET bounding box (e.g., a point in Djibouti near the border) | `422 ADDRESS_OUTSIDE_ETHIOPIA`. Known bounding-box false-positive/negative risk near borders — accepted for this slice (§5). |
| 6 | `POST /addresses` as the user's 21st address | `422 ADDRESS_LIMIT_REACHED`. |
| 7 | `POST /addresses` with only `landmark` filled in (no region/city/addressLine) | `422 VALIDATION_ERROR`, field `addressLine` ("at least one locator required"). |
| 8 | Two concurrent `POST /addresses/{id}/default` requests for different addresses of the same user | DB partial unique index (§6.3) plus a serialized transaction guarantees exactly one ends up `isDefault=true`; the loser's transaction retries against the new state, not a 500. |
| 9 | `DELETE` the only address a user has | Succeeds; user ends up with zero addresses, none default — allowed (a user can have zero saved addresses). |
| 10 | `DELETE` the default address while 2+ others exist | The most-recently-updated remaining address is promoted to default, in the same transaction as the delete. |
| 11 | `PATCH /addresses/:id` with `isDefault: false` on the currently-default address | `422 DEFAULT_ADDRESS_REQUIRED` — must set another address as default first, or delete it (edge case 10). |
| 12 | `GET/PATCH/DELETE /addresses/:id` for an address owned by a different user | `404 NOT_FOUND` (never `403`, to avoid confirming existence — §7.3). |
| 13 | `PATCH /profile/me` sends `photoUrl` or `preferredLanguage` (fields that exist in the DB but aren't in the DTO) | `422 VALIDATION_ERROR` via `forbidNonWhitelisted` (global pipe). |
| 14 | `POST /addresses` sends `beneficiaryId` | `422 VALIDATION_ERROR` via `forbidNonWhitelisted` (field intentionally absent from `CreateAddressDto`, §3.2). |
| 15 | `recipientPhone`/`secondaryPhone` submitted in a valid-but-non-Ethiopian format (e.g., a US number) | `422 VALIDATION_ERROR` (regex rejects; this slice only supports ET numbers, matching Identity's own phone rule). |

---

## 12. Security & Privacy Requirements

- **AuthN/AuthZ**: every route behind `JwtAuthGuard` + `PermissionsGuard` + explicit `@RequirePermissions`; ownership re-checked in the application layer on every read/write (§7.3) — permission scope alone (`own`) is necessary but not sufficient, since the guard cannot know *which* address the caller is targeting.
- **No existence leakage**: cross-user access attempts return `404`, matching `00-shared-conventions.md` §1's "privacy denials return generic responses" principle, extended here to ownership checks generally (not just health data).
- **PII minimization**: `dateOfBirth`, `secondaryPhone`, and full delivery addresses are personal data; this slice does not yet classify them as "health-sensitive" (that's beneficiary allergy/condition data in Slice 2), so **no field-level encryption is required** for `CustomerProfile`/`Address` columns — plain columns are acceptable, consistent with `00-shared-conventions.md` §11 (field-level encryption is scoped to "health-sensitive fields", which these are not).
- **Logging discipline**: operational (non-audit) logs must never contain `dateOfBirth`, `secondaryPhone`, `recipientPhone`, `addressLine`, or precise `lat`/`lng` — log only entity ids and action names, per `00-shared-conventions.md` §4 ("never log ... plaintext health text — only non-sensitive identifiers"), applied here to address PII generally.
- **Audit logging** (via the existing `AuditService`, reused as-is — no new infra): every mutating action writes one hash-chained `audit_logs` row.

| Action | `action` value | `resourceType` | `resourceId` | `context` (non-sensitive only) |
| --- | --- | --- | --- | --- |
| Profile updated | `PROFILE_UPDATED` | `CustomerProfile` | profile id | `{ fields: ['fullName','gender', ...] }` (field **names** only, never values) |
| Address added | `ADDRESS_ADDED` | `Address` | address id | `{ label, isDefault }` |
| Address updated | `ADDRESS_UPDATED` | `Address` | address id | `{ fields: [...] }` (names only) |
| Address removed | `ADDRESS_REMOVED` | `Address` | address id | `{ wasDefault }` |
| Default address changed | `ADDRESS_DEFAULT_CHANGED` | `Address` | new default's id | `{ previousAddressId }` |

- **Rate limiting**: not implemented in this slice (no shared rate-limiter infra exists yet outside Identity's OTP/login paths); the max-20-addresses and max-one-field-mutation-per-request invariants are the only abuse controls. Flagged for Architect awareness, not a blocker.

---

## 13. Error Codes

Add to `shared/errors/error-codes.ts` (append-only, per that file's own header comment) with HTTP mappings:

| Code | HTTP | Meaning |
| --- | --- | --- |
| `ADDRESS_OUTSIDE_ETHIOPIA` | 422 | Coordinates fail the ET geofence (BRULE-21). |
| `ADDRESS_LIMIT_REACHED` | 422 | User already has 20 non-deleted addresses. |
| `DEFAULT_ADDRESS_REQUIRED` | 422 | Attempted to unset the only default address without designating a replacement. |

Reused, unchanged: `VALIDATION_ERROR` (422), `NOT_FOUND` (404), `UNAUTHENTICATED` (401), `FORBIDDEN` (403 — reserved for permission-level denials, not ownership ones, per §7.3), `INTERNAL_ERROR` (500).

---

## 14. Open Questions for Architect Approval

1. **`fullName` nullability migration (§6.2)** — confirm this pre-build schema correction is acceptable, or propose an alternative (e.g., collect `fullName` at registration in Identity instead).
2. **Geofence strictness (§3.2 invariant 5)** — reject outright vs. the original module-02 doc's "store with `isWithinEthiopia=false` flag" approach. This spec recommends outright rejection for simplicity; confirm or override.
3. **`address:manage:own` role grant (§7.2)** — customer-only for now, or extend to other roles immediately?
4. **Purge-job ownership (§9)** — which module implements the sweep that hard-deletes/purges `CustomerProfile`/`Address` rows after Identity's `deletionRequestedAt` grace period elapses?
5. **`PhoneNumber` value-object hoist (§4.2)** — move to `shared/` now (small refactor touching Identity) or duplicate in Module 02 and reconcile later?
6. **Combined profile view** — should a future BFF/aggregation endpoint merge Identity's `User` fields (status, verification flags, `preferredLanguage`) with Module 02's `CustomerProfile` for a single "my account" screen, and if so, in which module?

---

## 15. Acceptance Criteria (Given/When/Then)

**AC-1 (BR-USR-01, FR-PRF-01/02).**
*Given* an authenticated customer with no profile edits yet, *when* they call `GET /profile/me`, *then* they receive `200` with `fullName: null` and no error, and calling `PATCH /profile/me` with `{ "fullName": "Abebe Kebede" }` *then* a subsequent `GET` returns the updated `fullName`.

**AC-2 (BR-USR-04, FR-ADR-01/02).**
*Given* a customer with zero addresses, *when* they `POST /addresses` with valid ET coordinates, *then* the response is `201` and the created address has `isDefault: true` automatically.

**AC-3 (BRULE-21, FR-ADR-03).**
*Given* a customer, *when* they `POST /addresses` with `lat/lng` outside Ethiopia, *then* the response is `422 ADDRESS_OUTSIDE_ETHIOPIA` and no row is persisted.

**AC-4 (default-address invariant).**
*Given* a customer with two addresses, A (default) and B, *when* they `POST /addresses/{B}/default`, *then* `GET /addresses` shows A with `isDefault: false` and B with `isDefault: true`, and the database never transiently has two defaults (verified by a concurrency test, §16).

**AC-5 (ownership isolation).**
*Given* two customers U1 and U2, *when* U2 calls `GET /addresses/{U1's address id}`, *then* the response is `404 NOT_FOUND` (not `403`, not `200`).

**AC-6 (audit trail).**
*Given* any successful mutating call in this slice, *when* it completes, *then* exactly one new `audit_logs` row exists with the correct `action`/`resourceType`/`resourceId` and a valid hash chain (`prevHash` matches the prior row's `hash`).

---

## 16. QA Test Scenarios

### 16.1 Functional
- Register a customer (Identity) → assert a `CustomerProfile` row is created (via event handler) within a bounded delay.
- `GET /profile/me` immediately after registration → `200`, `fullName: null`.
- `PATCH /profile/me` with each field individually and in combination → each persists and round-trips via `GET`.
- `POST /addresses` with minimal valid payload (only required fields) → `201`, `isDefault: true` (first address).
- `POST /addresses` a second time with `isDefault: true` explicitly → first address's `isDefault` flips to `false`.
- `PATCH /addresses/:id` changing `lat`/`lng` to a still-valid ET point → `200`, re-validated successfully.
- `DELETE /addresses/:id` on a non-default address → `204`, other address(es) unaffected.
- `DELETE /addresses/:id` on the default address with another remaining → `204`, remaining address becomes default.

### 16.2 Negative / validation
- `PATCH /profile/me` with `{}` → `422 VALIDATION_ERROR`.
- `PATCH /profile/me` with `dateOfBirth` = tomorrow → `422 VALIDATION_ERROR`.
- `PATCH /profile/me` with `dateOfBirth` implying 130 years old → `422 VALIDATION_ERROR`.
- `PATCH /profile/me` with `gender: "MAN"` (invalid enum) → `422 VALIDATION_ERROR`.
- `POST /addresses` missing `recipientPhone` → `422 VALIDATION_ERROR`.
- `POST /addresses` with `recipientPhone: "+15551234567"` (non-ET) → `422 VALIDATION_ERROR`.
- `POST /addresses` with `lat: 95` (out of `[-90,90]`) → `422 VALIDATION_ERROR`.
- `POST /addresses` with extraneous field `beneficiaryId` → `422 VALIDATION_ERROR`.
- `POST /addresses` with only `landmark` set → `422 VALIDATION_ERROR` (`addressLine`/locator rule).
- `PATCH /addresses/:id` `{ isDefault: false }` on the sole/default address → `422 DEFAULT_ADDRESS_REQUIRED`.
- 21st `POST /addresses` for one user → `422 ADDRESS_LIMIT_REACHED`.

### 16.3 Edge / concurrency
- Fire two concurrent `POST /addresses/{id}/default` for two different addresses of the same user → exactly one succeeds as the final default; DB constraint (§6.3) never violated; no `500`.
- Fire `GET /profile/me` concurrently with the very first request for a newly-registered user (before the event handler fires) → both succeed, no duplicate `CustomerProfile` rows (unique constraint on `userId` + upsert semantics).
- Soft-deleted addresses never reappear in `GET /addresses` or count toward the 20-address cap check... **counter-check**: confirm the cap query filters `deletedAt IS NULL`.

### 16.4 Security / access control
- Unauthenticated request (no bearer token) to any route in this slice → `401 UNAUTHENTICATED`.
- Authenticated user without `address:manage:own` (e.g., a role not granted it, once §7.2's open question is resolved) attempting `POST /addresses` → `403 FORBIDDEN` (permission-level, correctly distinct from the ownership `404`s).
- User A attempting `PATCH`/`DELETE`/`POST .../default` on User B's address → `404 NOT_FOUND` for every verb, never a `403` or `200` (confirms §7.3/AC-5 for all mutating routes, not just `GET`).
- Confirm operational logs (not audit logs) for a `PATCH /profile/me` call never contain the submitted `dateOfBirth` or `secondaryPhone` values (grep test log output in an integration test).
- Confirm the audit-log `context` for `PROFILE_UPDATED`/`ADDRESS_UPDATED` contains only field **names**, never field **values**.

### 16.5 Regression / integration with Identity
- Confirm Identity's `PATCH /users/me` (unchanged) still only accepts `preferredLanguage` and is unaffected by this module's addition.
- Confirm `JwtAuthGuard`/`PermissionsGuard` behavior is unchanged for Identity's own routes after `ProfilesModule` is registered in `app.module.ts` (no double-guard registration, no ordering regressions).

---

## 17. Traceability Summary

| Requirement | Where addressed |
| --- | --- |
| BR-USR-01 (profile with contact/delivery details) | §3, §8.1, §8.2 |
| BR-USR-04 (multiple addresses with GPS) | §3.2, §8.2 |
| FR-PRF-01/02 | §8.1 |
| FR-ADR-01/02/03 | §8.2, §5 |
| BRULE-21 (ET geofence for delivery) | §5, AC-3 |
| NFR-PRIV-01/02/06 | §12 |
| NFR-AUDIT-01 | §12, AC-6 |
| NFR-LOC-01/03 | §3.2 (structured Ethiopian address fields) |

---

**Next step (historical):** Architect review of §14's open questions and the §6.2/§6.3 schema changes. On approval, implementation proceeds per the folder layout in §10, in the order: domain → application → infrastructure → interface → tests (per `00-implementation-roadmap.md` §1 and §5).

**Closure (current):** All of the above was completed, reviewed, and verified (see §0). Module 02 Slice 1 is **APPROVED / IMPLEMENTED and FROZEN**. §14's open questions that were not required to ship this slice (PhoneNumber hoist, purge-job ownership, combined profile/identity view, non-customer address roles) remain open **backlog items** for a future slice/module and do not block Module 03.
