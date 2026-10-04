# Module 04 — Pharmacy & Inventory: Vertical Slice 1 Implementation Specification

**Slice:** Pharmacy Onboarding (org-linked) + Branches + Listings + Batches/Stock Ledger + Reservation/TTL + Availability Query
**Status:** APPROVED — Architect review complete. The 9 open questions originally listed in §14 are now resolved decisions (see §14). Ready for implementation per the folder layout in §11, following the same gate Modules 02/03 went through.
**Parent design doc:** `architecture/module-04-pharmacy-inventory.md` (§1–14) — this document narrows that design into a buildable, end-to-end first slice per `architecture/00-implementation-roadmap.md` §1 ("vertical slices, not horizontal layers"), following the same gate Module 02 (`backend/docs/02-profiles-spec.md`) and Module 03 (`backend/docs/03-catalog-spec.md`) went through.
**Depends on:** Module 01 — Identity & Authentication (RBAC, guards, audit, error envelope, `organizations`/`verification_requests` — reused as-is). Module 03 — Catalog, Slice 1 (`backend/docs/03-catalog-spec.md`) — read-only, by `Product.id`. **Consumed by (future):** Module 05 (Prescription/Matching — availability + pharmacy eligibility), Module 06 (Orders — reserve/confirm/release/dispatch), Module 14 (Search — stock/price projections), Module 16 (Admin — pharmacy oversight).
**Traceability:** BR-PH-01..14, FR-PH-01..10, F-INV-01..09, F-AVL-01..03, BRULE-05, BRULE-08, BRULE-10, BRULE-15, BRULE-19, BRULE-30, NFR-PERF-05, NFR-COMP-01/05, NFR-AUDIT.

