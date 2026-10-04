# PharmaLink Ethiopia — Shared Conventions

**Purpose:** Cross-cutting patterns, contracts, and conventions that **every module reuses**. Extracted from the 16 module designs so they are defined once and referenced everywhere (DRY at the architecture level). Where a module doc says "per Module 1 §14" or "reuse the ledger pattern", the authoritative definition lives here.

**Applies to:** all modules. **Architecture style:** Modular Monolith (NestJS) · Clean Architecture · DDD · SOLID.

---

## 1. API & Response Envelope

**Base path:** `/api/v1/<module>`. All timestamps **ISO-8601 UTC**. All list endpoints paginate (`page`, `size`, returns `meta.page`).

**Success envelope**
```
{ "success": true, "data": { ... }, "meta": { "requestId": "...", "timestamp": "..." } }
```

**Error envelope**
```
{ "success": false,
  "error": { "code": "AUTH_INVALID_CREDENTIALS", "message": "Human-readable.", "details": [ ... ]? },
  "meta": { "requestId": "...", "timestamp": "..." } }
```

**Principles**
- Stable, screaming-snake `code` per error (module-prefixed where useful, e.g., `CATALOG_DUPLICATE_PRODUCT`).
- `message` is safe for display; `details` carries field-level validation errors.
- A `DomainExceptionFilter` maps domain exceptions → envelope; controllers never format errors ad hoc.
- **Privacy denials return generic `403`** without leaking resource existence (health/records/prescriptions).
- Every response carries `requestId` (correlation id) propagated through logs and audit.

---

## 2. Authentication & Authorization (RBAC)

**Authoritative source:** Module 01 (Identity).

- **AuthN:** short-lived access JWT + rotating refresh token (device-bound). Stateless API tier; permission sets cached in Redis.
- **AuthZ model:** RBAC with fine-grained permissions `resource:action[:scope]`.
  - `scope ∈ { own, org, any }` — row-level ownership, tenant isolation, or platform-wide.
  - Effective permissions = union of the user's roles' permissions, filtered by scope.
- **Guard:** a single `PermissionsGuard` reads `@RequirePermissions(...)` on each endpoint and checks the cached effective set. Scope (`own`/`org`) validated in the application layer against resource ownership/tenant.
- **Org scoping:** `user_roles.organizationId` supports one-user-many-memberships (staff at a pharmacy/hospital/lab tenant).
- **Step-up/MFA:** required for sensitive actions (NFR-SEC-06); admin sensitive ops may add **maker-checker** (two-person) — see §9.

**Permission naming convention (extend per module):**
`prescription:verify`, `order:read:own`, `order:fulfill:org`, `catalog:manage:org`, `inventory:manage:org`, `provider:verify:any`, `finance:refund:any`, `review:moderate:any`, `config:manage:global`, `audit:read:any`.

**Cross-context access:** modules call each other only through **ports** (`I<Module>Port`), never foreign tables. This preserves bounded-context isolation and future service extraction.

