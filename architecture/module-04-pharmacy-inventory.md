# Module 4 — Pharmacy & Inventory (Design Document)

**Product:** PharmaLink Ethiopia — Digital Healthcare Marketplace
**Module:** 04 — Pharmacy & Inventory (Pharmacy onboarding, staff, per-pharmacy listings, stock/batch/expiry, transacting eligibility)
**Status:** Design — Approved for implementation reference
**Architecture style:** Modular Monolith (NestJS) · Clean Architecture · DDD · SOLID
**Depends on:** Module 01 (Identity/RBAC + org verification), Module 03 (Catalog product master). Consumed by: Cart/Order, Prescription, Search/Matching, Payment/Settlement, Delivery.
**Traceability:** FR-PRV-01..12, FR-MED-05, FR-MED-08, FR-MATCH-01/05, BRULE-05, BRULE-08, BRULE-15, BRULE-16, BRULE-30, NFR-PERF-05, NFR-COMP-01/05, NFR-AUDIT

> Single source of truth for the Pharmacy & Inventory bounded context. No implementation code — contracts, schemas, flows, and reasoning only.

---

## 1. Module Objectives

This module turns a **verified pharmacy business** into a transacting marketplace seller. It owns two tightly related concerns:

1. **Pharmacy (the tenant/seller)** — the pharmacy organization profile, branches, operating hours, service zones, staff, and — crucially — its **license-based eligibility to transact** (BRULE-05/08).
2. **Inventory (per-pharmacy listings)** — which Catalog products a pharmacy sells, at what **price, quantity, batch, and expiry**, and real-time stock availability (FR-MED-05, FR-PRV-05/06).

**Boundary recap (from Module 3).** Catalog owns the *canonical product definition* (identity, Rx/OTC, controlled flag — immutable by pharmacies) **plus the platform reference price** (`Product.price`). Inventory owns the *commercial listing* that **references** a catalog product. A listing can never redefine a product's clinical classification; it only sets its own selling price/stock/batch. This is what enables cross-pharmacy comparison and safe matching.

**Two prices, two owners — do not conflate them** (`architecture/module-03-catalog.md` §1, ADR-015):
- `Product.price` (**Catalog**, Module 03) — the platform **reference** price for the canonical product, pharmacy-independent, nullable (`null` = not priced, therefore not purchasable). Module 06's checkout reprices order lines from this value.
- `InventoryListing.price` (**this module**) — what **one pharmacy branch charges** for its own listing. Pharmacy-set, per-listing, audited here (§13's price-change entry with old→new). It is never written by Catalog, and it never writes back to `Product.price`.

A listing's selling price is free to differ from the catalog reference price; Slice 1 imposes no ceiling or parity rule between them (see §16's open pricing-model question).