> Prepared per user instruction: **design/specification only** — this document does not implement, scaffold, or modify any backend source, Prisma schema, or seed file. Every "required migration"/"new permission" item below remains a *proposed* change for the future implementation PR (that is normal for a pre-build spec, same as Modules 02/03's own migration/permission sections) — but every open **architectural** question has now been resolved by this review (§14), so the implementer has no ambiguous decision left to make.

---

## 0. Why this is a separate slice from the parent design doc

`architecture/module-04-pharmacy-inventory.md` specifies the **full** Pharmacy & Inventory bounded context, including staff invite/role management delegated to Module 01 (§3.2), bulk CSV import (§3.3 F-INV-06), pharmacy dashboards/compliance metrics (§3.5), and admin manual suspend/reactivate (§9.5). Per the roadmap's "vertical slices, not horizontal layers" principle — the same reasoning Module 02 used to defer beneficiaries/consent/notifications, and Module 03 used to defer equivalence/proposals/bulk-import — **Slice 1 ships the smallest end-to-end capability that unblocks Module 05/06**: a pharmacy can onboard, become eligible, open branches, list catalog products with priced/expiry-aware stock, and expose real-time, reservation-safe availability. Everything else in the parent doc is explicitly deferred below.

### 0.1 In scope for Slice 1
- **Pharmacy registration & profile** linked 1:1 to a Module 01 `Organization` (`type = PHARMACY`) (BR-PH-01, F-PH-01/02/03/04).
- **`TransactingEligibilityPolicy`** domain service gating listing creation/enable and availability exposure (BR-PH-02, BRULE-05).
- **License-expiry auto-suspend sweeper** (BR-PH-03, BRULE-08).
- **Branches** with operating hours (F-PH-05/06). Service zones (`service_zones`) are **modeled in schema but not exposed by Slice 1 write DTOs** — see §0.2.
- **Inventory listings** referencing a Catalog `Product` by id, with **stock batches** (expiry-aware) and an **append-only `stock_movements` ledger** (BR-PH-04/06/07/12/13, F-INV-01/02/03/04/07).
- **Reservation/hold + TTL** lifecycle (reserve → confirm → dispatch/release) via row-level locking (BR-PH-14, F-INV-08).
- **Availability query** (internal, consumed by Search/Order/Matching later) (F-AVL-01/03).
- Permissions, audit events, outbox events, error codes, and DTO validation for all of the above.

### 0.2 Explicitly out of scope for this slice (tracked for later slices of Module 04)
| Deferred item | Why deferred | Covered by |
| --- | --- | --- |
| Staff invite/role assignment (F-PH-08/09/10) | Fully delegated to Module 01's existing invite/role-assignment flow (`user_roles.organizationId`); no new Module 04 logic — a thin passthrough is not worth a Slice 1 endpoint before Module 06 needs it. | Module 04 — Slice 2 |
| Service zones — write API (F-PH-07) | Geofenced delivery-radius modeling depends on Module 08's routing/geo needs, which don't exist yet; `service_zones` schema is untouched and unused (read-only placeholder). | Module 04 — Slice 2 (with Module 08) |
| Bulk CSV import (F-INV-06) | Operational tooling, not a blocker for Module 05/06 to start consuming availability. `inventory_imports` schema untouched. | Module 04 — Slice 2 |
| Low-stock / near-expiry alerts (F-INV-05) | Requires Module 13 (Notifications) wiring decisions (channel, digest cadence) not yet made; the underlying data (`stock_batches.expiryDate`, listing `sellable`) is already queryable once Slice 1 ships. | Module 04 — Slice 2 (after Module 13 Phase-0 lands) |
| Pharmacy dashboards & compliance metrics (F-DSH-01/02, BR-PH-09/11) | Needs Module 06 (orders) and Module 07 (payment/settlement) data that don't exist yet — `pharmacy_metrics` cannot be populated honestly before then. | Module 04 — Slice 3 (after Module 06/07) |
| Admin manual suspend/reactivate + compliance view (§9.5 of parent doc) | Depends on Module 16's admin control-plane pattern (maker-checker) which isn't built; Slice 1 ships the **automatic** license-expiry suspend only. | Module 04 — Slice 2, or Module 16 |
| Catalog product proposal from pharmacy (F-INV-09) | Depends on Module 03 Slice 3 (`ProductProposal` moderation queue), which is itself gated on Module 04 existing (circular — Module 03's own doc defers proposals to "after Module 04 begins"). | Module 04 — Slice 2, coordinated with Module 03 — Slice 3 |
| `IImportParserPort`, `IGeoPort` adapters | No consumer in Slice 1 (import and zone features are deferred). | Module 04 — Slice 2 |
| Split multi-pharmacy order fulfillment (FR-MATCH-07) | Open architecture question (§14 below); availability query in Slice 1 returns per-pharmacy results, letting Module 06 decide splitting policy without Module 04 needing to know today. | Open question — see §14.2 |

### 0.3 Definition of done for this slice
A verified pharmacy owner can register a pharmacy (org-linked, `PENDING` until Module 01 verification approves it), manage branches and operating hours, create/enable/disable inventory listings that reference an existing Catalog product (classification/storage inherited, never overridden), receive stock in expiry-tracked batches, and have every quantity change ledgered. Order-side callers (stubbed in tests until Module 06 exists) can query real-time availability, reserve stock atomically with a TTL, confirm on payment, dispatch via FEFO, and release on cancel/timeout — with **no oversell possible under concurrency**, no expired stock ever counted as sellable, and license-expired pharmacies automatically excluded — all through permission-guarded (for writes), audited, envelope-consistent, transactionally-atomic endpoints, backed by tests per `00-implementation-roadmap.md` §5, matching the hardening pattern established in Modules 02/03.

---

## 1. Business & Functional Requirements Covered

| ID | Requirement | Slice 1 coverage |
| --- | --- | --- |
| BR-PH-01 | Pharmacies register and are verified before transacting | ✅ registration creates `Organization(PENDING_APPROVAL)` + `Pharmacy(PENDING)`; verification delegated to Module 01 |
| BR-PH-02 | Only valid, unexpired-license pharmacies may list/sell | ✅ `TransactingEligibilityPolicy` |
| BR-PH-03 | License-expired pharmacy auto-suspended | ✅ `LicenseExpirySweeper` (daily cron) |
| BR-PH-04 | Manage listings and stock | ✅ |
| BR-PH-05 | Bulk import/update | ⏸ Deferred (§0.2) |
| BR-PH-06 | Real-time stock availability per pharmacy | ✅ `GET /availability/product/:catalogProductId` |
| BR-PH-07 | Only valid, non-expired stock sellable | ✅ `SellableStockCalculator`, FEFO |
| BR-PH-08 | Operating hours + service zones | ✅ hours only; zones deferred (§0.2) |
| BR-PH-09 | Dashboards (orders/bookings/revenue) | ⏸ Deferred (§0.2) — no Order/Payment data exists yet |
| BR-PH-10 | Staff management, org-scoped roles | ⏸ Deferred (§0.2) — reuses Module 01 as-is, no new Module 04 surface |
| BR-PH-11 | Compliance/performance metrics | ⏸ Deferred (§0.2) |
| BR-PH-12 | Listings reference canonical Catalog product; classification immutable | ✅ `ICatalogPort.getProduct()`, read-only fields copied at listing-create time |
| BR-PH-13 | Temperature-sensitive flagging | ✅ `storageRequirement` copied from Catalog product |
| BR-PH-14 | Reserve on order, decrement on fulfillment, release on cancel | ✅ reservation state machine, §8 |

---

## 2. Integration with Module 01 (Identity) and Module 03 (Catalog)

- **No cross-module table reads or Prisma relations** (ADR-002), identical discipline to Modules 02/03. `Pharmacy.organizationId`, `InventoryListing.catalogProductId`, `StockMovement.actorUserId`, and `StockReservation.orderId` are plain `String` columns — never Prisma relations into Identity/Catalog/Orders.
- **AuthN/AuthZ fully reused, not reimplemented.** `IdentityModule` already registers `JwtAuthGuard`/`PermissionsGuard` as global `APP_GUARD`s — every `PharmacyInventoryModule` controller is protected automatically. The one genuinely public route (`GET /availability/product/:catalogProductId`, §10.3) uses a bare `@Public()` and nothing else, per the confirmed convention (`00-shared-conventions.md` §2, `backend/docs/03-catalog-spec.md` §2).
- **Two new cross-module read ports are required — the first genuine ones in the codebase.** Modules 01–03 have not needed to call each other's data yet (Catalog has no dependency on Identity data; Profiles has no dependency on Catalog). Module 04 is the first module that must **read** state owned by two other bounded contexts to enforce its own invariants:
  - **`IIdentityPort`** (new, `application/ports/identity.port.ts`) — `getOrganization(organizationId): { id, type, status, licenseNumber, licenseExpiresAt } | null` and `getOrganizationOwner(organizationId): { userId } | null`. Backed by an infrastructure adapter (`infrastructure/identity/identity-port.adapter.ts`) that calls `PrismaService.organization.findUnique` directly — **this is an in-process, same-database read**, not an HTTP call (the modular monolith runs one Postgres instance per ADR-001), but it goes through the port interface so Identity could be extracted to a separate service later without Module 04's application layer changing. Module 04 **never** writes to `organizations` — creation/verification stays exclusively Module 01's.
  - **`ICatalogPort`** (new, `application/ports/catalog.port.ts`) — `getProduct(productId): { id, type, status, rxClassification, controlledSchedule, onlineSaleProhibited, storageRequirement } | null`. Adapter reads `Product` via `PrismaService` directly, same in-process/port-abstracted pattern.
  - **Rationale for choosing "port wrapping a direct Prisma read" over an HTTP call to a sibling module:** consistent with ADR-001 (single deployable, one DB) and ADR-002 (ports, not relations) — the port is the abstraction boundary; the transport is a query today and could become a gRPC/REST call after extraction with no change to `application/`.
- **Pharmacy registration reuses Module 01's existing `Organization` create + `VerificationRequest` (type=PHARMACY_LICENSE) flow — Module 04 does not duplicate verification, and does not write to `organizations` at all.** **RESOLVED by this review (§14.1):** the **client** (mobile/web) orchestrates two calls — first `POST` against Module 01's own organization-registration endpoint to create `Organization(type=PHARMACY, status=PENDING_APPROVAL)` and its `VerificationRequest`, then `POST /pharmacy/register` (§5.1, §10.1) against Module 04 with the resulting `organizationId`. Module 04 only ever **reads** `organizations` (via `IIdentityPort`), never writes it — preserving ADR-002's "no cross-module writes to foreign tables" cleanly, at the cost of the client needing to sequence two calls. This is the first module pairing in the codebase that needs this exact "client orchestrates across two module APIs" pattern (Modules 02/03 didn't); it is confirmed here as the standing convention for any future module (09, 10, 12) that similarly needs to attach organization/entity records it doesn't own.
- **Zero event-driven bootstrapping is assumed for `Pharmacy` creation itself** — a `Pharmacy` row is created synchronously in the same request that creates (or references) the `Organization`, not reactively off a `UserRegistered`-style event (unlike Module 02's `EnsureCustomerProfileCommand`). Rationale: pharmacy registration is a distinct, deliberate business-user action (a form submission with license documents), not an implicit side effect of signup.

---

## 3. Domain Model

### 3.1 Pharmacy (aggregate root)
Existing Prisma model (`prisma/schema/04-pharmacy.prisma`) reused as-is — **no schema changes required** for this entity.

| Field | Type | Nullable | Notes |
| --- | --- | --- | --- |
| `id` | UUID | no | PK |
| `organizationId` | String (FK, intra-module: none; cross-module: scalar only) | no, `@unique` | References Module 01 `Organization.id` where `type = PHARMACY`; validated via `IIdentityPort.getOrganization()` at create time, not a DB FK (ADR-002) |
| `displayName` | String | no (business rule; column nullable) | 2–200 chars |
| `logoUrl` | String | yes | Already-hosted URL only — no upload endpoint in Slice 1 (same `IStoragePort` blocker as Module 02/03) |
| `description` | String | yes | ≤ 2000 chars |
| `ratingAvg` / `ratingCount` | Float / Int | no (defaults 0) | **Not written by Slice 1** — reserved for Module 15 (Reviews); read-only pass-through |
| `transactingStatus` | `TransactingStatus` (`ACTIVE`\|`SUSPENDED`\|`PENDING`) | no (default `PENDING`) | Server-computed only; see §6 |
| `licenseStatus` | `LicenseStatus` (`VALID`\|`EXPIRED`\|`SUSPENDED`) | no (default `VALID`) | Server-computed only |
| `licenseExpiresAt` | DateTime | yes | **Mirrored from** `Organization.licenseExpiresAt` at approval time (snapshot, per `00-shared-conventions.md` §11 "Snapshots") — re-synced whenever Module 01 re-verifies/renews; not independently editable by pharmacy staff |
| `createdAt`/`updatedAt`/`deletedAt` | DateTime | — | standard; soft-delete not used in Slice 1 (see invariant §3.6.8) |

### 3.2 Branch (entity within Pharmacy)
Existing Prisma model reused as-is.

| Field | Type | Nullable | Notes |
| --- | --- | --- | --- |
| `id` | UUID | no | PK |
| `pharmacyId` | String (FK, intra-module) | no | |
| `name` | String | no (business rule) | 2–120 chars |
| `region`/`city`/`subcity`/`woreda`/`addressLine` | String | yes | Ethiopian structured address (`00-shared-conventions.md` §11); at least `region` + `city` required at business layer |
| `lat`/`lng` | Float | yes | Required if the branch will ever appear in an `/availability` geo query; validated as a pair (both-or-neither) |
| `phone` | String | yes | E.164-ish format check, reusing Module 01's phone-normalization pattern (`backend/docs/...` phone tests) informally — not a hard dependency |
| `isActive` | Boolean | no (default `true`) | A branch can be deactivated without deleting listings history |

### 3.3 BranchOperatingHour (entity)
Existing model reused as-is: `id`, `branchId`, `weekday` (0–6), `openTime`/`closeTime` (`HH:mm` string), `isClosed`. Multiple rows per weekday allowed (split shifts). Not consumed by availability filtering logic in Slice 1 (no "open now" filter yet — the parent doc's F-PH-06 "drives open-now" behavior is a Module 14/Search concern layered on top of this raw data later); Slice 1 only stores and returns it.

### 3.4 InventoryListing (aggregate root)
Existing Prisma model reused as-is.

| Field | Type | Nullable | Notes |
| --- | --- | --- | --- |
| `id` | UUID | no | PK |
| `pharmacyId` / `branchId` | String (FK, intra-module) | no | |
| `catalogProductId` | String (cross-module scalar, ADR-002) | no | Validated to exist + be `ACTIVE` via `ICatalogPort.getProduct()` at create time; **no re-validation on every read** (would be a hot-path Catalog call per listing) — see invariant 6 for the staleness trade-off |
| `price` | Int (minor units) | no | > 0; `currency` defaults `ETB` (ADR-005) |
| `currency` | String | no (default `ETB`) | Fixed to `ETB` in Slice 1 — cross-border pricing is not modeled here |
| `onHand` / `reserved` / `sellable` | Int | no (default 0) | **Derived caches**, never directly settable via DTO — always recomputed transactionally from `stock_batches` + `stock_movements`/`stock_reservations` (§3.6 invariant 4, ADR-006) |
| `isEnabled` | Boolean | no (default `true`) | Pharmacy-controlled visibility toggle, independent of `sellable` (a listing can be enabled with 0 sellable stock — simply excluded from availability results, not deleted) |
| `storageRequirement` | `StorageRequirement` | no (default `AMBIENT`) | **Copied from Catalog product at create time, read-only thereafter** (BRULE-30) — see invariant 5 |
| `createdAt`/`updatedAt`/`deletedAt` | DateTime | — | Soft-delete **is** used here (unlike `Pharmacy`) — see invariant 8 |

Unique constraint: `(branchId, catalogProductId)` — one listing per product per branch (already in schema).

### 3.5 StockBatch (entity within a listing)
Existing model reused as-is: `id`, `listingId`, `batchNumber`, `quantity` (current on-hand for *this* batch), `expiryDate`, `supplier?`, `receivedAt?`, `createdAt`. Index `(listingId, expiryDate)` already present for FEFO.

### 3.6 StockMovement (immutable ledger entry)
Existing model reused as-is: `id`, `listingId`, `batchId?`, `type` (`RECEIPT`\|`RESERVE`\|`RELEASE`\|`DISPATCH`\|`ADJUST`\|`EXPIRE`\|`RETURN`), `quantityDelta` (signed), `reason?`, `refType?` (`ORDER`\|`IMPORT`\|`MANUAL`\|`SYSTEM`), `refId?`, `actorUserId?`, `createdAt`. **Append-only — no update/delete path is ever exposed** (mirrors `AuditLog`).

### 3.7 StockReservation (entity)
Existing model reused as-is: `id`, `listingId`, `orderId?`, `quantity`, `status` (`HELD`\|`CONFIRMED`\|`RELEASED`\|`EXPIRED`), `expiresAt`, `createdAt`. Index `(status, expiresAt)` already present for the TTL sweeper.

### 3.8 Value Objects
- `Money` — `{ amountMinor: number; currency: 'ETB' }`, mirrors ADR-005; reused conceptually from Module 03/07's pattern (no shared VO package yet — each module keeps its own thin wrapper per current codebase convention).
- `Quantity` — non-negative integer wrapper, rejects negative/`NaN`.
- `ExpiryDate` — wraps a `Date`, exposes `isExpired(asOf: Date): boolean`.
- `BatchNumber` — string wrapper, 1–60 chars, trimmed.
- `OperatingHours` — `{ weekday: 0..6; openTime?: string; closeTime?: string; isClosed: boolean }`, validates `openTime < closeTime` when both present.
- `LicenseStatus` — re-exported Prisma enum at the domain layer (`domain/enums.ts`), same pattern as Module 02/03's enum re-exports.
- `GeoPoint` — reused conceptually from Module 02's `GeoPoint` pattern (not literally imported cross-module per ADR-002 — a parallel, independently-owned copy in Module 04's `domain/value-objects/`) for `(lat, lng)` validity checks (not the Ethiopia-bounding-box check itself, which is Module 02/Address-specific).

### 3.9 Domain Services
- **`TransactingEligibilityPolicy`** (pure, framework-free) — `isEligible(pharmacy: { transactingStatus, licenseStatus, licenseExpiresAt }, now: Date): boolean`. Single home for BRULE-05/08 (per `00-shared-conventions.md` §12), consulted by `CreateListingCommand`, `EnableListingCommand`, and the availability query repository filter. **This exact shape is designed to be reused verbatim by Module 09's `ProviderEligibilityPolicy`** (shared conventions note it is "same shape") — Module 04 does not import Module 09's copy or vice versa (ADR-002 discipline extends to domain services, not just data).
- **`SellableStockCalculator`** (pure) — `computeSellable(batches: { quantity, expiryDate }[], reserved: number, now: Date): number` = `Σ(batch.quantity where expiryDate > now) − reserved`, floored at 0. Encodes BRULE-15.
- **`FefoAllocator`** (pure) — `allocate(batches: { id, quantity, expiryDate }[], requestedQty: number): { batchId, qty }[]`, sorted by `expiryDate` ascending, throws if `Σquantity < requestedQty`.
- **`ReservationManager`** (application-layer orchestrator, not pure — needs the repository/transaction) — coordinates the reserve/confirm/release/dispatch state machine described in §8; depends on `IListingRepository`, `IStockLedgerRepository`, `IReservationRepository` (all injected, mockable for use-case tests).

### 3.10 Invariants (safety- and money-critical)
1. A `Pharmacy` may create or **enable** a listing **only if** `TransactingEligibilityPolicy.isEligible(...)` is true (BRULE-05/08) — checked at create, at enable (`PATCH .../listings/:id {isEnabled:true}`), and defensively re-checked inside the reservation transaction (so a pharmacy suspended between "browse" and "reserve" cannot be reserved against).
2. **Sellable quantity** = `SellableStockCalculator` output — expired batches contribute **zero**; `sellable` is a cached column always recomputed inside the same transaction as any mutating batch/reservation/movement write, never patched independently (BRULE-15).
3. `on_hand ≥ reserved ≥ 0` at all times — enforced by application-layer checks before commit (not a DB `CHECK` constraint in Slice 1, since `reserved` is a materialized sum recomputed from `stock_reservations`, not an independently-updatable column — see §6.2 for the migration this implies).
4. Every quantity change **must** produce a `StockMovement` row in the same DB transaction (no silent edits); `onHand`/`reserved`/`sellable` are derived/cached, never authoritative (ADR-006). A command that changes quantity without writing a movement is a bug, not an allowed shortcut — enforced by code review + a dedicated integration test asserting `Σ(stock_movements.quantityDelta grouped by listing) === listing.onHand` after every mutating flow (see §16.3).
5. `InventoryListing.storageRequirement` (and, transitively, the product's `rxClassification`/`controlledSchedule`) are **copied once at listing-create time from `ICatalogPort.getProduct()` and never re-derived from a live Catalog read on the hot path** — but they are **read-only** thereafter: no update DTO field exists to change them (BRULE-10/30). See invariant 6 for the staleness trade-off this implies.
6. **Catalog staleness trade-off (explicit, not accidental) — RESOLVED by this review (§14.3):** if a Catalog admin later changes a product's `rxClassification`/`controlledSchedule`/`storageRequirement` (Module 03 admin-only mutation), an *existing* Module 04 listing's copied `storageRequirement` does not automatically update in Slice 1. **Accepted as-is, no reconciliation event added in this slice** — Catalog classification changes are rare, admin-gated, audited events, and a real reclassification-to-`PROHIBITED` mid-listing-life is an edge case rare enough that Slice 2 (once Module 05/06 exist and the operational cost of a stale listing is measurable) is the right time to add a `catalog.product.reclassified` domain event and a Module 04 consumer, rather than building speculative reconciliation machinery now.
7. A `StockReservation` has a **TTL** (`expiresAt`); if not confirmed within the window, a scheduled sweeper transitions it `HELD → EXPIRED` and restores `sellable` (BR-PH-14, ADR-007). **TTL duration — RESOLVED by this review (§14.4):** default **15 minutes**, read from `IConfigPort` key `inventory.reservationTtlMinutes` (module-namespaced, per §14.4's correction to `00-shared-conventions.md` §10's illustrative `orders.*` example), overridable per-deployment without a code change.
8. `InventoryListing` uses soft-delete (`deletedAt`); `Pharmacy`/`Branch` also carry `deletedAt` in schema but Slice 1 **never sets it** for `Pharmacy` (a pharmacy is deactivated via `transactingStatus = SUSPENDED`, not deleted — consistent with Module 03's "lifecycle via status, not deletion" pattern) — Slice 1 **does** expose a listing soft-delete (`DELETE /inventory/listings/:id` sets `deletedAt`, excluded from all reads) because a pharmacy discontinuing one product is a routine, frequent action unlike suspending an entire pharmacy.
9. Two listings can never exist for the same `(branchId, catalogProductId)` — enforced by the existing DB unique constraint; a duplicate create attempt returns `409 DUPLICATE_LISTING` with the existing listing id surfaced (mirrors Module 03's dedup UX, §3.6 invariant 4 there).

---

## 4. Transacting Eligibility & License Lifecycle (BRULE-05/08)

- **Eligible iff:** `pharmacy.transactingStatus = ACTIVE` **and** `pharmacy.licenseStatus = VALID` **and** (`licenseExpiresAt` is null **or** `licenseExpiresAt > now`).
- **On Module 01 verification approval** (`VerificationRequest.type = PHARMACY_LICENSE` → `APPROVED`): **RESOLVED by this review** — Slice 1 deliberately does **not** auto-react via a live event subscription, because Module 01 does not yet emit a `VerificationApproved`/`VerificationDecided` domain event (confirmed against the current `00-domain-event-catalog.md` and the Identity module source — no such event exists today). Instead, **pharmacy activation is an explicit, separately-called command** (`ActivatePharmacyCommand`) invoked once an operator has confirmed the verification decision through Module 01's own admin flow; it reads the current `VerificationRequest`/`Organization` status via `IIdentityPort` and transitions `Pharmacy.transactingStatus PENDING → ACTIVE`, `licenseStatus → VALID`, snapshotting `licenseExpiresAt`. **This is confirmed as the standing decision for Slice 1** — adding a `VerificationApproved` event to Module 01 and switching Module 04 to an event-driven activation is explicitly deferred to a later slice (candidate for Module 04 — Slice 2, coordinated with a Module 01 event-catalog addition) rather than guessed at speculatively now.
- **License-expiry sweeper** (`LicenseExpirySweeper`, daily cron + on-demand near-expiry check): finds `Pharmacy` rows where `licenseExpiresAt ≤ now` and `transactingStatus = ACTIVE`; transitions to `SUSPENDED`/`licenseStatus = EXPIRED`; all listings under that pharmacy are excluded from `sellable`-based availability filtering (not deleted, not individually flagged — the eligibility check happens at the pharmacy level in the availability query, so no per-listing write is needed); emits `PharmacySuspended` via the outbox (BRULE-08); writes an audit entry `PHARMACY_AUTO_SUSPENDED`.
- **Renewal:** out of scope for Slice 1 — re-activation requires the same explicit `ActivatePharmacyCommand` path once Module 01 records a renewed, non-expired license. No dedicated "renew" endpoint is added in this slice (would duplicate `ActivatePharmacyCommand`).

---

## 5. Validation Rules (DTO-level, `class-validator`, same `ValidationPipe` config as Modules 02/03: `whitelist: true, forbidNonWhitelisted: true, transform: true`)

### 5.1 Pharmacy — `RegisterPharmacyDto` (`POST /pharmacy/register`)
```ts
class RegisterPharmacyDto {
  @IsUUID() organizationId!: string; // must already exist as Organization(type=PHARMACY), owned by the caller
  @IsString() @Length(2, 200) displayName!: string;
  @IsOptional() @IsUrl() logoUrl?: string;
  @IsOptional() @IsString() @Length(0, 2000) description?: string;
}
class UpdatePharmacyProfileDto {
  @IsOptional() @IsString() @Length(2, 200) displayName?: string;
  @IsOptional() @IsUrl() logoUrl?: string;
  @IsOptional() @IsString() @Length(0, 2000) description?: string;
}
```
- Business validation (command layer, not DTO — same split as Module 02's DOB rule / Module 03's classification rule): `organizationId` must resolve via `IIdentityPort.getOrganization()` to `type = PHARMACY`; caller must be the organization's owner (`getOrganizationOwner().userId === currentUser.id`) → otherwise `403 RBAC_FORBIDDEN`; must not already have a `Pharmacy` row (`409 PHARMACY_ALREADY_REGISTERED`).

### 5.2 Branch — `CreateBranchDto` / `UpdateBranchDto`
```ts
class CreateBranchDto {
  @IsString() @Length(2, 120) name!: string;
  @IsOptional() @IsString() region?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() subcity?: string;
  @IsOptional() @IsString() woreda?: string;
  @IsOptional() @IsString() @Length(0, 300) addressLine?: string;
  @IsOptional() @IsLatitude() lat?: number;
  @IsOptional() @IsLongitude() lng?: number;
  @IsOptional() @Matches(PHONE_REGEX) phone?: string;
}
class UpdateBranchDto extends PartialType(CreateBranchDto) {
  @IsOptional() @IsBoolean() isActive?: boolean;
}
class SetOperatingHoursDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => OperatingHourRowDto)
  hours!: OperatingHourRowDto[]; // full-week replace, same "replace all" semantics as a PUT
}
class OperatingHourRowDto {
  @IsInt() @Min(0) @Max(6) weekday!: number;
  @IsOptional() @Matches(/^\d{2}:\d{2}$/) openTime?: string;
  @IsOptional() @Matches(/^\d{2}:\d{2}$/) closeTime?: string;
  @IsBoolean() isClosed!: boolean;
}
```
- Business validation: `(lat, lng)` must be both-present-or-both-absent (`422 VALIDATION_ERROR`); `openTime < closeTime` when `isClosed = false`.

### 5.3 Listing — `CreateListingDto` (`POST /inventory/listings`)
```ts
class CreateListingDto {
  @IsUUID() catalogProductId!: string;
  @IsUUID() branchId!: string;
  @IsInt() @Min(1) price!: number; // minor units
  @IsOptional() @IsIn(['ETB']) currency?: string; // Slice 1: ETB only
  @IsString() @Length(1, 60) batchNumber!: string; // Slice 1 requires an initial batch — RESOLVED, §14.5: mandatory for every listing
  @IsInt() @Min(1) initialQuantity!: number;
  @IsDateString() expiryDate!: string; // must be in the future
  @IsOptional() @IsString() supplier?: string;
}
class UpdateListingDto {
  @IsOptional() @IsInt() @Min(1) price?: number;
  @IsOptional() @IsBoolean() isEnabled?: boolean;
}
class AddBatchDto {
  @IsString() @Length(1, 60) batchNumber!: string;
  @IsInt() @Min(1) quantity!: number;
  @IsDateString() expiryDate!: string;
  @IsOptional() @IsString() supplier?: string;
}
class AdjustBatchDto {
  @IsInt() quantityDelta!: number; // signed; positive=correction-up, negative=correction-down/damage/loss
  @IsString() @Length(3, 300) reason!: string; // mandatory, unlike other mutations — an ADJUST movement without a reason is rejected
}
```
- `catalogProductId` is **immutable after create** — no update DTO field exists for it (changing the referenced product post-hoc is a data-integrity hazard, same reasoning as Module 03's immutable `type`; create a new listing instead).
- Business validation (command layer): `catalogProductId` resolves via `ICatalogPort.getProduct()` to a non-deleted, `ACTIVE` product with `onlineSaleProhibited = false` → otherwise `422 CONTROLLED_PROHIBITED` (or `404 CATALOG_PRODUCT_NOT_FOUND` if missing/inactive); `branchId` belongs to the caller's pharmacy → otherwise `404 BRANCH_NOT_FOUND`; `TransactingEligibilityPolicy` passes → otherwise `403 PHARMACY_NOT_ELIGIBLE` / `403 LICENSE_EXPIRED`; `(branchId, catalogProductId)` not already listed → otherwise `409 DUPLICATE_LISTING`.

### 5.4 Availability/reservation — internal DTOs (`POST /availability/reserve|confirm|release`)
```ts
class ReserveStockDto {
  @IsUUID() listingId!: string;
  @IsInt() @Min(1) quantity!: number;
  @IsUUID() orderId!: string;
  @IsString() @Length(1, 100) idempotencyKey!: string; // required per 00-shared-conventions §7 "idempotency keys on ... booking mutations"
}
class ConfirmReservationDto { @IsUUID() reservationId!: string; }
class ReleaseReservationDto { @IsUUID() reservationId!: string; @IsOptional() @IsString() reason?: string; }
```

### 5.5 Availability query — `GetAvailabilityQueryDto` (`GET /availability/product/:catalogProductId`)
```ts
class GetAvailabilityQueryDto {
  @IsOptional() @IsLatitude() lat?: number;
  @IsOptional() @IsLongitude() lng?: number;
  @IsOptional() @IsInt() @Min(100) @Max(50000) radiusMeters?: number; // default from IConfigPort
  @IsOptional() @IsInt() @Min(1) @Max(100) limit?: number;
}
```
- If `lat`/`lng` are omitted, results are unordered by distance (returned by price ascending) — this is intentional for Slice 1 (no PostGIS yet; see §11 Future Scalability carry-over).

---

## 6. Database Requirements

### 6.1 Already correct, no change needed
All tables in `prisma/schema/04-pharmacy.prisma` — `pharmacies`, `branches`, `branch_operating_hours`, `service_zones`, `inventory_listings`, `stock_batches`, `stock_movements`, `stock_reservations`, `pharmacy_metrics`, `inventory_imports` — already match the parent design doc's §7 shape and validate. **No Slice 1 field is missing from the current schema.**

### 6.2 Required migration (proposed, NOT applied) — partial index for eligible/enabled listing lookups
`inventory_listings` currently has `@@unique([branchId, catalogProductId])` and `@@index([catalogProductId])`. The availability hot path (§9.4) filters `WHERE catalogProductId = ? AND isEnabled = true AND sellable > 0 AND deletedAt IS NULL`, joined to `pharmacies` for eligibility. Recommend a proposed (not-yet-applied) composite index:
```
@@index([catalogProductId, isEnabled, sellable])
```
This is a **recommendation for the implementation PR**, not a change made by this spec — flagged so the future implementer doesn't have to rediscover it from a slow-query log.

### 6.3 Required migration (proposed, NOT applied) — row-lock-friendly reservation confirm
`stock_reservations` has `@@index([status, expiresAt])` already, which is sufficient for the TTL sweeper's `WHERE status='HELD' AND expiresAt < now()` scan. No additional index is proposed here; confirming this scan pattern is efficient at scale is deferred to a load test once Slice 1 exists (not a blocking migration).

### 6.4 No other schema changes
Unlike Module 02 (which needed a nullability fix) and Module 03 (which needed a dedup index), **Module 04's existing Prisma schema requires zero must-fix changes** to build Slice 1 as scoped — a rare and worth-noting outcome, attributable to the parent design doc's schema having already been written with the reservation/ledger pattern in mind. §6.2 is an optional performance index, not a correctness fix.

---

## 7. Permissions (RBAC)

### 7.1 Reused, no change
`inventory:manage:org` already exists in `prisma/rbac-catalog.ts` (added when Module 03's catalog spec referenced it), already granted to `PHARMACY_OWNER`, `PHARMACY_MANAGER`, and `INVENTORY_STAFF`. This is Slice 1's primary write permission for listings/batches.

### 7.2 New permissions to add to `prisma/rbac-catalog.ts` (proposed, NOT applied by this spec)
| Key | Resource | Action | Scope | Granted to |
| --- | --- | --- | --- | --- |
| `pharmacy:manage:org` | `pharmacy` | `manage` | `org` | `PHARMACY_OWNER` only (profile/branch/hours are owner-level, not shared with managers/inventory staff — consistent with the parent doc's "owner/manager restricted per RBAC" note, §3.2) |
| `pharmacy:register` | `pharmacy` | `register` | — (unscoped; any authenticated user with `PrimaryRole = PHARMACY_OWNER` and no existing `Pharmacy` may call it) | `PHARMACY_OWNER` |
| `availability:read:any` | `availability` | `read` | `any` | Reserved for a future *authenticated* availability read (analogous to Module 03's `catalog:read:any` reservation) — **not attached to any route in Slice 1**; the public availability route uses `@Public()` (§7.3) |

**No permission is added for reserve/confirm/release.** **RESOLVED by this review (§14.6):** these are not user-facing actions at all — they are consumed in-process by other modules (Module 06, later) via `IInventoryPort` (Nest DI), never over HTTP, so no permission key, guard, or internal-service-token scheme is needed for them in this slice. See §14.6 and the revised §10.3/§11.

### 7.3 Guarding
- `POST /pharmacy/register` → `@RequirePermissions('pharmacy:register')`.
- `GET/PATCH /pharmacy/profile`, branch/hours CRUD → `@RequirePermissions('pharmacy:manage:org')`; ownership/org-scope enforced in the application layer by comparing `pharmacy.organizationId` against the caller's `user_roles.organizationId` for that org (per `00-shared-conventions.md` §2 "scope validated in the application layer").
- `POST/PATCH/DELETE /inventory/listings*`, `/inventory/listings/:id/batches*` → `@RequirePermissions('inventory:manage:org')`.
- `GET /inventory/listings*`, `/inventory/listings/:id/movements` → `@RequirePermissions('inventory:manage:org')` (read access mirrors write scope in Slice 1 — no separate `inventory:read:org` yet, consistent with how Module 03 deferred `catalog:read:any` until actually needed).
- `GET /availability/product/:id` → `@Public()` — genuinely unauthenticated (browsing/search-time query), **and nothing else**, per the confirmed convention.
- **Reserve/confirm/release** → **RESOLVED (§14.6): not HTTP routes at all in Slice 1.** They are exported as `IInventoryPort` methods (`application/ports/inventory.port.ts`, provided by `PharmacyInventoryModule.exports`) for other in-process modules to call directly via Nest DI, so no guard/permission decision is needed for them — see §10.3/§11. Slice 1's own test suite exercises them by instantiating the port/command directly (or via a thin internal test controller, never a permission-guarded public route).

---

## 8. Concurrency & Stock Reservation (BR-PH-14) — the correctness-critical flow

- **Reserve:** single DB transaction —
  1. `SELECT ... FROM inventory_listings WHERE id = $1 FOR UPDATE` (row-level lock, serializes concurrent reserve attempts on the same listing).
  2. Re-check `TransactingEligibilityPolicy` on the owning pharmacy (defensive re-check, invariant §3.10.1).
  3. Recompute `sellable` from live `stock_batches`/existing `HELD`+`CONFIRMED` reservations; if `sellable < quantity` → rollback, `409 INSUFFICIENT_STOCK` with `{ available: sellable }` in `error.details` (mirrors parent doc's error contract).
  4. Insert `stock_reservations(status=HELD, expiresAt = now + reservationTtlMinutes)`.
  5. Insert `stock_movements(type=RESERVE, quantityDelta = -quantity, refType=ORDER, refId=orderId)`.
  6. Update `inventory_listings.reserved += quantity`, `sellable = onHand - reserved(new)`.
  7. Commit; write outbox `StockReserved` event (same transaction, §9).
  - **Idempotency:** `idempotencyKey` (§5.4) is checked against a per-listing+order dedup lookup before step 1 — a replay with the same key returns the original reservation, never double-reserves (`00-shared-conventions.md` §7).
- **Confirm** (on payment success, called by Module 06 in the future): `stock_reservations.status HELD → CONFIRMED`. No quantity change (stock was already decremented from `sellable` at reserve time) — only a state transition + `StockReservationConfirmed`-style bookkeeping; no new `stock_movements` row (the RESERVE movement already captured the effect).
- **Dispatch** (pharmacy marks ready / fulfillment triggers it): `FefoAllocator.allocate()` picks batches earliest-expiry-first up to the reserved quantity; for each allocated batch, `stock_movements(type=DISPATCH, quantityDelta=-qty, batchId=...)`, `stock_batches.quantity -= qty`, `inventory_listings.onHand -= qty`, `reserved -= qty` (the reservation's hold is released from `reserved` because it is now a permanent decrement). **RESOLVED by this review (§14.7): no `DISPATCHED` reservation-status enum value is added in Slice 1.** The reservation is left `CONFIRMED`; "has this reservation's stock physically left the pharmacy" is answered by `IInventoryPort.getReservationFulfillment(reservationId)`, a small read query joining the reservation to any `DISPATCH` movement referencing it (`refType=ORDER, refId=orderId`) — cheap at Slice 1's scale and avoids widening the enum for a query need that Module 06/08 have not yet concretely specified. Revisit only if that join becomes a measured hotspot.
- **Release** (cancel / payment fail / TTL expiry): `stock_movements(type=RELEASE, quantityDelta=+quantity)`; `inventory_listings.reserved -= quantity`, `sellable` recomputed; reservation `→ RELEASED` (explicit cancel) or `→ EXPIRED` (sweeper).
- **`ReservationTtlSweeper`** (cron, e.g. every 1 minute): `SELECT ... WHERE status='HELD' AND expiresAt < now() FOR UPDATE SKIP LOCKED` batched, then runs the same Release logic per row. `SKIP LOCKED` prevents the sweeper from blocking on rows a concurrent confirm/cancel is actively handling.
- **Isolation level:** `Read Committed` (Postgres default) is sufficient for the reserve flow because correctness comes from the explicit row lock (`FOR UPDATE`), not from the transaction isolation level — this differs from Module 02's `Serializable`+retry choice for the audit hash-chain (a different correctness mechanism for a different problem: sequential hash-chaining vs. quantity locking). Documented explicitly here to avoid an implementer defaulting to `Serializable` unnecessarily and taking a throughput hit under the "10k concurrent" NFR-PERF-05 target.
- **No oversell guarantee:** because step 1's row lock serializes all reserve attempts against the same listing, and step 3 re-reads `sellable` fresh under that lock, two concurrent reserve calls for the last unit of stock cannot both succeed — the second sees `sellable = 0` after the first commits (or blocks until it does).

---

## 9. Domain Events Emitted (published to `EVENT_BUS` via the outbox, same transaction as the state change, per ADR-010)

| Event | Payload | Trigger |
| --- | --- | --- |
| `PharmacyActivated` | `{ pharmacyId, organizationId }` | `ActivatePharmacyCommand` succeeds |
| `PharmacySuspended` | `{ pharmacyId, reason: 'LICENSE_EXPIRED' \| 'MANUAL' }` | License sweeper, or (future Slice 2) manual admin suspend |
| `ListingCreated` | `{ listingId, catalogProductId, branchId, pharmacyId, price }` | `CreateListingCommand` |
| `ListingDisabled` | `{ listingId }` | `UpdateListingCommand` with `isEnabled:false`, or listing soft-delete |
| `PriceChanged` | `{ listingId, oldPrice, newPrice }` | `UpdateListingCommand` with a `price` change |
| `StockReceived` | `{ listingId, batchId, quantity, expiryDate }` | `AddBatchCommand` / initial batch at listing create |
| `StockReserved` | `{ listingId, reservationId, orderId, quantity }` | Reserve flow §8 |
| `StockReleased` | `{ listingId, reservationId, quantity, reason }` | Release flow §8 |
| `StockDispatched` | `{ listingId, orderId, quantity, batchAllocations }` | Dispatch flow §8 |

These match the parent doc's §5.3/§10 event list exactly (`PharmacyActivated`, `PharmacySuspended`, `ListingCreated`, `PriceChanged`, `StockReceived`, `StockReserved`, `StockReleased`, `StockDispatched` are also named in `00-domain-event-catalog.md` §"04"). **`BatchNearExpiry` and `StockLow`** (named in the parent doc's folder-structure comment, §10) are **not emitted in Slice 1** — they depend on the deferred alerting feature (§0.2) and would need a Module 13 consumer that doesn't exist yet; adding the event without a consumer would be dead code. `ListingDisabled` is added here (present in the parent doc's API-error/event vocabulary implicitly via "listing disabled" audit line, §13) though not explicitly itemized in the parent's §5.3 table — included because `PriceChanged`-style granular events for every listing mutation is the established pattern and Module 14 will need it to remove disabled listings from its projection.

**Contract-testing note:** every event above must validate against `00-domain-event-catalog.md`'s Module 04 row once this slice is implemented, per `00-implementation-roadmap.md` §5 "Contract tests."

---

## 10. API Contracts

Base paths per parent doc §9 and `00-shared-conventions.md` §1: `/api/v1/pharmacy`, `/api/v1/inventory`, `/api/v1/availability`. Bearer auth via global guards; envelope/errors per §1 of shared conventions.

### 10.1 Pharmacy Onboarding & Profile
- **POST `/pharmacy/register`** `{ organizationId, displayName, logoUrl?, description? }` → `201 { pharmacyId, transactingStatus: 'PENDING' }`.
- **GET `/pharmacy/profile`** → current pharmacy profile (resolved from caller's org membership).
- **PATCH `/pharmacy/profile`** → update `displayName`/`logoUrl`/`description`.
- **POST `/pharmacy/activate`** *(ops/admin trigger, not a pharmacy self-service action — called by an operator after confirming a Module 01 verification decision, per §4/§14.1)* → `ActivatePharmacyCommand`. Guard: `@RequirePermissions('provider:verify:any')` (reuses the existing Module 01 admin permission for verification decisions, rather than inventing a Module 04-specific one for what is fundamentally the same "verification decision" action).
- **POST `/pharmacy/branches`**, **GET `/pharmacy/branches`**, **PATCH `/pharmacy/branches/:id`** → branch CRUD (no hard delete — `isActive:false` instead, consistent with §3.10.8's philosophy of status over deletion for pharmacy-level entities).
- **PUT `/pharmacy/branches/:id/hours`** → full-week replace.

### 10.2 Inventory
- **GET `/inventory/listings`** — filters: `branchId?`, `catalogProductId?`, `lowStock?` (boolean, threshold from `IConfigPort`), `nearExpiry?` (boolean, window from `IConfigPort`). Paginated per §1 convention.
- **POST `/inventory/listings`** — create + initial batch atomically (§5.3). `403 PHARMACY_NOT_ELIGIBLE` / `403 LICENSE_EXPIRED`, `404 CATALOG_PRODUCT_NOT_FOUND`, `422 CONTROLLED_PROHIBITED`, `409 DUPLICATE_LISTING`.
- **PATCH `/inventory/listings/:id`** — price/enable. `PriceChanged`/`ListingDisabled` events as applicable.
- **DELETE `/inventory/listings/:id`** — soft-delete (`deletedAt`), excluded from availability immediately.
- **POST `/inventory/listings/:id/batches`** — add batch → `RECEIPT` movement, `StockReceived` event.
- **PATCH `/inventory/batches/:id`** — `AdjustBatchDto` (reason mandatory) → `ADJUST` movement.
- **GET `/inventory/listings/:id/movements`** — paginated ledger view (audit read, `inventory:manage:org`).

### 10.3 Availability (read: public HTTP; reserve/confirm/release: in-process port — RESOLVED §14.6)
- **GET `/availability/product/:catalogProductId`** — `@Public()`. Query: `lat?,lng?,radiusMeters?,limit?`. Returns `[{ pharmacyId, branchId, listingId, price, currency, sellable, distanceMeters?, storageRequirement }]`, excluding ineligible pharmacies and disabled/zero-sellable/soft-deleted listings. This is the **only** HTTP route in §10.3 — it is the one genuinely external-facing read (browse/search time), so it gets a normal, public, rate-limitable HTTP surface.
- **`IInventoryPort.reserve({ listingId, quantity, orderId, idempotencyKey })`** → `{ reservationId, expiresAt }` or throws `InsufficientStockError`/`PharmacyNotEligibleError` (mapped to the same `INSUFFICIENT_STOCK`/`PHARMACY_NOT_ELIGIBLE` `ErrorCode`s a controller would use, so the eventual Module 06 saga gets identical error semantics whether the call is in-process or, post-extraction, over the wire).
- **`IInventoryPort.confirm({ reservationId })`** → `void` or throws `ReservationNotFoundError`/`InvalidReservationStateError`.
- **`IInventoryPort.release({ reservationId, reason? })`** → `void`, idempotent (a repeat release of an already-released/expired reservation is a no-op, not an error — safe for saga compensation retries per `00-shared-conventions.md` §7).
- **Why no HTTP surface for these three (RESOLVED, §14.6):** Module 06 (the only caller) runs in the same NestJS process per ADR-001; routing a call through this module's own HTTP layer back to itself would add latency, a redundant serialization round-trip, and — critically — would force an internal-service-authorization scheme (mTLS/service tokens) that exists nowhere else in this codebase, purely to protect an endpoint no external client should ever reach. The port is the correct abstraction boundary per `00-shared-conventions.md` §2 ("modules call each other only through ports... never foreign tables") — that principle is not limited to read queries. **If/when Module 04 is ever extracted to a separate deployable** (ADR-001's stated future path), `IInventoryPort`'s adapter simply becomes an HTTP/gRPC client instead of a direct in-process call, and *that* is the point at which a real service-to-service auth ADR gets written — not before, and not speculatively in this slice.

**Representative errors (module-prefixed where useful):** `PHARMACY_NOT_ELIGIBLE`, `LICENSE_EXPIRED`, `PHARMACY_SUSPENDED`, `PHARMACY_ALREADY_REGISTERED`, `BRANCH_NOT_FOUND`, `LISTING_NOT_FOUND`, `DUPLICATE_LISTING`, `INSUFFICIENT_STOCK`, `BATCH_EXPIRED`, `RESERVATION_NOT_FOUND`, `INVALID_RESERVATION_STATE`, `RESERVATION_EXPIRED`, `CATALOG_PRODUCT_NOT_FOUND`, `CONTROLLED_PROHIBITED`, `RBAC_FORBIDDEN`, `VALIDATION_ERROR`.

---

## 11. NestJS Module Layout (Clean Architecture) — proposed for the implementation PR

```
src/modules/pharmacy-inventory/
  domain/
    entities/            # Pharmacy, Branch, InventoryListing, StockBatch, StockMovement, StockReservation
    value-objects/        # Money, Quantity, ExpiryDate, BatchNumber, OperatingHours, LicenseStatus, GeoPoint
    events/                # PharmacyActivated, PharmacySuspended, ListingCreated, ListingDisabled, PriceChanged,
    │                      # StockReceived, StockReserved, StockReleased, StockDispatched
    enums.ts               # re-exported Prisma enums (TransactingStatus, LicenseStatus, StockMovementType, ReservationStatus)
    repositories/          # IPharmacyRepository, IBranchRepository, IListingRepository, IStockLedgerRepository, IReservationRepository
    services/              # TransactingEligibilityPolicy, SellableStockCalculator, FefoAllocator
  application/
    commands/              # RegisterPharmacy, ActivatePharmacy, UpdateProfile, CreateBranch, UpdateBranch, SetOperatingHours,
    │                      # CreateListing, UpdateListing, DeleteListing, AddBatch, AdjustBatch,
    │                      # ReserveStock, ConfirmReservation, ReleaseReservation, DispatchStock
    queries/               # GetAvailability, ListListings, GetListingMovements, GetReservationFulfillment
    ports/
      inbound/             # IInventoryPort — RESOLVED §14.6: the module's own exported contract (reserve/confirm/release/
      │                    # dispatch/getReservationFulfillment) for other in-process modules to consume via Nest DI;
      │                    # implemented by an application-layer service, not by a controller
      outbound/            # ICatalogPort, IIdentityPort, IConfigPort (reused from shared/), IUnitOfWork
    dtos/ mappers/
  infrastructure/
    persistence/prisma/    # Prisma*Repository implementations; transactional reserve with FOR UPDATE
    catalog/               # CatalogPortAdapter (direct PrismaService read of Product, per §2)
    identity/              # IdentityPortAdapter (direct PrismaService read of Organization, per §2)
    scheduling/            # LicenseExpirySweeper, ReservationTtlSweeper — RESOLVED §14.4/§16: use @nestjs/schedule
    │                      # (no scheduler exists yet anywhere in the codebase; confirmed via search — this is a new,
    │                      # officially-adopted dependency for the platform, not a Module-04-only choice; any later
    │                      # module needing cron (Module 09/10 eligibility sweepers, Module 13 digests) reuses it)
  interface/
    http/
      controllers/         # PharmacyController, BranchController, InventoryController, AvailabilityController
      │                    # (AvailabilityController exposes ONLY the public GET; it does not expose reserve/confirm/
      │                    # release — those are `IInventoryPort` methods injected directly by consuming modules, §10.3)
      dtos/ guards/ decorators/ filters/
  pharmacy-inventory.module.ts   # `exports: [INVENTORY_PORT]` so Module 06 (later) can `imports: [PharmacyInventoryModule]`
                                  # and inject `IInventoryPort` directly — no HTTP round-trip to itself
```

**Rationale.** Identical dependency rule to §13 of `00-shared-conventions.md`: domain ← application ← infrastructure/interface, domain framework-free. Cross-context reads go through `ICatalogPort`/`IIdentityPort` (never a bare `PrismaService.product.findUnique()` call from inside `application/`) so a future extraction only touches `infrastructure/`. The `ports/inbound` vs `ports/outbound` split (new in this module — Modules 02/03 only ever needed outbound ports, since nothing called into them programmatically yet) makes explicit that Module 04 is simultaneously a **port consumer** (Catalog, Identity) and, for the first time in this codebase, a **port provider** (`IInventoryPort` for Module 06).

---

## 12. Transactions — summary of atomic units

| Operation | Atomic unit (single DB transaction) |
| --- | --- |
| Create listing + initial batch | listing insert, batch insert, RECEIPT movement, `onHand`/`sellable` update, audit entry, outbox `ListingCreated`+`StockReceived` |
| Add batch | batch insert, RECEIPT movement, `onHand`/`sellable` update, audit entry, outbox `StockReceived` |
| Adjust batch | batch quantity update, ADJUST movement (reason required), `onHand`/`sellable` update, audit entry |
| Reserve | `SELECT FOR UPDATE` listing, reservation insert, RESERVE movement, `reserved`/`sellable` update, outbox `StockReserved` |
| Confirm | reservation status update only (no quantity change) |
| Dispatch | FEFO batch decrements, DISPATCH movement(s), `onHand`/`reserved` update, outbox `StockDispatched` |
| Release | reservation status update, RELEASE movement, `reserved`/`sellable` update, outbox `StockReleased` |
| License sweeper (per pharmacy) | `transactingStatus`/`licenseStatus` update, audit entry, outbox `PharmacySuspended` |

Every row in this table must commit or roll back **together** — a partial write (e.g., movement written but cached balance not updated, or state changed but outbox row missing) is a correctness bug, not an acceptable edge case (ADR-006, ADR-010). This mirrors the pattern already established in Module 02's `PrismaUnitOfWork` (state + audit + outbox in one transaction) — Module 04 should reuse or closely mirror that `IUnitOfWork` port rather than inventing a second transactional pattern in the codebase.

---

## 13. Audit & Outbox

- **Audit (hash-chained, `AuditService.record()`)** — must-audit actions per `00-shared-conventions.md` §4 and the parent doc §13: pharmacy activate/suspend (auto+manual), listing create/enable/disable/delete, **price change (old→new in `context`)**, every stock movement type (already ledgered — the `stock_movements` row itself is the audit trail per shared-conventions §4's "module-specific immutable ledgers that double as audit trails"; a *separate* `AuditLog` row is only written for the higher-level business action, e.g. "LISTING_CREATED", not duplicated per movement), reservation confirm/release when triggered by a manual admin action (not the routine sweeper — routine TTL expiry is logged at `info` level operationally, not written to the compliance audit log, to avoid flooding it with routine abandoned-cart noise; this is a judgment call flagged for confirmation, not firm doctrine).
- **Outbox** — every event in §9 is written to `outbox` in the same transaction as its triggering state change (ADR-010); a relay/dispatcher (already built in Phase 0's shared kit) publishes to `EVENT_BUS`. Module 04 adds no new outbox infrastructure — it reuses `OutboxService.write()`/`writeMany()` exactly as Modules 02/03 do (confirmed against `src/shared/outbox/outbox.service.ts`).
- **Never audit or log:** raw supplier contact details beyond what's stored, or any field not already in the non-sensitive category — Module 04 has no health/PII data of its own (BR-PH-* is commercial, not clinical), so the stricter §4 "never log" rules (secrets, health text) are inherited but largely not triggered by this module's own data.

---

## 14. Architect Review — Resolved Decisions

This section originally listed 9 open questions (5 carried from the parent doc, 4 newly surfaced by this slice's design). All 9 have now been through formal architect review; each resolution has already been folded into the relevant section above (§2, §3.10, §4, §5.3, §7, §10.3, §11). Kept here, restated as decisions, for traceability — mirroring the pattern Module 03 used in its own §14.

1. **Registration write-path across modules (new) — RESOLVED, client-orchestrated two-call pattern.** The client creates the Module 01 `Organization(type=PHARMACY)` first, then calls Module 04's `POST /pharmacy/register` with the resulting `organizationId`. Module 04 never writes `organizations`; it only reads via `IIdentityPort`. **Decision folded into §2, §5.1, §10.1.** This is now the standing convention for any future module needing to attach records to an entity it doesn't own — worth eventually promoting to `00-shared-conventions.md` if a second module (09/10/12) needs the identical pattern.
2. **Multi-pharmacy order splitting (FR-MATCH-07) — RESOLVED as non-blocking for Module 04.** This is a Module 06 (Orders) product/architecture decision, not a Module 04 one. Slice 1's availability API is deliberately split-friendly (§10.3 returns a per-pharmacy list rather than pre-aggregating), so **no change to this module** is needed regardless of which way Module 06 eventually decides. Remains an open **product** question at the index level (`00-architecture-index.md` §7.6), but it does not block Module 04 implementation.
3. **Catalog reclassification propagation (new) — RESOLVED, accepted trade-off, no event added in Slice 1.** See §3.10.6. Revisit as a Slice 2 candidate only if real-world reclassification-after-listing incidents are observed; not built speculatively.
4. **Reservation TTL value — RESOLVED: 15 minutes default,** config key `inventory.reservationTtlMinutes` via `IConfigPort` (§3.10.7, §8). Chosen as a reasonable, industry-typical cart/hold window for an MVP; trivially adjustable post-launch via config with no code change or migration — the number itself is not architecturally load-bearing, only the fact that it's config-driven (NFR-MAINT-03) is.
5. **Is batch data mandatory at listing creation? — RESOLVED: yes, mandatory for every listing in Slice 1**, regardless of product type (§5.3). Rationale: (a) the existing `stock_batches.expiryDate` column is non-nullable — making batch data optional would require a schema migration, which §6.4 established is *not* needed for this slice, so keeping it mandatory avoids introducing one; (b) "a listing that exists with literally undefined stock" is a worse default than requiring pharmacies to state an initial quantity+expiry, even a conservative or far-future one for genuinely non-perishable health products. If real pharmacy onboarding friction from this is observed for non-perishables, revisit via a schema change (nullable `expiryDate`) in Slice 2 — not a Slice 1 concern.
6. **Internal service-to-service authorization for reserve/confirm/release (new) — RESOLVED: no HTTP surface, no internal-auth scheme.** These operations are exposed exclusively as `IInventoryPort` methods, consumed by other modules in-process via Nest DI (§10.3, §11). This sidesteps the internal-service-auth gap entirely for this slice (there is nothing to authenticate — it's a same-process function call) and defers the real question ("how do extracted services authenticate to each other") to whenever Module 04 is actually extracted from the monolith, which is not now. No ADR is needed for this — it is a direct, mechanical application of the already-accepted `00-shared-conventions.md` §2 "ports, not foreign tables" rule to commands as well as queries.
7. **Does `StockReservation.status` need an explicit `DISPATCHED` value? — RESOLVED: no, not in Slice 1.** A read query (`IInventoryPort.getReservationFulfillment`) joins the reservation to its `DISPATCH` movement(s) instead of widening the enum (§8, §14.7 note in §8). Revisit if that join is a measured performance problem at scale, not preemptively.
8. **Controlled substances online — RESOLVED as non-blocking for Module 04.** Whatever schedules Product/Compliance ultimately designate `PROHIBITED` at the Module 03 (Catalog) level, Module 04's enforcement (§5.3: `onlineSaleProhibited = true` → `422 CONTROLLED_PROHIBITED` at listing-create time) is schedule-agnostic and requires no Module 04 change once that policy is set. The substantive compliance question remains open at the **Module 03/05** level (`00-architecture-index.md` §7.2), not here.
9. **Pricing model — RESOLVED as non-blocking for Module 04.** `InventoryListing.price` is a plain positive integer today with no ceiling logic (§3.4, §5.3). If Product/Compliance later mandates reference-price ceilings for essential medicines, that is an additive validation step in `CreateListingCommand`/`UpdateListingCommand` (reading a config-driven reference price table) — no domain model or schema change required. The pricing-**policy** question itself remains open at the product level, not architecturally blocking.

**ADR impact:** none required. All resolutions either (a) apply an already-accepted principle (ADR-001 single deployable, ADR-002 ports-not-relations) to a case Modules 02/03 hadn't yet needed, or (b) are local, config-driven business-rule choices scoped to this module. The one item worth a lightweight follow-up, not an ADR: promoting the "ports, not just for reads" pattern (#6) and the "client orchestrates two module calls at registration" pattern (#1) into `00-shared-conventions.md` once a second module actually reuses either — flagged for the architect's discretion, not a blocker.

---

## 15. Security & Privacy Requirements

- **RBAC enforcement** exactly as §7 — every mutating endpoint permission-guarded; org-scope validated in the application layer by comparing the resolved `Pharmacy.organizationId`/`Branch.pharmacyId` chain against the caller's `user_roles.organizationId`, never trusted from a client-supplied `pharmacyId`/`branchId` path param alone.
- **No health/PII data owned by this module** — Pharmacy & Inventory is commercial metadata (price, stock, license status), not clinical. The stricter envelope-encryption requirements (ADR-009) do not apply to any Module 04 field.
- **Least-disclosure on `/availability`** — the public endpoint returns only commercial fields needed for comparison (price, distance, sellable qty, storage requirement); it must **never** leak `pharmacyId`'s internal license/compliance state, staff identities, or raw batch/supplier data.
- **Tamper-evidence** — `stock_movements` is append-only (no update/delete path exposed at any layer, including admin) exactly like `AuditLog`; this is itself a security control against fraudulent stock manipulation, not just an audit nicety.
- **Idempotency** on `IInventoryPort.reserve()` (caller-supplied `idempotencyKey`, §5.4) prevents duplicate reservations from saga retries — required per `00-shared-conventions.md` §7's "idempotency keys on payment/webhook/booking mutations," which the parent doc's own §11.3 sequence flow does not spell out explicitly but the shared conventions doc mandates. This applies equally whether the call arrives in-process (Slice 1, per §14.6) or, post-extraction, over the wire — the idempotency check lives in the application command, not in a transport-layer concern, so it survives that future change unmodified.
- **Rate limiting** on the public `/availability/product/:id` route (unauthenticated, therefore likely to be probed/scraped) — no rate-limiting middleware currently exists in the codebase per the explored shared kit; flagged as a gap to raise with whoever owns Module 14/API-gateway concerns, not assumed solved by this module alone.

---

## 16. Dependencies

- **Hard dependency: Module 01 (Identity)** — `Organization`, `VerificationRequest`, RBAC guards/permissions, audit log, error envelope. Consumed via `IIdentityPort` (reads) and the client-orchestrated two-call registration pattern (§14.1).
- **Hard dependency: Module 03 (Catalog), Slice 1** — `Product` read via `ICatalogPort`. Module 04 cannot exist meaningfully before Module 03 Slice 1 is built (matches the roadmap's declared Phase 1 order, `03 → 04`).
- **Shared kit dependencies (Phase 0, already built):** `PrismaService`, `AuditService`, `OutboxService`, `EVENT_BUS`/`EventBusService`, `AllExceptionsFilter`/`ErrorCode`, `AppConfigService`/`IConfigPort`, `PermissionsGuard`/`@RequirePermissions`/`@Public()`.
- **No dependency on Module 02 (Profiles)** — Pharmacy & Inventory does not read `CustomerProfile`/`Address`/beneficiary data (consistent with Module 03's own "no dependency on Module 02" note).
- **Forward dependents (not yet built, do not block Slice 1):** Module 05 (Prescription/Matching) will read availability; Module 06 (Orders) will inject `IInventoryPort` to call reserve/confirm/release/dispatch (§14.6); Module 14 (Search) will project `ListingCreated`/`PriceChanged`/stock events.
- **New shared/platform dependency — RESOLVED, `@nestjs/schedule`.** No cron/scheduling library exists anywhere in the codebase today (confirmed by searching the shared kit and `package.json` during this review — Modules 01–03 have no scheduled jobs). `LicenseExpirySweeper`/`ReservationTtlSweeper` (§4, §8) are Module 04's first need for one. **Decision:** adopt `@nestjs/schedule` (the standard, first-party NestJS scheduling module) as a new dependency, added when Module 04 is implemented — pin to a release at least 7 days old per the project's dependency-vetting convention. This is now the platform's standing choice; later modules with similar needs (e.g. a Module 09/10 eligibility sweeper, Module 13 digest sender) should reuse it rather than adding a second scheduler.

---

## 17. Testing Strategy

Per `00-implementation-roadmap.md` §5, mirroring the layered test pyramid already used by Modules 01–03 (unit → application/use-case → integration → e2e → contract → security), highest coverage at the domain-unit layer.

### 17.1 Domain unit tests (no DB)
- `TransactingEligibilityPolicy`: eligible/ineligible matrix (active+valid+unexpired = true; each single failing condition = false; boundary at `licenseExpiresAt === now`).
- `SellableStockCalculator`: zero batches → 0; all-expired batches → 0; mixed batches → sum of non-expired only; `reserved > onHand` edge case floors at 0, never negative.
- `FefoAllocator`: picks earliest-expiry batches first; throws/returns insufficient when `Σquantity < requested`; stable ordering when two batches share an expiry date.
- Value objects: `Money` (rejects negative/float minor units), `Quantity` (rejects negative), `ExpiryDate.isExpired`, `OperatingHours` (`openTime < closeTime` validation).

### 17.2 Application/use-case tests (repositories/ports mocked)
- `CreateListingCommand`: happy path emits `ListingCreated`+`StockReceived`; rejects on ineligible pharmacy, missing/inactive/prohibited catalog product, duplicate `(branch, product)`.
- `ReserveStockCommand`: happy path; insufficient stock path; ineligible-pharmacy re-check path; idempotency-key replay returns original reservation without a second DB write (assert repository `create` called exactly once across two invocations with the same key).
- `ReleaseReservationCommand`: idempotent double-release returns `200`/no-op, doesn't double-credit `sellable`.
- `LicenseExpirySweeper`/`ReservationTtlSweeper` orchestration: correct rows selected, correct commands invoked, `PharmacySuspended`/`StockReleased` emitted once per affected row.

### 17.3 Integration tests (repositories against a real Postgres — Testcontainers or ephemeral DB, per roadmap §5)
- Unique constraint `(branchId, catalogProductId)` actually rejects a duplicate insert at the DB level (defense in depth beyond the application check).
- `on_hand`/`reserved`/`sellable` recomputation matches `Σ(stock_movements.quantityDelta)` after a sequence of receipt→reserve→confirm→dispatch operations (the invariant-4 reconciliation test called out in §3.10.4).
- Concurrent reserve attempts on the last unit of stock: two parallel transactions, assert exactly one succeeds and the other gets `INSUFFICIENT_STOCK` (proves the `FOR UPDATE` lock actually serializes, not just "usually works").
- TTL sweeper with `SKIP LOCKED`: a reservation currently being confirmed by another transaction is not double-processed by a concurrently running sweeper pass.

### 17.4 Contract tests
- Every event in §9 validated against its `00-domain-event-catalog.md` schema (once that catalog is updated for Module 04's finalized payload shapes).

### 17.5 Security tests
- RBAC: each mutating endpoint rejects a caller without `inventory:manage:org`/`pharmacy:manage:org` for that specific organization (cross-tenant isolation — a `PHARMACY_MANAGER` at pharmacy A cannot manage pharmacy B's listings even with a valid, correctly-scoped-elsewhere token).
- Public `/availability` route never returns license/compliance/staff fields (response-shape allowlist test, same pattern Module 03 uses for its public product-read DTO).
- Audit-chain integrity: hash-chain verification test reused/extended from Module 01's pattern, confirming Module 04's audit writes don't break the global chain (since `audit_logs` is shared across all modules).

---

## 18. E2E Strategy

Following the existing `backend/test/<module>/*.e2e-spec.ts` convention (see `backend/test/catalog/`, `backend/test/profiles/`), a `backend/test/pharmacy-inventory/` directory is proposed with:

| File (proposed) | Scenarios |
| --- | --- |
| `registration-eligibility.e2e-spec.ts` | Register pharmacy → `PENDING`; activate → `ACTIVE`; listing creation blocked while `PENDING`/`SUSPENDED`; license-expiry sweeper (time-travel via test clock or directly seeded past-due `licenseExpiresAt`) flips to `SUSPENDED` and hides listings from `/availability`. |
| `listing-lifecycle.e2e-spec.ts` | Create listing with initial batch → appears in availability; add batch → sellable increases; adjust batch with/without reason (reason required, `422` otherwise); disable listing → disappears from availability but remains in `GET /inventory/listings`; soft-delete → excluded everywhere. |
| `reservation-concurrency.e2e-spec.ts` | Full reserve → confirm → dispatch happy path with ledger assertions, driven through the real Nest app's `IInventoryPort` (injected in the test module, per §14.6 — not HTTP, since these are in-process port methods) alongside the public `GET /availability/product/:id` HTTP call to verify the listing correctly appears/disappears; reserve → release; reserve → TTL expiry (short TTL configured for test) auto-releases; **concurrent reserve race** (parallel `IInventoryPort.reserve()` invocations for the last unit) — same assertion as §17.3's integration test but through the real DI/app-bootstrap stack end-to-end; idempotency-key replay. |
| `access-control.e2e-spec.ts` | Cross-tenant isolation (pharmacy A staff cannot touch pharmacy B's branches/listings); unauthenticated calls to guarded routes get `401`; `@Public()` availability route works with no token; missing-permission role gets `403 RBAC_FORBIDDEN`. |
| `atomicity.e2e-spec.ts` | Mirrors Module 02/03's `atomicity.e2e-spec.ts` pattern — force a mid-transaction failure (e.g., outbox write forced to throw) and assert **no partial state**: listing/batch/movement/cache-column changes all roll back together, no orphaned audit or outbox row. |
| `dedup-catalog-integration.e2e-spec.ts` | Real (not mocked) call through `ICatalogPort`/`IIdentityPort` adapters against seeded Module 01/03 data — confirms the cross-module read wiring actually works end-to-end, not just against test doubles (catches drift if Module 03's `Product` shape changes). |

**Definition of done for this slice's testing** (mirrors §0.3 and the roadmap's DoD gate): all of §17.1–17.5 and this table's scenarios pass; the reconciliation invariant (ledger sum = cached balance) is asserted after every mutating e2e scenario, not just once; no test weakens or skips an assertion to pass (`00-implementation-roadmap.md` §5 "Do not weaken or delete tests to make a build pass; fix the root cause").

---

## 19. Traceability Summary

| Business/Functional ID | Section(s) covering it |
| --- | --- |
| BR-PH-01..04, 06, 07, 12, 13, 14 | §1, §3, §4, §8 |
| BR-PH-05, 08 (zones), 09, 10, 11 | §0.2 (deferred) |
| FR-PH / F-PH-01..06 | §3.1–3.3, §10.1 |
| F-INV-01..04, 07, 08 | §3.4–3.7, §5.3, §8, §10.2 |
| F-INV-05, 06, 09 | §0.2 (deferred) |
| F-AVL-01, 03 | §10.3 |
| F-AVL-02 | Deferred to Module 05/14 composition, per parent doc's own note that "Search/Matching composes these" — Slice 1 only exposes the raw per-pharmacy data |
| BRULE-05, 08 | §4, §3.10.1 |
| BRULE-10, 30 | §3.10.5, §3.10.6 |
| BRULE-15 | §3.10.2, §17.1 |
| BRULE-19 | Noted in §4 ("in-flight orders follow re-match rules") — actual re-match logic belongs to Module 05/06, out of Module 04's scope entirely |
| NFR-PERF-05 | §8 (lock strategy), §6.2 (index), §15 (rate limiting gap) |
| NFR-COMP-01/05 | §4, §3.5–3.7 (batch/ledger traceability) |
| NFR-AUDIT | §13 |

---

**End of Module 04 — Slice 1 specification.** Status: **APPROVED — architect review complete** (§14). This remains a review/design document only; no `backend/src`, `backend/prisma`, or `backend/test` files were created or modified while preparing or finalizing it — the migrations proposed in §6.2/§6.3, the RBAC entries proposed in §7.2, and the `@nestjs/schedule` dependency decided in §16 are all still pending application in an actual implementation PR. With all 9 architectural open questions now resolved, this document is ready to hand to implementation with no remaining design ambiguity; the only questions left open (§14.2, §14.8, §14.9) are Product/Compliance policy calls that do not block writing code, since the architecture already accommodates either answer without a redesign. Recommended next step: implementation PR for Module 04 — Slice 1, following §11's folder layout.