**Genuinely public (unauthenticated) routes:** `JwtAuthGuard` and `PermissionsGuard` are registered globally (`APP_GUARD`, Module 01's `IdentityModule`), so every route is protected by default. A route that must be reachable with no token at all (e.g. public catalog/provider/search browsing) is annotated with a bare `@Public()` (`modules/identity/interface/decorators/public.decorator.ts`) and **nothing else** — no `@RequirePermissions()` call is added, since `PermissionsGuard` already no-ops when that metadata is absent. This is the exact pattern already used by Module 01's own `login`/`register`/`refresh` handlers and confirmed for Module 03 (Catalog, `backend/docs/03-catalog-spec.md` §14.1/§7.2). Do not invent a second guard, an "auth optional" middleware, or an empty permission allow-list to express this — `@Public()` alone is the convention. Note the trade-off: `@Public()` short-circuits `JwtAuthGuard` entirely, so `request.user` is never populated on these routes even if a bearer token is present — this is unauthenticated-only, not optional-auth-with-context. A future variant that needs "personalize if logged in, but don't require it" is a distinct pattern not yet needed by any module and would require its own design.

---

## 3. Health-Data Access Policy

**Authoritative source:** Module 02 (`BeneficiaryAccessPolicy`), extended by Module 12 (`RecordAccessPolicy` + consent).

- Access to a beneficiary's health data allowed for: the **owner**, an **authorized beneficiary/guardian** (BRULE-03/04), or a **verified provider with active, time-boxed consent** (BRULE-39).
- **Every** health-data access (prescriptions, results, records, consult sessions) is checked by the policy **and logged** (allow *and* deny) — FR-REC-06, BRULE-37.
- Consumed by: 05 (prescriptions), 10 (appointments on behalf), 11 (results), 12 (records/consults).

---

## 4. Audit Logging (hash-chained, tamper-evident)

**Authoritative source:** Module 01 (`audit_logs`).

- **Append-only** `audit_logs`; each row: `actor, action, resource_type, resource_id, context(jsonb), ip, timestamp, prev_hash, hash`.
- **Hash-chaining:** `hash = H(row_fields + prev_hash)` → tamper-evident chain; exported to write-once storage; retained per regulatory policy (BRULE-41).
- **`AuditInterceptor`** applied at the interface layer records qualifying actions uniformly; Admin (16) has a **read-only** explorer (its reads are themselves audited).
- **Must-audit (baseline):** authN events, privileged/admin actions, verification decisions, money movements, health-data access, classification/eligibility changes, moderation, config changes.
- **Never log:** secrets, card data/tokens, raw OTPs, clinical content/media, plaintext health text — only non-sensitive identifiers/variables.

**Module-specific immutable ledgers that double as audit trails:** `stock_movements` (04), `ledger_entries` (07), `dispense_records` (05), `driver_earnings` (08), `record_access_log` (12), `*_status_history` (06/08/10/11/15).

---

## 5. Ledger + Derived Balance Pattern

Used wherever quantities/money must be conserved and auditable: **07 money**, **04 stock**, **05 dispensing**, **08 earnings**.

- **Append-only ledger** is the source of truth; **balances are derived** (materialized/cached, rebuildable), never authoritative mutable counters.
- **07 double-entry:** every transaction balances (Σ debits = Σ credits); a posting that doesn't balance is rejected (`LEDGER_UNBALANCED`). Chart of accounts: wallet, provider-payable, platform-revenue, gateway-clearing, refunds, COD, FX.
- **04/05/08 single-entry ledgers:** each movement is signed and references its cause (order/import/system); balances (`on_hand`/`reserved`/`sellable`, `remaining_dispensable`) recomputed transactionally.
- **Rationale:** correctness under concurrency, full reconstruction for disputes/compliance, no silent edits.

---

## 6. Reservation / Hold + TTL Pattern

Used for scarce resources: **04 stock**, **10 appointment slots** (and **11 diagnostics** capacity).

- **Atomic acquire:** conditional update (`... WHERE status='OPEN'` / `sellable ≥ qty` under row lock) — the DB guarantees a single winner (no oversell/double-book). 0 rows → `INSUFFICIENT_STOCK` / `SLOT_UNAVAILABLE`.
- **Hold has a TTL:** if the downstream step (payment) doesn't complete in the window, a **scheduled sweeper** releases the hold → resource bookable again (prevents lockup by abandoned carts/bookings).
- **Lifecycle:** `HELD → CONFIRMED` (on payment/success) or `HELD → RELEASED/EXPIRED`.
- **FEFO** (first-expiry-first-out) batch consumption on dispatch (04) to honor expiry rules (BRULE-15).

---

## 7. Saga Orchestration + Compensation

**Authoritative source:** Module 06 (`CheckoutSaga`); reused by 10/11 booking flows.

- Multi-module transactions (Rx gate → match → reserve → pay → confirm) run as an **orchestrated saga**: one coordinator, ordered steps, each with a **compensating action** (release reservation, refund).
- **Idempotency:** clients send `Idempotency-Key`; replays return the original result (no duplicate orders/charges).
- **Reliability:** state changes + events written in one DB transaction (outbox, §8); a coordinator resumes/compensates incomplete sagas after crashes.
- **Rationale:** orchestration (vs choreography) is clearer and more auditable for money+stock+prescription flows with strict ordering.

---

## 8. Domain Events & Outbox Pattern

See `00-domain-event-catalog.md` for the full event list.

- Modules communicate across contexts via **domain events** (and query ports for reads).
- **Outbox pattern:** events are written to an `outbox` table in the **same transaction** as the state change, then relayed by a publisher → reliable, crash-safe, exactly-once-ish delivery with idempotent consumers.
- **Consumers are idempotent** (dedup by event id) — safe under retries/duplicates/out-of-order.
- **CQRS read-side (14 Search):** projectors consume events to maintain query-optimized read-models; rebuildable via full reindex.
- Established in 06/07; adopted by 03/04/09/10 for search projection and 14/15 signals.

---

## 9. Sensitive-Action Controls (Admin)

**Authoritative source:** Module 16.

- **Least privilege + separation of duties** (NFR-SEC-06): fine-grained admin permissions; elevated roles for sensitive ops.
- **Maker-checker:** high-impact actions (high-value refunds, role elevation, certain config) require a second elevated approver (`maker_checker_approvals`). `MAKER_CHECKER_PENDING` until decided.
- **Admin never mutates foreign data directly** — invokes owning-module commands/ports so domain invariants + audit hold.
- **Impersonation** (if enabled) is strictly gated + heavily audited.

---

## 10. Configuration & Feature Flags

**Authoritative source:** Module 16 (`platform_configs`, `feature_flags`), read via `IConfigPort` (cached, short TTL).

- **Config-driven tunables** replace hard-coded business parameters (NFR-MAINT-03). Namespaced: `payment.platformFeePercent`, `orders.reservationTtlMinutes`, `delivery.maxConcurrentJobs`, `notifications.quietHours`, `appointments.cancellationWindow`.
- **Feature flags** toggle capabilities (COD, split fulfillment, telemedicine, new payment provider); support %/region/role targeting later.
- Changes are **versioned, validated, audited, rollback-able**; a `ConfigChanged` event invalidates caches.

---

## 11. Data & Persistence Conventions

- **DB:** PostgreSQL via **Prisma**. **PKs:** UUID v7 (time-ordered). Standard columns: `created_at`, `updated_at`; `deleted_at` for soft-delete where lifecycle applies.
- **Money:** integer **minor units** + `currency` (ETB); never floats. Cross-border captures original currency + `FxRate` (rate + source + timestamp), settles in ETB (BRULE-22). **Product pricing is split across two owners** (ADR-015): `Product.price` (03 Catalog) is the platform *reference* price — nullable, where `null` means not priced and therefore not purchasable; `InventoryListing.price` (04 Inventory) is the per-pharmacy *selling* price. They are different concepts and are never used interchangeably.
- **Encryption:** TLS 1.2+ in transit; AES-256 at rest. **Field-level encryption** for health-sensitive fields; **envelope encryption (KMS data keys)** for health artifacts (prescriptions, results, records, consult files). DB stores only storage refs + key refs, never plaintext or card data.
- **Geo:** Ethiopian structured address (region/city/subcity/woreda) + GPS; **ET geofence** for diaspora delivery (BRULE-21); PostGIS/geohash for nearest-first.
- **Snapshots:** operational modules copy immutable snapshots (beneficiary, address, price, product, pharmacy) at transaction time so history stays accurate after source edits/deletes.
- **Retention:** per-artifact retention + legal hold; deletion honors retention (tombstone where hard-delete not permitted) — BRULE-40/41.
- **Partitioning at scale:** time/tenant partitioning for high-volume tables (audit, movements, ledger, orders, slots, notifications).

---

## 12. Eligibility Policy (providers/pharmacies)

**Authoritative sources:** Module 04 (`TransactingEligibilityPolicy`), Module 09 (`ProviderEligibilityPolicy`) — same shape.

- **Eligible iff:** org `ACTIVE` + verification `APPROVED` + license `VALID` (not expired) + not manually `SUSPENDED`.
- Consulted by listing/service publishing, availability/discovery, order/booking acceptance, and search indexing (ineligible entities excluded).
- A shared **license-expiry sweeper** auto-suspends expired entities and hides their offerings (BRULE-08), emitting `*Suspended` events.

---

## 13. NestJS Module Layout (Clean Architecture)

Every module follows:
```
src/modules/<module>/
  domain/          # entities, value-objects, events, enums, repository interfaces, domain services (pure)
  application/     # commands, queries, sagas, ports (interfaces), dtos, mappers
  infrastructure/  # prisma repositories, port adapters, cache, scheduling, external providers
  interface/       # http controllers + guards/decorators/filters/interceptors, ws gateways, event handlers
  <module>.module.ts   # DI composition root wiring ports → adapters
```
- **Dependency rule:** domain ← application ← infrastructure/interface. Domain is framework-free and unit-testable.
- **Ports & adapters** everywhere for cross-module and external dependencies (Dependency Inversion) → clean future extraction to microservices.

---

## 14. Realtime Conventions

- **Tracking (08)** and **telemedicine (12)** use **WebSocket gateways** scaled horizontally via a **Redis pub/sub adapter** (no sticky sessions).
- Ephemeral high-frequency data (driver location) lives in **Redis** (last-known + TTL), not Postgres; only sampled snapshots persisted for audit.
- Telemedicine media via managed **SFU** behind `IRealtimeMediaPort`; short-lived per-participant tokens; media not persisted by default.
- Graceful degradation on poor connectivity (chat-only fallback, buffered/idempotent updates) — NFR-LOC-04.

---

## 15. Localization & Notifications

- All user-facing text supports **Amharic + English**; `preferredLanguage` on the user; localized templates/OTP/email.
- **All outbound comms go through Module 13** (`INotificationPort`) — no module calls FCM/SMS directly. Preferences, opt-out (BRULE-43), critical-bypass (BRULE-44), and health-privacy content policy (BRULE-37) are enforced centrally.

---

## 16. Standard Error Codes (baseline)

Cross-cutting codes reused across modules (modules add their own):
`VALIDATION_ERROR`, `RBAC_FORBIDDEN`, `UNAUTHENTICATED`, `NOT_FOUND`, `IDEMPOTENT_REPLAY`, `INVALID_STATE_TRANSITION`, `RATE_LIMITED`, `CONFIG_VALIDATION_FAILED`, `MAKER_CHECKER_PENDING`, `PROVIDER_NOT_ELIGIBLE`/`LICENSE_EXPIRED`/`*_SUSPENDED`, `BENEFICIARY_ACCESS_DENIED`.

---

*End of shared conventions. When a module doc references a shared pattern, this document is the authoritative definition.*