**Primary objectives**
- Onboard pharmacies with license/credential verification (delegated to Module 1's verification workflow) and activate transacting only after approval (FR-PRV-02/03/04, BRULE-05).
- **Automatically suspend** pharmacies whose license expires (BRULE-08, FR-PRV-09).
- Let pharmacies manage **listings, prices, stock, batches, expiry**, with **bulk import** (FR-PRV-05/06).
- Provide **authoritative, real-time availability** for search & matching (FR-MED-05, FR-MATCH-01/05).
- Enforce **no expired stock is sellable** (BRULE-15) and flag **temperature-sensitive** items for delivery (BRULE-30).
- Provide **pharmacy dashboards** (orders, revenue, stock health) and org-scoped staff operations (FR-PRV-08).

---

## 2. Business Requirements

| ID | Business Requirement | Source |
| --- | --- | --- |
| BR-PH-01 | Pharmacies shall register and be verified before transacting. | FR-PRV-01..04, BRULE-05 |
| BR-PH-02 | Only pharmacies with valid, unexpired licenses may list and sell medicines. | BRULE-05, NFR-COMP-01 |
| BR-PH-03 | A pharmacy whose license expires is automatically suspended until renewed. | BRULE-08, FR-PRV-09 |
| BR-PH-04 | Pharmacies shall manage product catalog listings and stock. | FR-PRV-05 |
| BR-PH-05 | Pharmacies shall support bulk import/update of inventory. | FR-PRV-06 |
| BR-PH-06 | The system shall show real-time stock availability per pharmacy. | FR-MED-05 |
| BR-PH-07 | Only medicines with valid, non-expired stock may be offered for sale. | BRULE-15 |
| BR-PH-08 | Pharmacies shall set operating hours and service zones. | FR-PRV-10 |
| BR-PH-09 | Pharmacy dashboards shall show orders, bookings, and revenue. | FR-PRV-08 |
| BR-PH-10 | Pharmacies shall manage staff with org-scoped roles. | FR-ADM-09, Module 1 roles |
| BR-PH-11 | Provider compliance and performance metrics shall be recorded. | FR-PRV-12 |
| BR-PH-12 | Listings shall reference the canonical Catalog product; classification cannot be overridden. | Module 3 boundary, BRULE-10 |
| BR-PH-13 | Temperature-sensitive medicines shall be flagged for special handling. | BRULE-30 |
| BR-PH-14 | Stock shall be reserved on order and decremented on fulfillment; released on cancel. | FR-ORD-04, BRULE-19 |

---

## 3. Functional Requirements (Module Features)

### 3.1 Pharmacy Onboarding & Profile
- **F-PH-01** Register a pharmacy (owner initiates; org created in `PENDING_APPROVAL`).
- **F-PH-02** Upload license/credentials → routed to admin verification (Module 1 `verification_requests`).
- **F-PH-03** Activate pharmacy on approval; block transacting otherwise (BRULE-05).
- **F-PH-04** Manage pharmacy profile: name, logo, contact, description, photos.
- **F-PH-05** Manage **branches** (a pharmacy may have multiple physical locations, each with own address/GPS/hours/stock).
- **F-PH-06** Set operating hours per branch (FR-PRV-10) → drives "open now" and availability.
- **F-PH-07** Define **service zones** (delivery radius / geofenced areas) per branch (FR-PRV-10).

### 3.2 Staff Management (org-scoped)
- **F-PH-08** Invite staff (manager, pharmacist, cashier, inventory) — consumes Module 1 invite flow.
- **F-PH-09** Assign/revoke org-scoped roles; owner/manager restricted per RBAC.
- **F-PH-10** View staff activity relevant to pharmacy ops.

### 3.3 Inventory / Listings
- **F-INV-01** Create a **listing**: reference a Catalog product + branch + price + quantity.
- **F-INV-02** Manage **batches**: batch number, quantity, expiry date, (optional) sourcing/supplier.
- **F-INV-03** Update price and stock; enable/disable a listing.
- **F-INV-04** Auto-exclude listings with **zero sellable stock** or **all batches expired** (BRULE-15).
- **F-INV-05** Low-stock and near-expiry alerts to inventory staff.
- **F-INV-06** **Bulk import/update** listings via CSV with validation + dry-run (FR-PRV-06).
- **F-INV-07** Flag cold-chain/temperature-sensitive at listing (inherits Catalog `storage_requirement`; BRULE-30).
- **F-INV-08** Stock reservation: reserve on order placement, decrement on dispatch/fulfill, release on cancel/timeout (BR-PH-14).
- **F-INV-09** Propose new catalog products (delegates to Module 3 proposal flow) when a needed product isn't in the master.

### 3.4 Availability & Matching Support
- **F-AVL-01** Expose **real-time availability** query per product across pharmacies (FR-MED-05).
- **F-AVL-02** Provide inputs to matching: in-stock pharmacies, price, branch location, operating status, rating (FR-MATCH-01/05) — Search/Matching composes these.
- **F-AVL-03** Exclude expired-license / suspended pharmacies from availability (BRULE-08, FR-MATCH-05).

### 3.5 Dashboards & Metrics
- **F-DSH-01** Pharmacy dashboard: incoming orders, revenue, top products, stock health (FR-PRV-08).
- **F-DSH-02** Compliance/performance metrics: acceptance rate, fulfillment time, cancellation rate (FR-PRV-12).

---

## 4. Non-Functional Requirements

| Attribute | Requirement | Design Response |
| --- | --- | --- |
| **Consistency/Correctness** | Stock must not oversell; reservations atomic (BR-PH-14) | Reservation via transactional row-level locking; `available = on_hand − reserved`. |
| **Compliance** | License-gated selling, no expired stock (BRULE-05/08/15) | `TransactingEligibilityPolicy` domain service; scheduled license-expiry job; expiry-aware sellable-stock computation. |
| **Performance** | Real-time availability at scale (NFR-PERF-05, 10k concurrent) | Redis-cached availability snapshots keyed by (productId, geo cell); event-driven cache invalidation on stock change. |
| **Scalability** | Millions of listings (NFR-SCAL) | Partition `inventory_listings`/`stock_batches` by pharmacy; read replicas; cache hot products. |
| **Auditability** | Stock/price/eligibility changes traced (NFR-AUDIT) | Reuse hash-chained audit; immutable `stock_movements` ledger. |
| **Traceability** | Batch/sourcing where feasible (NFR-COMP-05) | `stock_batches` carry batch#, expiry, supplier; movements reference batch. |
| **Maintainability** | Config-driven fees/zones/limits (NFR-MAINT-03) | Service-zone rules and low-stock thresholds configurable. |

---

## 5. Domain Model

### 5.1 Aggregates & Entities
- **Pharmacy** (aggregate root; maps to a Module 1 `organization` of type PHARMACY) — profile + transacting status.
- **Branch** (entity within Pharmacy) — physical location: address, GPS, hours, service zone, its own stock.
- **InventoryListing** (aggregate root) — a sellable offer: (branch + catalog product) → price + stock summary.
- **StockBatch** (entity within a listing) — quantity + expiry + batch/supplier metadata.
- **StockMovement** (immutable ledger entry) — every stock change (receipt, reserve, release, dispatch, adjust, expire).
- **ServiceZone** (value/entity) — geofence/radius defining where a branch delivers.

### 5.2 Value Objects
- `Money` (ETB, integer minor units — avoids float errors), `Quantity`, `ExpiryDate`, `BatchNumber`, `OperatingHours` (per weekday + timezone), `GeoZone` (radius or polygon), `LicenseStatus` (VALID|EXPIRED|SUSPENDED).

### 5.3 Invariants (safety- and money-critical)
- A `Pharmacy` may create/enable listings **only if** `TransactingEligibilityPolicy` passes: org `ACTIVE`, license `VALID` and not expired (BRULE-05/08).
- **Sellable quantity** of a listing = Σ(batch.quantity) over batches where `expiry > now`, minus reserved. Expired batches contribute **zero** (BRULE-15).
- Stock can never go negative: `on_hand ≥ reserved ≥ 0` at all times.
- A reservation has a **TTL**; if the order isn't confirmed/paid within the window, reservation auto-releases (prevents stock lockup).
- Every quantity change **must** produce a `StockMovement` (no silent edits) — the ledger is the source of truth; `on_hand` is a derived/cached balance.
- Listing inherits the Catalog product's `rx_classification`, `controlled_schedule`, `storage_requirement` — **read-only** here (BRULE-10, BRULE-30).

**Design rationale — ledger + derived balance.** Modeling stock as an **append-only `stock_movements` ledger** with a derived `on_hand`/`reserved` balance (like double-entry accounting) gives full auditability (NFR-COMP-05), makes reservation/release correct under concurrency, and lets us reconstruct stock at any point in time for dispute/compliance investigations. A pure mutable counter would lose this history and be prone to race conditions.

---

## 6. Transacting Eligibility & License Lifecycle (BRULE-05/08)

`TransactingEligibilityPolicy` (domain service) is the single gate consulted by listing creation, availability exposure, and order acceptance:

**Eligible to transact iff:** org status `ACTIVE` **and** verification `APPROVED` **and** license `VALID` (`license_expires_at > now`) **and** not manually `SUSPENDED`.

**License lifecycle**
- On approval → `VALID`.
- A **scheduled job** runs daily (and near expiry): when `license_expires_at ≤ now`, transition pharmacy → `SUSPENDED`, disable all listings from availability, emit `PharmacySuspended` (BRULE-08), notify owner. Existing in-flight orders follow re-match rules (BRULE-19).
- On license renewal (re-verification via Module 1) → back to `VALID`/`ACTIVE`.

**Design rationale.** Centralizing eligibility in one policy prevents inconsistent enforcement across order/search/listing paths and makes the compliance rule auditable and testable in isolation (SRP).

---

## 7. Database Design (PostgreSQL via Prisma)

UUID v7 PKs; `created_at`/`updated_at`; soft-delete where lifecycle applies. Money stored as integer minor units (ETB cents) + currency.

**pharmacies** — extends Module 1 `organizations` (type=PHARMACY) with marketplace attributes.
- `id`, `organization_id` (unique FK → organizations.id), `display_name`, `logo_url`, `description`, `rating_avg` (denormalized), `rating_count`, `transacting_status` (ACTIVE|SUSPENDED|PENDING), `license_status`, `license_expires_at`, `created_at`, `updated_at`, `deleted_at`.

**branches** — physical locations.
- `id`, `pharmacy_id` (FK), `name`, `region`, `city`, `subcity`, `woreda`, `address_line`, `lat`, `lng`, `phone`, `is_active`, `created_at`, `updated_at`, `deleted_at`.

**branch_operating_hours**
- `id`, `branch_id` (FK), `weekday` (0–6), `open_time`, `close_time`, `is_closed`. (Multiple rows allow split shifts.)

**service_zones** — delivery coverage per branch.
- `id`, `branch_id` (FK), `type` (RADIUS|POLYGON), `radius_meters` (nullable), `polygon` (geojson/jsonb, nullable), `is_active`.

**inventory_listings** — sellable offer (branch × catalog product).
- `id`, `pharmacy_id` (FK), `branch_id` (FK), `catalog_product_id` (FK → Module 3 products), `price` (int minor units), `currency` (ETB), `on_hand` (derived cache), `reserved` (derived cache), `sellable` (derived cache: expiry-aware, non-negative), `is_enabled` (bool), `storage_requirement` (copied from catalog for filtering), `created_at`, `updated_at`, `deleted_at`.
- Unique (`branch_id`,`catalog_product_id`).

**stock_batches** — per-listing batches with expiry.
- `id`, `listing_id` (FK), `batch_number`, `quantity` (on-hand for this batch), `expiry_date`, `supplier` (nullable), `received_at`, `created_at`.
- Index on (`listing_id`,`expiry_date`) for FEFO (first-expiry-first-out) picking.

**stock_movements** — immutable ledger (source of truth).
- `id`, `listing_id` (FK), `batch_id` (FK, nullable), `type` (RECEIPT|RESERVE|RELEASE|DISPATCH|ADJUST|EXPIRE|RETURN), `quantity_delta` (signed), `reason`, `ref_type` (ORDER|IMPORT|MANUAL|SYSTEM), `ref_id` (nullable), `actor_user_id` (nullable), `created_at`. Append-only.

**stock_reservations** — active holds with TTL.
- `id`, `listing_id` (FK), `order_id` (nullable ref), `quantity`, `status` (HELD|CONFIRMED|RELEASED|EXPIRED), `expires_at`, `created_at`.

**pharmacy_metrics** — denormalized performance (FR-PRV-12).
- `id`, `pharmacy_id` (FK), `period`, `orders_count`, `acceptance_rate`, `avg_fulfillment_minutes`, `cancellation_rate`, `updated_at`.

**inventory_imports** — bulk import runs.
- `id`, `pharmacy_id` (FK), `uploaded_by` (FK), `file_ref`, `dry_run` (bool), `status`, `rows_total`, `rows_ok`, `rows_failed`, `report` (jsonb), `created_at`.

**Relationships (summary)**
- `organizations 1—1 pharmacies`; `pharmacies 1—N branches`; `branches 1—N operating_hours / service_zones / inventory_listings`.
- `inventory_listings 1—N stock_batches / stock_movements / stock_reservations`.
- `inventory_listings N—1 catalog products` (Module 3, by ID reference — no FK across bounded contexts if later split; FK within monolith).
- `pharmacies 1—N pharmacy_metrics / inventory_imports`.

**Rationale.** `on_hand`/`reserved`/`sellable` on the listing are **caches derived from the ledger + batches**, refreshed transactionally on each movement — fast reads for search without recomputing from the ledger every query, while the ledger remains authoritative.

---

## 8. Concurrency & Stock Reservation (BR-PH-14)

The correctness-critical flow. Consumed by Cart/Order (Module 6).

- **Reserve (on order placement):** in a DB transaction, `SELECT ... FOR UPDATE` the listing row; verify `sellable ≥ requested`; create `stock_reservations(HELD, expires_at=now+TTL)`; write `RESERVE` movement; recompute `reserved`/`sellable`. Reject with `INSUFFICIENT_STOCK` if not enough.
- **Confirm (on payment success):** reservation `HELD → CONFIRMED`.
- **Dispatch/Fulfill:** consume from batches **FEFO** (first-expiry-first-out); write `DISPATCH` movements decrementing `on_hand`; reservation closed.
- **Release (cancel / payment fail / TTL expiry):** write `RELEASE` movement; reservation `→ RELEASED/EXPIRED`; `sellable` restored. A scheduled sweeper releases expired holds.

**Rationale.** Row-level locking on the listing during reserve prevents oversell under concurrency (NFR-PERF-05 at 10k concurrent). Reservation TTL prevents abandoned carts from permanently locking stock. FEFO batch consumption minimizes waste and enforces BRULE-15.

---

## 9. API Design

Base paths: `/api/v1/pharmacy` (org-scoped portal), `/api/v1/inventory`, `/api/v1/availability` (internal/search), `/api/v1/admin/pharmacies`. Bearer auth; org-scoped permission checks. Envelope/errors per Module 1 §14.

### 9.1 Pharmacy Onboarding & Profile (`pharmacy:manage:org` / owner)
- **POST `/pharmacy/register`** — create pharmacy org (→ PENDING_APPROVAL). Triggers Module 1 verification.
- **GET/PATCH `/pharmacy/profile`** — manage profile/logo/description.
- **CRUD `/pharmacy/branches`** — manage branches.
- **PUT `/pharmacy/branches/{id}/hours`** — set operating hours.
- **CRUD `/pharmacy/branches/{id}/zones`** — service zones.
- **GET `/pharmacy/dashboard`** — orders/revenue/stock-health summary (FR-PRV-08).
- **GET `/pharmacy/metrics`** — performance metrics (FR-PRV-12).

### 9.2 Staff (`staff:manage:org`)
- **POST `/pharmacy/staff/invite`** — invite staff (delegates to Module 1). **GET `/pharmacy/staff`**, **DELETE `/pharmacy/staff/{userId}`**.

### 9.3 Inventory (`inventory:manage:org` / `catalog:manage:org`)
- **GET `/inventory/listings`** — list with filters (branch, low-stock, near-expiry).
- **POST `/inventory/listings`** — create listing referencing `catalogProductId` + branch + price + initial batch. Eligibility-gated (403 `PHARMACY_NOT_ELIGIBLE`).
- **PATCH `/inventory/listings/{id}`** — price/enable. **DELETE** — soft-delete.
- **POST `/inventory/listings/{id}/batches`** — add batch (qty + expiry). → `RECEIPT` movement.
- **PATCH `/inventory/batches/{id}`** — adjust (→ `ADJUST` movement, reason required).
- **GET `/inventory/listings/{id}/movements`** — stock ledger (audit view).
- **POST `/inventory/import`** — bulk import (CSV, `dryRun`) → validation report.
- **GET `/inventory/alerts`** — low-stock / near-expiry alerts.

### 9.4 Availability (internal, consumed by Search/Order)
- **GET `/availability/product/{catalogProductId}`** — Query `lat,lng,radius` → in-stock, eligible pharmacies with price/branch/distance (FR-MED-05, FR-MATCH-01). Excludes suspended/expired-license pharmacies (FR-MATCH-05).
- **POST `/availability/reserve`** — (internal, called by Order) reserve stock. → reservation id.
- **POST `/availability/release`** / **POST `/availability/confirm`** — reservation lifecycle.

### 9.5 Admin (`provider:verify:any`, `user:suspend:any`)
- **GET `/admin/pharmacies`** — list/filter (status, license expiry).
- **POST `/admin/pharmacies/{id}/suspend|reactivate`** — manual suspension. Audited.
- **GET `/admin/pharmacies/{id}/compliance`** — license status, metrics, flags.

**Representative errors:** `PHARMACY_NOT_ELIGIBLE, LICENSE_EXPIRED, PHARMACY_SUSPENDED, LISTING_NOT_FOUND, DUPLICATE_LISTING, INSUFFICIENT_STOCK, BATCH_EXPIRED, RESERVATION_EXPIRED, CONTROLLED_PROHIBITED, IMPORT_VALIDATION_FAILED, RBAC_FORBIDDEN, VALIDATION_ERROR`.

---

## 10. NestJS Folder Structure (Clean Architecture)

```
src/modules/pharmacy-inventory/
  domain/
    entities/            # Pharmacy, Branch, InventoryListing, StockBatch, StockMovement,
    │                    # StockReservation, ServiceZone
    value-objects/       # Money, Quantity, ExpiryDate, BatchNumber, OperatingHours, GeoZone, LicenseStatus
    events/              # PharmacyActivated, PharmacySuspended, ListingCreated, PriceChanged,
    │                    # StockReceived, StockReserved, StockReleased, StockDispatched, BatchNearExpiry, StockLow
    enums/               # TransactingStatus, MovementType, ReservationStatus, ZoneType
    repositories/        # IPharmacyRepository, IBranchRepository, IListingRepository,
    │                    # IStockLedgerRepository, IReservationRepository, IMetricsRepository
    services/            # TransactingEligibilityPolicy, SellableStockCalculator, FefoAllocator, ReservationManager
  application/
    commands/            # RegisterPharmacy, UpdateProfile, ManageBranch, CreateListing, AddBatch,
    │                    # AdjustStock, ReserveStock, ReleaseStock, ConfirmReservation, DispatchStock,
    │                    # BulkImportInventory, SuspendPharmacy
    queries/             # GetAvailability, ListListings, GetLedger, GetDashboard, GetMetrics, GetAlerts
    ports/               # ICatalogPort (read product/classification), IIdentityPort (org/verification),
    │                    # ICachePort, IAuditPort, INotificationPort, IImportParserPort, IGeoPort
    dtos/  mappers/
  infrastructure/
    persistence/prisma/  repositories/       # Prisma*; transactional reserve with row locks
    cache/               # RedisAvailabilityCache
    import/              # CsvInventoryImportAdapter
    scheduling/          # LicenseExpirySweeper, ReservationTtlSweeper, NearExpiryScanner (cron)
    catalog/             # CatalogPortAdapter (calls Module 3 query interface)
    identity/            # IdentityPortAdapter
    audit/               # shared HashChainAuditAdapter
  interface/
    http/
      controllers/       # PharmacyController, InventoryController, AvailabilityController, AdminPharmacyController
      dtos/ guards/ decorators/ filters/ interceptors/
    events/              # on stock change → invalidate availability cache; on PharmacySuspended → notify + re-match hook
  pharmacy-inventory.module.ts
```

**Rationale.** Cross-context reads go through `ICatalogPort`/`IIdentityPort` (never direct table access) so Catalog/Identity can be extracted later. Scheduled sweepers (license expiry, reservation TTL, near-expiry) are infrastructure adapters invoking application commands — domain stays pure.

---

## 11. Sequence Flows

### 11.1 Create Listing (eligibility + classification-gated)
```
Pharmacy → POST /inventory/listings {catalogProductId, branchId, price, batch}
CreateListing → TransactingEligibilityPolicy.check(pharmacy)  [403 PHARMACY_NOT_ELIGIBLE / LICENSE_EXPIRED]
CreateListing → ICatalogPort.getProduct(catalogProductId)
  → if controlled_schedule=PROHIBITED → 422 CONTROLLED_PROHIBITED
CreateListing → IListingRepository: upsert (unique branch+product)  [409 DUPLICATE_LISTING]
CreateListing → add StockBatch + RECEIPT movement; recompute sellable
CreateListing → emit ListingCreated → invalidate availability cache
CreateListing → IAuditPort: LISTING_CREATED
→ 201 {listingId}
```

### 11.2 Availability Query (matching input)
```
Search → GET /availability/product/{id}?lat&lng&radius
GetAvailability → RedisAvailabilityCache: hit? return
 miss → IListingRepository: eligible pharmacies with sellable>0 for product within zone
      → filter out suspended/expired (TransactingEligibilityPolicy)
      → compute distance; attach price, branch, rating
      → cache snapshot (short TTL)
→ 200 [{pharmacyId, branchId, price, distance, sellable, storageRequirement}]
```

### 11.3 Reserve → Confirm → Dispatch (order lifecycle hooks)
```
Order → POST /availability/reserve {listingId, qty, orderId}
ReserveStock → TX: SELECT listing FOR UPDATE
  → sellable ≥ qty ? create reservation(HELD, ttl); RESERVE movement; recompute
  → else 409 INSUFFICIENT_STOCK
→ {reservationId}
... payment success ...
Order → POST /availability/confirm {reservationId}  → HELD→CONFIRMED
... pharmacy marks ready / dispatch ...
Order → DispatchStock: FefoAllocator picks batches by earliest expiry; DISPATCH movements; on_hand↓; reservation closed
... OR cancel/timeout ...
ReservationTtlSweeper / Order → ReleaseStock: RELEASE movement; sellable restored
```

### 11.4 License Expiry Auto-Suspend (BRULE-08)
```
LicenseExpirySweeper (daily cron) → find pharmacies where license_expires_at ≤ now, status=ACTIVE
 → PharmacyRepository: set SUSPENDED; license_status=EXPIRED
 → disable listings from availability; invalidate cache
 → emit PharmacySuspended → re-match in-flight orders (BRULE-19) + notify owner
 → IAuditPort: PHARMACY_AUTO_SUSPENDED
```

---

## 12. Error Handling

Reuses Module 1 §14 envelope/filter. Stock/eligibility errors are **hard** (safety/money-critical), never silent. Key codes: `PHARMACY_NOT_ELIGIBLE`, `LICENSE_EXPIRED`, `PHARMACY_SUSPENDED`, `INSUFFICIENT_STOCK` (returns available qty), `BATCH_EXPIRED`, `RESERVATION_EXPIRED`, `DUPLICATE_LISTING`, `CONTROLLED_PROHIBITED`, `IMPORT_VALIDATION_FAILED` (per-row report), `RBAC_FORBIDDEN`, `VALIDATION_ERROR`.

---

## 13. Logging & Auditing

Reuses hash-chained `audit_logs`; plus the immutable `stock_movements` ledger is itself an audit trail. **Must-log:**
- Pharmacy activated/suspended (manual + auto), license status change.
- Listing created/enabled/disabled, **price change** (with old→new), listing deleted.
- Every stock movement (already ledgered): receipt, reserve, release, dispatch, adjust (reason), expire.
- Bulk import runs (actor, counts, dry-run vs applied).
- Staff invited/role changes (via Module 1).

Operational logs capture availability-query latency and cache hit-rate for tuning (NFR-PERF-05).

---

## 14. Future Scalability & Evolution

- **Availability at scale** — Redis snapshots keyed by (productId, geo-cell); event-driven invalidation on stock/price/eligibility change. Later: precomputed geospatial index (PostGIS / geohash) for radius queries.
- **Sharding/partitioning** — `inventory_listings`, `stock_batches`, `stock_movements` partition by `pharmacy_id`; cold movements archived.
- **Extraction-ready** — depends on Catalog/Identity only via ports; emits domain events (stock, suspension) → can become an Inventory service with an event-sourced ledger.
- **Multi-branch & franchises** — branch model already supports chains; central-vs-branch pricing configurable later.
- **Supplier/distributor integration** (NFR-INTEROP-03) — batch receipts via `IImportParserPort`/supplier adapters; enables sourcing traceability (NFR-COMP-05).
- **Demand forecasting / auto-reorder (AI, future)** — consumes the movement ledger as a clean time-series.

---

## Open Questions for Product/Compliance
1. **Reservation TTL** — how long is stock held before payment must complete (e.g., 15 min)? Affects abandoned-cart release.
2. **Multi-pharmacy order splitting** (FR-MATCH-07) — do we allow one order to draw stock from multiple pharmacies at launch, or single-pharmacy fulfillment only?
3. **Controlled substances online** — confirm which (if any) may be listed with extra controls vs fully excluded (ties to Module 3 Q2).
4. **Pricing model** — pharmacy-set selling prices only, or platform price ceilings enforced against Catalog's reference price for essential medicines? *(Partially answered since this doc was written: a platform **reference** price now exists as `Product.price` in Module 03, and Module 06 uses it to price orders. What remains open is whether `InventoryListing.price` should be **constrained** by it — a ceiling/parity rule — which no module enforces today.)*
5. **Batch data mandatory?** — is batch#+expiry required for every medicine listing at MVP, or expiry-only acceptable initially?

---

**End of Module 4 design.** Awaiting your approval to proceed. Recommended next module: **Prescription & Matching** — secure prescription upload/storage, pharmacist verification (BRULE-10/11/12/14), and intelligent pharmacy matching (FR-MATCH) built on this module's availability engine.
