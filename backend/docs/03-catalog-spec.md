# Module 03 — Catalog: Vertical Slice 1 Implementation Specification

**Slice:** Canonical Product Master + Categories + Public Search/Read + Admin Curation
**Status:** APPROVED — Architect review complete; the 7 open questions originally listed in §14 are now resolved decisions (see §14). Ready for implementation per the folder layout in §10, following the same gate Module 02 went through (`backend/docs/02-profiles-spec.md`).
**Parent design doc:** `architecture/module-03-catalog.md` (§1–§10) — this document narrows that design into a buildable, end-to-end first slice per `architecture/00-implementation-roadmap.md` §1 ("vertical slices, not horizontal layers").
**Depends on:** Module 01 — Identity & Authentication (RBAC, guards, audit, error envelope — reused as-is, same as Module 02). Module 02 — Profiles (no functional dependency; Catalog does not read `CustomerProfile`/`Address`). **Consumed by (future):** Module 04 (Pharmacy/Inventory listings reference `Product.id`), Module 05 (Prescription/Matching gates on `rxClassification`), Module 06 (Orders), Module 14 (Search projections).
**Traceability:** BR-CAT-01..11, FR-CAT-01..06, FR-MET-01..06, FR-TAX-01..03, FR-MOD-01..05, BRULE-10, BRULE-13, BRULE-16, NFR-PERF-01, NFR-COMP-02/03/05.

---

## 0. Why this is a separate slice from the parent design doc

`architecture/module-03-catalog.md` specifies the **full** Catalog bounded context, including equivalence groups/substitution (§5.3, §7.1, §9.4), pharmacy-submitted proposals + moderation (§3.5, §7.3, §9.2), bulk CSV import (§3.5 F-MOD-05), and a denormalized `catalog_search_view`. Per the roadmap's "vertical slices, not horizontal layers" principle (the same reasoning Module 02 used to defer beneficiaries/consent/notifications to later slices), **Slice 1 ships the smallest end-to-end useful capability**: a curated, classified, searchable product master that Module 04 (Inventory) can immediately reference by `productId`. Everything else in the parent doc is explicitly deferred below.

### 0.1 In scope for Slice 1
- **Product master CRUD** (admin-only writes): create/edit/deprecate/delist a canonical `Product` with full metadata (BR-CAT-01/02, F-CAT-01/02/05).
- **Rx/OTC + controlled-substance classification**, authoritative and immutable outside admin (BR-CAT-03/04, F-CAT-03/04).
- **Categories**: hierarchical taxonomy, admin-managed, product↔category assignment (BR-CAT-05, F-TAX-01/02).
- **Manufacturers**: normalized reference entity, admin-managed.
- **Deduplication guard on create** (BR-CAT-08, F-CAT-06) using the exact-match index already defined in `03-catalog.prisma` (`genericName+strengthValue+strengthUnit+dosageForm+manufacturerId`).
- **Public read/search API**: list/search/filter products, get product detail, get category tree (BR-CAT-09, F-SRCH-01/02).
- Permissions, audit events, error codes, and DTO validation for the above.

### 0.2 Explicitly out of scope for this slice (tracked for later slices of Module 03)
| Deferred item | Why deferred | Covered by |
| --- | --- | --- |
| `EquivalenceGroup` / substitution (`GET /catalog/products/{id}/substitutes`) | Independent read-feature with its own safety-review requirement (BRULE-16 is safety-critical — deserves dedicated review, not bundled with basic CRUD). Schema (`equivalence_groups`, `Product.equivalenceGroupId`) already exists and is untouched. | Module 03 — Slice 2 |
| `ProductProposal` / pharmacy contribution + moderation queue | Depends on Module 04 (pharmacy/org identity) existing meaningfully in practice before a pharmacy has anything to propose against; also a distinct workflow (submit → review → merge) worth its own slice. | Module 03 — Slice 3 (after Module 04 begins) |
| Bulk CSV import (F-MOD-05) | Operational tooling, not a blocking dependency for Module 04 to start referencing products. | Module 03 — Slice 2 or later |
| `product_tags` search synonyms (Amharic) | Nice-to-have for search relevance; the base `ILIKE`/`pg_trgm` search in this slice works without it. | Module 03 — Slice 2 |
| `catalog_search_view` materialized view / OpenSearch-ready projection | Slice 1 serves search directly off `products` + `pg_trgm` (see §5) — sufficient at current scale; the parent doc's dedicated read model is a Module 14 (Search) concern per its own §92 boundary note ("Search composes Catalog + Inventory"). | Module 14, or Module 03 — Slice 4 if p95 latency (NFR-PERF-01) is not met |
| Product images upload | Requires `IStoragePort` (same blocker Module 02 flagged for profile photos) — not yet built. DTOs accept an already-hosted `url` only; no upload endpoint. | Module 03 — Slice 2 (once `IStoragePort` exists) |
| Multi-ingredient composition (`product_ingredients`) write API | Schema exists; not exposed in Slice 1 DTOs to keep the first slice's validation surface small. Read-only passthrough if present. | Module 03 — Slice 2 |

### 0.3 Definition of done for this slice
An admin can create/edit/deprecate a canonical product with correct Rx/OTC and controlled classification, organize it into categories, and have duplicates rejected; any client (authenticated or not) can search/filter/browse the catalog and view product detail — all through permission-guarded (for writes), audited, envelope-consistent, transactionally-atomic endpoints, backed by tests per `00-implementation-roadmap.md` §5 and matching the hardening pattern established in Module 02 (see `backend/docs/02-profiles-spec.md` §0).

---

## 1. Business & Functional Requirements Covered

| ID | Requirement | Slice 1 coverage |
| --- | --- | --- |
| BR-CAT-01 | Brand + generic (INN) name | ✅ `Product.brandName` / `genericName` |
| BR-CAT-02 | Form, strength, descriptive details | ✅ `dosageForm`, `strengthValue/Unit`, `packSize`, localized descriptions |
| BR-CAT-03 | Authoritative Rx/OTC classification | ✅ `ClassificationPolicy` domain service, admin-only mutation |
| BR-CAT-04 | Controlled/narcotic flagging | ✅ `controlledSchedule`, `onlineSaleProhibited` derived, enforced at create/update |
| BR-CAT-05 | Categories for medicines/health products | ✅ hierarchical `Category` + `ProductCategory` |
| BR-CAT-06 | Generic/therapeutic equivalence | ⏸ Deferred (§0.2) |
| BR-CAT-07 | Pharmacy listings reference catalog; bulk import | ⏸ Deferred (§0.2) — but `Product.id` is stable and referenceable by Module 04 starting Slice 1 |
| BR-CAT-08 | Central moderation, no duplicates | ✅ (dedup on direct admin create only; proposal-queue moderation deferred) |
| BR-CAT-09 | Fast search/filter reads | ✅ `GET /catalog/products` |
| BR-CAT-10 | Manufacturer/traceability metadata | ✅ `Manufacturer` entity |
| BR-CAT-11 | Only valid/non-expired stock offered | N/A to Catalog — Inventory (04) concern; Catalog only guarantees `onlineSaleProhibited` is correctly derived and readable |

---

## 2. Integration with Module 01 (Identity) and Module 02 (Profiles)

- **No cross-module table reads or Prisma relations** (ADR-002), identical discipline to Module 02. `ProductProposal.submittedByUserId`/`organizationId` (deferred to Slice 3 anyway) would be plain `String` columns, never a Prisma relation into Identity.
- **AuthN/AuthZ fully reused, not reimplemented.** `IdentityModule` already registers `JwtAuthGuard` and `PermissionsGuard` as global `APP_GUARD`s — every `CatalogModule` controller is protected automatically. Public read routes use a bare `@Public()` (`modules/identity/interface/decorators/public.decorator.ts`) and nothing else — confirmed by Architect review against the actual guard implementations (§14.1) — rather than inventing a new guard or decorator.
- **No dependency on Module 02.** Catalog does not read `CustomerProfile`/`Address`; the only shared surface is the cross-cutting kit (`PrismaService`, `AuditService`, `OutboxService`, `EVENT_BUS`, error envelope, RBAC).
- **Zero event-driven bootstrapping needed** (unlike Module 02's `EnsureCustomerProfileCommand` reacting to `UserRegistered`) — a `Product` row only ever comes from an explicit admin `POST`, never a lazy/reactive create.

---

## 3. Domain Model

### 3.1 Product (aggregate root)
Existing Prisma model (`prisma/schema/03-catalog.prisma`) is reused as-is for Slice 1 — **no schema changes required** (unlike Module 02, which needed a `fullName` nullability fix). Fields consumed/written by this slice:

| Field | Type | Nullable | Notes |
| --- | --- | --- | --- |
| `id` | UUID | no | PK, server-generated |
| `type` | `ProductType` (`MEDICINE`\|`HEALTH_PRODUCT`) | no | Drives the classification invariant below |
| `genericName` | String | yes | Required when `type = MEDICINE` (application-layer rule, not a DB constraint — mirrors Module 02's DOB-in-command pattern) |
| `brandName` | String | yes | — |
| `manufacturerId` | String (FK, intra-module) | yes (column) | Schema-nullable, but **required at the business-rule level when `type = MEDICINE`** — same enforcement split as `rxClassification` (DTO marks it `@IsOptional`, the command layer rejects a missing value for `MEDICINE`). Validated to exist when provided; `404 MANUFACTURER_NOT_FOUND` otherwise. `HEALTH_PRODUCT` rows may omit it. See §3.6 invariant 8 and §6.2. |
| `dosageForm` | String | yes | Slice 1 validates against a fixed allowlist (`TABLET, CAPSULE, SYRUP, INJECTION, CREAM, OINTMENT, DROPS, INHALER, OTHER`) rather than a free string, to keep dedup/equivalence keys stable for a future slice |
| `strengthValue` / `strengthUnit` | Float / String | yes | Unit validated against a small allowlist (`MG, ML, G, MCG, IU, PERCENT`) |
| `packSize` | String | yes | Free text (e.g., `"30 tablets"`) — not parsed in Slice 1 |
| `atcCode` | String | yes | Free text, format-validated (`^[A-Z]\d{2}[A-Z]{2}\d{2}$`) if present, not looked up against a real ATC registry in Slice 1 |
| `rxClassification` | `RxClassification` (`RX`\|`OTC`) | yes | **Required if `type = MEDICINE`; must be null if `type = HEALTH_PRODUCT`** (invariant, §4) |
| `controlledSchedule` | `ControlledSchedule` enum | no (default `NONE`) | Admin-settable |
| `onlineSaleProhibited` | Boolean | no (default `false`) | **Server-computed only** — `true` iff `controlledSchedule = PROHIBITED`; never independently client-settable (mirrors Module 02's `isWithinEthiopia` pattern) |
| `storageRequirement` | enum | no (default `AMBIENT`) | — |
| `equivalenceGroupId` | String | yes | **Not settable by this slice** (§0.2) — DTOs omit it; `forbidNonWhitelisted` rejects it |
| `nameAm` / `nameEn` | String | yes | At least one of `nameEn` or `brandName` must be present (display-name rule, §5) |
| `descriptionAm` / `descriptionEn` | String | yes | Free text, ≤ 2000 chars |
| `warnings` | String | yes | Free text, ≤ 2000 chars |
| `price` | Int | yes | **Platform reference price** in ETB integer minor units (`00-shared-conventions.md` §11 — money is never a float, so the DTO uses `@IsInt()`, never `@IsNumber()`). Domain-validated non-negative. `null` = **not priced, therefore not purchasable** — never treated as free: Module 06's `ICatalogPort` adapter reports an unpriced product as not found, routing checkout into its existing `CATALOG_PRODUCT_NOT_FOUND` branch rather than placing a zero-value order. **Distinct from `InventoryListing.price` (Module 04)**, which is the per-pharmacy *selling* price; see `architecture/module-03-catalog.md` §1 and ADR-015. Column added by migration `20260906000000_catalog_product_price` |
| `status` | `ProductStatus` (`DRAFT`\|`PENDING_REVIEW`\|`ACTIVE`\|`DEPRECATED`\|`DELISTED`) | no (default `DRAFT`) | Slice 1 uses only `DRAFT`, `ACTIVE`, `DEPRECATED`, `DELISTED` — `PENDING_REVIEW` is reserved for the Slice 3 moderation workflow and unreachable via this slice's endpoints |
| `createdBy` | String | yes | Set from `@CurrentUser()` on create, never client-settable |
| `createdAt`/`updatedAt`/`deletedAt` | DateTime | — | standard; **hard delete is never exposed** — `DELISTED` status is the only "removal" this slice supports (a listed medicine's history must remain auditable) |

**Fields explicitly NOT exposed by this slice's DTOs** (schema columns that exist but are out of scope): none on `Product` itself — `equivalenceGroupId` is the only omission, covered above. (`price` *was* such an omission until the Module 06 reconciliation: the column existed but the aggregate, repository, detail view and DTOs all dropped it, so the only way to set a catalog price was a raw Prisma write outside this module. It is now carried end-to-end through the aggregate and repository like any other curated field.) `ProductIngredient`, `ProductImage`, `ProductTag` are separate models (§0.2) with no Slice 1 write path; `GET /catalog/products/{id}` may still surface pre-existing rows read-only if present (defensive, but no write path means this is normally empty in Slice 1).

### 3.2 Category (entity, hierarchical)
Existing Prisma model reused as-is.

| Field | Type | Nullable | Notes |
| --- | --- | --- | --- |
| `id` | UUID | no | PK |
| `parentId` | String (self-FK) | yes | Must reference an existing, non-deleted category; cycles rejected (§4) |
| `slug` | String | no | Unique, URL-safe (`^[a-z0-9-]{2,80}$`), immutable after create (changing a slug breaks external links/bookmarks — Slice 1 rule; revisit if a real need appears) |
| `nameAm` / `nameEn` | String | yes | At least one required |
| `appliesTo` | `CategoryAppliesTo` (`MEDICINE`\|`HEALTH_PRODUCT`\|`BOTH`) | no (default `BOTH`) | — |
| `sortOrder` | Int | no (default `0`) | — |
| `isActive` | Boolean | no (default `true`) | Inactive categories are hidden from public reads but retained for existing product associations |

### 3.3 Manufacturer (reference entity)
Existing Prisma model reused as-is: `id`, `name` (unique), `country`, `status`, `createdAt`. Slice 1 treats `status` as a simple `ACTIVE`\|`INACTIVE` string (matches current schema's untyped `String?`); admin CRUD only, no public write.

### 3.4 Value Objects
- `GenericName`, `BrandName` — thin wrappers with length/charset validation (mirrors Module 02's `PersonName`-style pattern, kept in `domain/value-objects/`).
- `Strength` — `{ value: number; unit: StrengthUnit }`, validates `value > 0`.
- `DosageForm` — enum-backed value object over the Slice 1 allowlist (§3.1).
- `RxClassification` / `ControlledSchedule` / `ProductStatus` / `CategoryAppliesTo` — re-exported Prisma enums at the domain layer (`domain/enums.ts`), same pattern as Module 02's `Gender`/`AddressLabel`.
- `AtcCode` — validates the format regex above when present; otherwise `null`.
- `LocalizedText` — `{ am?: string; en?: string }` helper used by the "at least one localized name" rule (§4).

### 3.5 Domain Services
- **`ClassificationPolicy`** (pure, framework-free) — encodes the compliance-critical invariants in §4 as one reusable, unit-testable function set: `assertValidClassification(type, rxClassification)`, `deriveOnlineSaleProhibited(controlledSchedule)`. **This is the single home for Rx/controlled logic** (per the parent doc's rationale, §5.3) — commands call into it rather than re-implementing checks inline, exactly mirroring Module 02's `GeoPoint.withinEthiopia` pattern for BRULE-21.
- **`DeduplicationService`** (queries the DB, so it lives partly in application/infrastructure, but its *rule* — "duplicate iff `genericName+strengthValue+strengthUnit+dosageForm+manufacturerId` all match, `type = MEDICINE` only" — is declared as a pure predicate in `domain/services/` and executed via the repository's dedicated lookup method, mirroring how Module 02 kept the ET bounding-box math pure while the address-count check ran through the repository).

### 3.6 Invariants
1. A `MEDICINE` product **must** carry a non-null `rxClassification`; a `HEALTH_PRODUCT` **must not** (BR-CAT-03, parent doc §5.3) — enforced in `ClassificationPolicy`, checked on both create and update.
2. If `controlledSchedule = PROHIBITED`, `onlineSaleProhibited` is forced `true` server-side; if `controlledSchedule ≠ PROHIBITED`, `onlineSaleProhibited` is forced `false` — **never independently settable** (mirrors Module 02's `isWithinEthiopia`).
3. Rx/OTC and controlled classification are **admin-only, always** — there is no non-admin write path in this slice at all (simpler than Module 02's ownership-scoped rule, since Slice 1 has no pharmacy-proposal path yet).
4. Two `MEDICINE` products are duplicates iff `(genericName, strengthValue, strengthUnit, dosageForm, manufacturerId)` all match (case-insensitive on `genericName`) — create is **rejected outright** with the candidate id surfaced (`409 CATALOG_DUPLICATE_PRODUCT`), matching the parent doc's dedup flow (§9.1). `HEALTH_PRODUCT` rows are **exempt from this check in Slice 1** (no reliable "strength" concept for many wellness/device items) — resolved by Architect review (§14.2): accepted as-is; a lighter health-product dedup key is not warranted until real duplicate spam is observed (candidate for Slice 2).
5. A category's `parentId` chain must never cycle back to itself (validated by walking the chain on create/reparent, bounded to a max depth of 6 as an abuse guard).
6. `status` transitions are restricted to a fixed state machine: `DRAFT → ACTIVE`, `ACTIVE → DEPRECATED`, `ACTIVE → DELISTED`, `DEPRECATED → ACTIVE`, `DEPRECATED → DELISTED`, **`DELISTED → DRAFT`**. Any other transition (e.g. `DELISTED → ACTIVE` directly, or jumping to `PENDING_REVIEW`) is rejected with `422 INVALID_PRODUCT_STATUS_TRANSITION`. Resolved by Architect review (§14.3): `DELISTED` is **not** fully terminal — an admin may move a delisted product back to `DRAFT` for correction, but never straight back to `ACTIVE`. Re-activating it after that requires the normal `DRAFT → ACTIVE` transition, so a withdrawn medicine always gets a fresh, deliberate review before it can be public again; there is no direct "undelist" toggle, and no state is ever permanently unrecoverable without a DB-level fix.
7. Soft-delete is **not used** for `Product`/`Category` in Slice 1 — lifecycle is modeled entirely through `status`/`isActive`, consistent with the parent doc's `DRAFT→…→DELISTED` design; `deletedAt` stays in the schema for a future hard-retention/purge policy but Slice 1 never sets it.
8. A `MEDICINE` product **must** carry a non-null `manufacturerId`; a `HEALTH_PRODUCT` **may** omit it — enforced at the business-rule layer (`CreateProductCommand`/`UpdateProductCommand`), exactly the same enforcement split as invariant 1's `rxClassification` rule (DTO-optional, command-required for `MEDICINE`). Resolved by Architect review (§14.6): this closes the `manufacturerId IS NULL` dedup-index gap described in §6.2 — Postgres treats `NULL` values as distinct in a unique index, so two untagged `MEDICINE` duplicates would otherwise never collide on the partial unique index; requiring the field removes that gap instead of accepting it.

---

## 4. Validation Rules (DTO-level, `class-validator`, same `ValidationPipe` config as Module 02: `whitelist: true, forbidNonWhitelisted: true, transform: true`)

### 4.1 Product — `CreateProductDto` (`POST /admin/catalog/products`)
```ts
class CreateProductDto {
  @IsIn(['MEDICINE', 'HEALTH_PRODUCT']) type!: string;
  @IsOptional() @IsString() @Length(2, 200) genericName?: string;
  @IsOptional() @IsString() @Length(2, 200) brandName?: string;
  @IsOptional() @IsUUID() manufacturerId?: string;
  @IsOptional() @IsIn(DOSAGE_FORM_ALLOWLIST) dosageForm?: string;
  @IsOptional() @IsNumber() @Min(0.0001) strengthValue?: number;
  @IsOptional() @IsIn(STRENGTH_UNIT_ALLOWLIST) strengthUnit?: string;
  @IsOptional() @IsString() @Length(1, 40) packSize?: string;
  @IsOptional() @Matches(ATC_CODE_REGEX) atcCode?: string;
  @IsOptional() @IsIn(['RX', 'OTC']) rxClassification?: string;
  @IsOptional() @IsIn(['NONE','SCHEDULE_1','SCHEDULE_2','SCHEDULE_3','SCHEDULE_4','SCHEDULE_5','PROHIBITED'])
    controlledSchedule?: string;
  @IsOptional() @IsIn(['AMBIENT', 'COLD_CHAIN', 'CONTROLLED_TEMP']) storageRequirement?: string;
  @IsOptional() @IsString() @Length(1, 200) nameAm?: string;
  @IsOptional() @IsString() @Length(1, 200) nameEn?: string;
  @IsOptional() @IsString() @Length(0, 2000) descriptionAm?: string;
  @IsOptional() @IsString() @Length(0, 2000) descriptionEn?: string;
  @IsOptional() @IsString() @Length(0, 2000) warnings?: string;
  @IsOptional() @IsInt() @Min(0) price?: number;   // reference price, ETB minor units (§3.1)
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsUUID('4', { each: true }) categoryIds?: string[];
}
class UpdateProductDto extends PartialType(OmitType(CreateProductDto, ['type'] as const)) {}
```
- `type` is **immutable after create** — `UpdateProductDto` omits it entirely (changing `MEDICINE`↔`HEALTH_PRODUCT` post-hoc is a data-integrity hazard given the classification invariant; create a new product instead). `forbidNonWhitelisted` rejects any attempt to send `type` on `PATCH`.
- Business validation (in `CreateProductCommand`/`UpdateProductCommand`, not the DTO, same split as Module 02's DOB rule):
  - `type = MEDICINE` ⇒ `rxClassification` required → `422 VALIDATION_ERROR` field `rxClassification` otherwise.
  - `type = HEALTH_PRODUCT` ⇒ `rxClassification` must be omitted → `422 VALIDATION_ERROR` if present.
  - `type = MEDICINE` ⇒ `manufacturerId` required → `422 VALIDATION_ERROR` field `manufacturerId` otherwise (§3.6 invariant 8, resolved §14.6). `type = HEALTH_PRODUCT` may omit it.
  - At least one of `nameEn`, `brandName` must be present (display-name rule) → `422 VALIDATION_ERROR` field `nameEn`.
  - `manufacturerId`, each `categoryIds[i]` must reference existing, active rows → `404 MANUFACTURER_NOT_FOUND` / `404 CATEGORY_NOT_FOUND`.
  - `price`, when supplied, must be a **non-negative integer** (minor units) → `400 VALIDATION_ERROR` field `price` otherwise. Enforced in the `Product` aggregate as well as the DTO, so the rule holds for every writer of the aggregate rather than only the HTTP surface. Omitting `price` on create leaves it `null` (unpriced); omitting it on `PATCH` leaves the existing price **untouched** — a PATCH never silently clears a live price.
  - PATCH semantics: at least one field required, empty body → `422 VALIDATION_ERROR` (identical rule to Module 02 §4.1).

### 4.2 Product status — `ChangeProductStatusDto` (`POST /admin/catalog/products/:id/status`)
```ts
class ChangeProductStatusDto {
  @IsIn(['ACTIVE', 'DEPRECATED', 'DELISTED', 'DRAFT']) status!: string;
  @IsOptional() @IsString() @Length(1, 300) reason?: string;
}
```
- `DRAFT` is only ever a legal *target* from `DELISTED` (§3.6 invariant 6) — it is not reachable from `ACTIVE`/`DEPRECATED`. The DTO allows the value generally; the state machine (not the DTO) is the source of truth for which `(from, to)` pairs are legal.
- Transition legality is enforced by the state machine in §3.6 invariant 6, not the DTO → `422 INVALID_PRODUCT_STATUS_TRANSITION` on an illegal transition (e.g. `DELISTED → ACTIVE` directly, still illegal — must go through `DELISTED → DRAFT → ACTIVE`).

### 4.3 Category — `CreateCategoryDto` / `UpdateCategoryDto`
```ts
class CreateCategoryDto {
  @IsOptional() @IsUUID() parentId?: string;
  @IsString() @Matches(/^[a-z0-9-]{2,80}$/) slug!: string;
  @IsOptional() @IsString() @Length(1, 120) nameAm?: string;
  @IsOptional() @IsString() @Length(1, 120) nameEn?: string;
  @IsOptional() @IsIn(['MEDICINE', 'HEALTH_PRODUCT', 'BOTH']) appliesTo?: string = 'BOTH';
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
}
class UpdateCategoryDto extends PartialType(OmitType(CreateCategoryDto, ['slug'] as const)) {
  @IsOptional() @IsBoolean() isActive?: boolean;
}
```
- `slug` immutable after create (§3.2); omitted from `UpdateCategoryDto`.
- At least one of `nameAm`/`nameEn` required (same "at least one locator"-style rule as Module 02 §4.2's address locator check) → `422 VALIDATION_ERROR` field `nameEn`.
- `parentId` cycle check (§3.6 invariant 5) → `422 CATEGORY_CYCLE_DETECTED`.

### 4.4 Manufacturer — `CreateManufacturerDto` / `UpdateManufacturerDto`
```ts
class CreateManufacturerDto {
  @IsString() @Length(2, 150) name!: string;
  @IsOptional() @IsString() @Length(2, 100) country?: string;
}
class UpdateManufacturerDto extends PartialType(CreateManufacturerDto) {
  @IsOptional() @IsIn(['ACTIVE', 'INACTIVE']) status?: string;
}
```
- `name` unique (DB constraint already present) → `409 CONFLICT` (generic shared code — no catalog-specific dup-manufacturer code needed) on violation.

### 4.5 Search/list query — `SearchProductsQueryDto` (`GET /catalog/products`)
```ts
class SearchProductsQueryDto {
  @IsOptional() @IsString() @Length(1, 100) q?: string;
  @IsOptional() @IsIn(['MEDICINE', 'HEALTH_PRODUCT']) type?: string;
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @IsIn(['RX', 'OTC']) rx?: string;
  @IsOptional() @IsUUID() manufacturerId?: string;
  @IsOptional() @IsIn(['relevance', 'name_asc', 'newest']) sort?: string = 'relevance';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) size?: number = 20;
}
```
- Public reads only ever return `status = ACTIVE` products (§7.1) — `DRAFT`/`DEPRECATED`/`DELISTED` are invisible outside `/admin/catalog/*`, enforced in the query, not just the controller (defense in depth, same "never trust the caller" posture as Module 02's ownership checks).

---

## 5. Search Approach for Slice 1 (no dedicated read model yet)

Per §0.2, Slice 1 does **not** build `catalog_search_view`. Instead:
- `GET /catalog/products` queries `products` directly with `deletedAt IS NULL AND status = 'ACTIVE'`, `ILIKE`-based matching on `genericName`/`brandName`/`nameEn`/`nameAm` for `q`, plus the `type`/`categoryId`/`rx`/`manufacturerId` filters as plain `WHERE` clauses.
- Add a **`pg_trgm` GIN index** (raw-SQL follow-up migration, same mechanism Module 02 used for its partial unique index — see §8.3) on `genericName`, `brandName` for typo-tolerant `ILIKE '%...%'`/similarity search, avoiding a full-text `tsvector` build-out until Module 14 (Search) exists.
- **This is a deliberate, documented simplification, confirmed acceptable by Architect review (§14.5)** — acceptable because Slice 1's consumer is direct browsing, not the cross-entity ranked search that Module 14 will eventually own (parent doc §92 boundary note already assigns ranked/joined search to Module 14), and comfortably clears the platform-wide NFR-PERF-01 target (≤2s p95) at Slice 1 data volume. Revisit only if p95 latency is not met at real data volume.

---

## 6. Database Requirements

### 6.1 Already correct, no change needed
`prisma/schema/03-catalog.prisma` already defines `Product`, `Category`, `Manufacturer`, `ProductCategory`, `EquivalenceGroup`, `ProductIngredient`, `ProductImage`, `ProductTag`, `ProductProposal` with the right shape for both this slice and later ones, no cross-module relations (ADR-002 compliant), `@@map` table names matching the architecture doc, and a supporting `@@index([genericName])` on `products`. **Unlike Module 02, this slice requires zero Prisma model changes** — the schema was already frozen correctly for Slice 1's needs.

### 6.2 Required migration — dedup uniqueness for medicines
The parent doc (§6) specifies a unique dedup index on `(generic_name, strength_value, strength_unit, dosage_form, manufacturer_id)` **where `type = 'MEDICINE'`**. Prisma cannot express a partial/filtered unique index declaratively (same limitation Module 02 hit for `addresses_one_default_per_user`), so this is a raw-SQL follow-up migration:
```sql
CREATE UNIQUE INDEX products_medicine_dedup_key
  ON products ("genericName", "strengthValue", "strengthUnit", "dosageForm", "manufacturerId")
  WHERE type = 'MEDICINE' AND "deletedAt" IS NULL;
```
This makes invariant §3.6.4 crash-safe under concurrency (two admins can't both create the same medicine in a race), not just application-layer-checked — directly mirroring how Module 02 backed its "one default address" rule with a DB constraint rather than trusting the app layer alone (`DEFECT-PROFILES-001` was exactly this class of bug). The application layer must catch the resulting unique-violation and return `409 CATALOG_DUPLICATE_PRODUCT` (not a raw 500) — see §13.

**Resolved (§14.6):** Postgres treats `NULL` values in a unique index as distinct from each other, so two `MEDICINE` products that both have `manufacturerId = NULL` would **not** collide on this index even if every other field matches. Rather than accept that gap, `manufacturerId` is **required at the business-rule level for `type = MEDICINE`** (§3.1, §3.6 invariant 8, §4.1) — every `MEDICINE` row that can reach this index therefore always has a non-null `manufacturerId`, so the gap cannot occur in practice. `HEALTH_PRODUCT` rows are unaffected (exempt from dedup entirely, §3.6 invariant 4) and may still have a null `manufacturerId`.

### 6.3 Required migration — search index
```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX products_generic_name_trgm_idx ON products USING GIN ("genericName" gin_trgm_ops);
CREATE INDEX products_brand_name_trgm_idx ON products USING GIN ("brandName" gin_trgm_ops);
```

### 6.4 No other schema changes
`EquivalenceGroup`, `ProductProposal`, `ProductTag`, `ProductIngredient`, `ProductImage` remain untouched (out of scope, §0.2) — do not migrate or seed them in this slice.

---

## 7. Permissions (RBAC)

### 7.1 New permissions to add to `prisma/rbac-catalog.ts`
The existing catalog says: `{ key: 'catalog:manage:org', resource: 'catalog', action: 'manage', scope: 'org' }`, already granted to `PHARMACY_OWNER`/`PHARMACY_MANAGER`. **This existing key is for the deferred Slice 3 pharmacy-proposal workflow** (an `org`-scoped pharmacy managing *its own* proposals) — it must **not** be reused for Slice 1's admin-only product master writes, which need `any`-scope, platform-level control. Add new keys rather than repurposing the existing one:
```ts
{ key: 'catalog:read:any', resource: 'catalog', action: 'read', scope: 'any' },     // reserved, UNUSED in Slice 1 — see note below
{ key: 'catalog:manage:any', resource: 'catalog', action: 'manage', scope: 'any' }, // create/update/status/categories/manufacturers
```
**`catalog:read:any` is reserved for a future authenticated-read variant only — resolved by Architect review (§14.1).** It must **not** be attached to any Slice 1 public route via `@RequirePermissions`. Public Catalog reads (§7.2, §8.1) use a bare `@Public()` and nothing else; `PermissionsGuard` already no-ops when a handler carries no `@RequirePermissions` metadata at all (verified against `shared/rbac/permissions.guard.ts`), so pairing a public route with `@RequirePermissions('catalog:read:any')` would be both unnecessary and actively wrong — it would force `JwtAuthGuard`'s populated principal to also pass a permission check, defeating the "no permission required" intent. This key may be seeded now (harmless, unwired) but is not granted to any role and not referenced by any controller in this slice.

Grant `catalog:manage:any` to `ADMIN` and `SUPER_ADMIN` only:
```ts
ADMIN: [
  ...existing,
  'catalog:manage:any',
],
```
(`SUPER_ADMIN` already has the `*` wildcard — no change needed there.)

### 7.2 Guarding
- `GET /catalog/products`, `GET /catalog/products/:id`, `GET /catalog/categories`, `GET /catalog/categories/:id/products` → **no permission required** (public reads, same as the parent doc §7.1 intent). Resolved by Architect review (§14.1): annotate each handler with a bare `@Public()` (from `modules/identity/interface/decorators/public.decorator.ts`) and add **no** `@RequirePermissions()` call — this is the exact pattern already used by `auth.controller.ts`'s `login`/`register`/`refresh` handlers, verified directly against `JwtAuthGuard`/`PermissionsGuard`. No new guard or decorator is introduced. Note: `@Public()` short-circuits `JwtAuthGuard` entirely, so `request.user` is never populated on these routes even if a bearer token is sent — these are unauthenticated-only routes, not optional-auth routes.
- `POST/PATCH /admin/catalog/products*`, `POST /admin/catalog/products/:id/status`, all of `/admin/catalog/categories`, all of `/admin/catalog/manufacturers` → `@RequirePermissions('catalog:manage:any')`.
- No ownership/scope check is needed beyond the permission itself in Slice 1 (unlike Module 02's per-resource `own` check) — there is no non-admin writer yet, so `any`-scope + the permission gate is sufficient. This will need to change in Slice 3 once pharmacy-scoped `org` proposals exist.

---

## 8. API Contracts

Base paths: `/api/v1/catalog` (public reads), `/api/v1/admin/catalog` (admin curation) — per `00-shared-conventions.md` §1. Standard success/error envelope wraps every response.

### 8.1 Public reads

**`GET /catalog/products`** — no permission required
- Query: `SearchProductsQueryDto` (§4.5).
- 200: `{ items: ProductSummaryView[], meta: { page, size, total } }` where `ProductSummaryView = { id, type, brandName, genericName, nameAm, nameEn, dosageForm, strengthValue, strengthUnit, rxClassification, manufacturerName, primaryCategoryId } }` (no `warnings`/`descriptions` in the list view — kept light for list rendering; full detail via the `:id` route).

**`GET /catalog/products/:id`** — no permission required
- 200: full `ProductDetailView` (all §3.1 fields except internal-only `createdBy`) + `categories: CategorySummary[]`.
- 404 `NOT_FOUND` if missing, soft-deleted, or `status ∈ {DRAFT, PENDING_REVIEW, DELISTED}` (non-admin callers never see non-`ACTIVE`/`DEPRECATED` products — `DEPRECATED` stays visible read-only since existing orders/history may reference it, but excluded from `GET /catalog/products` search results).

**`GET /catalog/categories`** — no permission required
- 200: full active category tree (nested `children[]`), ordered by `sortOrder`.

**`GET /catalog/categories/:id/products`** — no permission required
- 200: same shape as `GET /catalog/products`, filtered to the category (and, for Slice 1, **not** recursively into subcategories — resolved by Architect review, §14.7: direct assignments only; recursive descendant listing is deferred to a later slice).

### 8.2 Admin curation (`catalog:manage:any`)

**`POST /admin/catalog/products`**
- Body: `CreateProductDto` (§4.1).
- Flow: validate DTO → business rule: `type = MEDICINE` ⇒ `manufacturerId` required (§3.6 invariant 8) → `ClassificationPolicy.assertValidClassification` → `DeduplicationService` check (409 with candidate id if `type=MEDICINE` and a match exists) → derive `onlineSaleProhibited` → resolve/validate `manufacturerId`/`categoryIds` → persist (status `DRAFT`) → audit → emit `catalog.product.created`.
- 201: created product (full detail shape). Errors: `422 VALIDATION_ERROR` (including a missing `manufacturerId` when `type = MEDICINE`, field `manufacturerId`), `409 CATALOG_DUPLICATE_PRODUCT`, `404 MANUFACTURER_NOT_FOUND`, `404 CATEGORY_NOT_FOUND`.

**`PATCH /admin/catalog/products/:id`**
- Body: `UpdateProductDto` (§4.1, `type` omitted).
- Re-runs `ClassificationPolicy` if `rxClassification`/`controlledSchedule` changes; re-runs dedup check if any dedup-key field changes.
- 200: updated product. Errors: `422 VALIDATION_ERROR`, `404 NOT_FOUND`, `409 CATALOG_DUPLICATE_PRODUCT`, `404 MANUFACTURER_NOT_FOUND`/`CATEGORY_NOT_FOUND`.
- Emits `catalog.product.updated`; if `rxClassification`/`controlledSchedule` changed, additionally emits `catalog.product.classification_changed` (distinct event so Module 04/05 can react specifically to compliance-relevant changes without parsing a generic "updated" diff — matches the parent doc's event list, §9 domain-event-catalog).

**`POST /admin/catalog/products/:id/status`**
- Body: `ChangeProductStatusDto` (§4.2). Legal targets: `ACTIVE`, `DEPRECATED`, `DELISTED`, `DRAFT` (the last only reachable from `DELISTED`, §3.6 invariant 6).
- State-machine-checked (§3.6.6) → `422 INVALID_PRODUCT_STATUS_TRANSITION` on illegal transition (e.g. `DELISTED → ACTIVE` directly).
- 200: updated product. Emits `catalog.product.status_changed`.

**`CRUD /admin/catalog/categories`** — `POST`, `GET` (admin variant returns inactive too), `PATCH`, and a `DELETE` that is actually a soft-disable (`isActive = false`, blocked with `409 CATEGORY_HAS_PRODUCTS` if active products still reference it, mirroring Module 02's careful default-address deletion sequencing rather than allowing dangling references).

**`CRUD /admin/catalog/manufacturers`** — standard create/list/update; no delete in Slice 1 (set `status = INACTIVE` instead, consistent with "no hard delete" posture, §3.6.7).

**Representative errors (new, catalog-specific):** `CATALOG_DUPLICATE_PRODUCT` (409), `INVALID_PRODUCT_STATUS_TRANSITION` (422), `MANUFACTURER_NOT_FOUND` (404), `CATEGORY_NOT_FOUND` (404), `CATEGORY_CYCLE_DETECTED` (422), `CATEGORY_HAS_PRODUCTS` (409), `INVALID_CLASSIFICATION` (422 — raised by `ClassificationPolicy` for the MEDICINE/HEALTH_PRODUCT×rxClassification mismatch, distinct from generic `VALIDATION_ERROR` since it's a cross-field domain rule, not a single-field DTO check).
**Reused, unchanged:** `VALIDATION_ERROR`, `NOT_FOUND`, `UNAUTHENTICATED`, `FORBIDDEN`, `CONFLICT` (generic, e.g. manufacturer name uniqueness), `INTERNAL_ERROR`.

---

## 9. Domain Events Emitted

Add `CatalogEventType` in `modules/catalog/domain/events.ts`, mirroring Module 02's `ProfilesEventType` pattern exactly (`createDomainEvent` helper, one factory function per event):
```ts
export const CatalogEventType = {
  ProductCreated: 'catalog.product.created',
  ProductUpdated: 'catalog.product.updated',
  ProductClassificationChanged: 'catalog.product.classification_changed',
  ProductStatusChanged: 'catalog.product.status_changed',
  CategoryCreated: 'catalog.category.created',
  CategoryUpdated: 'catalog.category.updated',
} as const;
```
- These map directly to the domain-event-catalog's Module 03 row (`ProductCreated`/`ProductUpdated`, `ProductClassificationChanged`) — `ProductMerged` and `ProductProposalApproved` are correctly **not** implemented yet since their source features (equivalence merge, proposals) are deferred (§0.2); adding their event *names* now with no producer would violate "contracts first" (define a contract only when its producer exists).
- **Unlike Module 02's original (pre-hardening) stance, this slice ships the outbox pattern from day one**, per the closure note now recorded in `backend/docs/02-profiles-spec.md` §0 — every mutating command writes state + audit + outbox event in one Serializable transaction, using the exact same `IUnitOfWork` / `runWithDefaultAddressRetry`-equivalent pattern (renamed appropriately, e.g. `runWithDedupRetry`, since Catalog's retryable conflict source is the dedup unique index (§6.2) rather than a default-address index, but the mechanism — catch `P2002`/`P2034`/`40001`/`40P01`, retry up to 5 times, else `409 CONFLICT` — is identical). This is a **deliberate deviation from the parent design doc's original "no outbox needed yet" framing for Module 03** (it never explicitly said that, but by analogy to Module 02's original slice doc) — codified here upfront specifically because Module 02 proved retrofitting it later is more expensive than building it in from the start.
- Real consumers (Module 04/05/14) don't exist yet — events are published now so those modules can subscribe later without a Module 03 change, same "contracts first" rationale as Module 02 §9.

---

## 10. NestJS Module Layout

Per `00-shared-conventions.md` §13 and the parent doc's §8 folder sketch, refined to Slice 1's actual scope:

```
backend/src/modules/catalog/
  domain/
    entities/               Product, Category, Manufacturer (framework-free)
    value-objects/          GenericName, BrandName, Strength, DosageForm, AtcCode, LocalizedText
    events.ts                CatalogEventType + factory functions (mirrors profiles/domain/events.ts)
    enums.ts                 re-export Prisma enums (ProductType, RxClassification, ControlledSchedule,
                              StorageRequirement, ProductStatus, CategoryAppliesTo) + Slice-1 allowlists
                              (DOSAGE_FORM_ALLOWLIST, STRENGTH_UNIT_ALLOWLIST)
    errors.ts                CatalogErrors (mirrors profiles/domain/errors.ts pattern)
    repositories/            IProductRepository, ICategoryRepository, IManufacturerRepository
    services/                classification-policy.ts, dedup-key.ts (pure predicate)
  application/
    commands/                CreateProductCommand, UpdateProductCommand, ChangeProductStatusCommand,
                              CreateCategoryCommand, UpdateCategoryCommand, DisableCategoryCommand,
                              CreateManufacturerCommand, UpdateManufacturerCommand
    queries/                 SearchProductsQuery, GetProductQuery, GetCategoryTreeQuery,
                              ListProductsByCategoryQuery, ListManufacturersQuery (admin)
    ports/                   UNIT_OF_WORK (IUnitOfWork — local copy, same rationale as Module 02 §2)
    support/                 dedup-conflict.ts (retry wrapper, mirrors profiles/application/support)
  infrastructure/
    persistence/
      prisma-product.repository.ts
      prisma-category.repository.ts
      prisma-manufacturer.repository.ts
      prisma-unit-of-work.ts    (Serializable transactions, same as Module 02)
  interface/
    http/
      controllers/           CatalogController (public), AdminCatalogController
      dtos/                  product.dto.ts, category.dto.ts, manufacturer.dto.ts
  catalog.module.ts           composition root; registers controllers + providers; NO new APP_GUARD
                               (guards are already global from IdentityModule)
```

Register in `app.module.ts`:
```ts
imports: [SharedModule, HealthModule, IdentityModule, ProfilesModule, CatalogModule],
```

---

## 11. Edge Cases

| # | Scenario | Expected behavior |
| --- | --- | --- |
| 1 | `POST /admin/catalog/products` with `type: HEALTH_PRODUCT` and `rxClassification: 'OTC'` | `422 INVALID_CLASSIFICATION` — health products must not carry an Rx classification. |
| 2 | `POST /admin/catalog/products` with `type: MEDICINE` and no `rxClassification` | `422 VALIDATION_ERROR`, field `rxClassification`. |
| 3 | `POST /admin/catalog/products` with `controlledSchedule: PROHIBITED` | Persists with `onlineSaleProhibited: true` regardless of any client-sent value for that field (field is rejected by `forbidNonWhitelisted` since it's not in the DTO at all). |
| 4 | `POST /admin/catalog/products` duplicating an existing `MEDICINE`'s generic+strength+form+manufacturer | `409 CATALOG_DUPLICATE_PRODUCT` with the existing product's id in `details`; no row persisted. |
| 5 | Two concurrent `POST /admin/catalog/products` for the exact same medicine | DB partial unique index (§6.2) lets exactly one commit; the loser's transaction retries against the now-committed state and returns `409 CATALOG_DUPLICATE_PRODUCT` (not a 500) — same pattern as Module 02 edge case 8. |
| 6 | `PATCH /admin/catalog/products/:id` attempts to send `type` | `422 VALIDATION_ERROR` via `forbidNonWhitelisted` (`type` absent from `UpdateProductDto`). |
| 7 | `POST /admin/catalog/products/:id/status` with `DELISTED → ACTIVE` (direct) | `422 INVALID_PRODUCT_STATUS_TRANSITION` — must go through `DELISTED → DRAFT`, then `DRAFT → ACTIVE`. |
| 7a | `POST /admin/catalog/products/:id/status` with `DELISTED → DRAFT` | `200` — legal recovery transition (§3.6 invariant 6, resolved §14.3); product becomes editable again and must go through the normal `DRAFT → ACTIVE` review to be re-published. |
| 8 | `POST /admin/catalog/categories` with a `parentId` that would create a cycle | `422 CATEGORY_CYCLE_DETECTED`. |
| 9 | `PATCH /admin/catalog/categories/:id` (disable) on a category with active product associations | `409 CATEGORY_HAS_PRODUCTS`. |
| 10 | `GET /catalog/products/:id` for a `DRAFT` or `DELISTED` product, unauthenticated | `404 NOT_FOUND` (never leaks existence/status of non-public products, same "no existence leak" posture as Module 02 §7.3, generalized here from ownership to publication-status). |
| 11 | `GET /catalog/products?q=amox` | `ILIKE`/trigram match against `genericName`/`brandName`/localized names, `ACTIVE` only, paginated. |
| 12 | `POST /admin/catalog/products` sends `equivalenceGroupId` or `beneficiaryId`-style out-of-scope field | `422 VALIDATION_ERROR` via `forbidNonWhitelisted`. |
| 13 | Non-admin authenticated user calls any `/admin/catalog/*` route | `403 FORBIDDEN` (permission-level denial, distinct from the `404`s used for non-public product visibility). |
| 14 | `POST /admin/catalog/products` with `type: MEDICINE` and no `manufacturerId` | `422 VALIDATION_ERROR`, field `manufacturerId` (§3.6 invariant 8, resolved §14.6). |

---

## 12. Security & Privacy Requirements

- **AuthN/AuthZ**: admin routes behind `JwtAuthGuard` + `PermissionsGuard` + `@RequirePermissions('catalog:manage:any')`; public routes intentionally open (no PII, no user-scoped data — a materially different privacy posture than Module 02, which is why this is safe here and would not be for profile/address data).
- **No PII/health-sensitive fields in this slice.** Product metadata is not personal data — none of Module 02's field-level-encryption or "never log X" rules apply here. `warnings`/`descriptions` are general medical-reference text, not patient-specific health data (per `00-shared-conventions.md` §11's "health-sensitive fields" scoping, same reasoning Module 02 used to justify no encryption on its own tables).
- **Compliance-sensitive fields** (`rxClassification`, `controlledSchedule`, `onlineSaleProhibited`) get **every mutation audited**, since these are exactly the "classification/eligibility changes" `00-shared-conventions.md` §4 calls out as must-audit.
- **Audit logging** (via `AuditService`, reused as-is):

| Action | `action` value | `resourceType` | `resourceId` | `context` |
| --- | --- | --- | --- | --- |
| Product created | `PRODUCT_CREATED` | `Product` | product id | `{ type, rxClassification, controlledSchedule }` |
| Product updated | `PRODUCT_UPDATED` | `Product` | product id | `{ fields: [...] }` (field names only) |
| Classification changed | `PRODUCT_CLASSIFICATION_CHANGED` | `Product` | product id | `{ from: {rx, schedule}, to: {rx, schedule} }` |
| Status changed | `PRODUCT_STATUS_CHANGED` | `Product` | product id | `{ from, to, reason }` |
| Category created/updated/disabled | `CATEGORY_CREATED`/`CATEGORY_UPDATED`/`CATEGORY_DISABLED` | `Category` | category id | `{ fields }` / `{ slug }` |
| Manufacturer created/updated | `MANUFACTURER_CREATED`/`MANUFACTURER_UPDATED` | `Manufacturer` | manufacturer id | `{ name }` |

- **Rate limiting**: not implemented in Slice 1, same posture as Module 02 — public search is read-only and cacheable, admin writes are low-volume and already permission-gated.

---

## 13. Error Codes

Add to `shared/errors/error-codes.ts` (append-only, matching the exact pattern Module 02 used):
```ts
// Module 03 — Catalog (see backend/docs/03-catalog-spec.md §13). Appended per the
// Phase-0 freeze exception, same rationale as the Module 01/02 codes above.
CATALOG_DUPLICATE_PRODUCT = 'CATALOG_DUPLICATE_PRODUCT',
INVALID_PRODUCT_STATUS_TRANSITION = 'INVALID_PRODUCT_STATUS_TRANSITION',
MANUFACTURER_NOT_FOUND = 'MANUFACTURER_NOT_FOUND',
CATEGORY_NOT_FOUND = 'CATEGORY_NOT_FOUND',
CATEGORY_CYCLE_DETECTED = 'CATEGORY_CYCLE_DETECTED',
CATEGORY_HAS_PRODUCTS = 'CATEGORY_HAS_PRODUCTS',
INVALID_CLASSIFICATION = 'INVALID_CLASSIFICATION',
```
HTTP mapping: `CATALOG_DUPLICATE_PRODUCT`→409, `INVALID_PRODUCT_STATUS_TRANSITION`→422, `MANUFACTURER_NOT_FOUND`→404, `CATEGORY_NOT_FOUND`→404, `CATEGORY_CYCLE_DETECTED`→422, `CATEGORY_HAS_PRODUCTS`→409, `INVALID_CLASSIFICATION`→422.
Reused, unchanged: `VALIDATION_ERROR` (422), `NOT_FOUND` (404), `UNAUTHENTICATED` (401), `FORBIDDEN` (403), `CONFLICT` (409, generic uniqueness e.g. manufacturer name), `INTERNAL_ERROR` (500).

---

## 14. Architect Review — Resolved Decisions

This section originally listed 7 open questions. All were resolved by formal Architect review (see review notes referenced inline); each resolution has been folded into the relevant section above. Kept here, restated as decisions, for traceability.

1. **Public-route auth posture — RESOLVED.** `PermissionsGuard`/`JwtAuthGuard` are registered as global `APP_GUARD`s (per Module 02 §2's confirmation). Verified directly against `src/modules/identity/interface/guards/jwt-auth.guard.ts` and `src/shared/rbac/permissions.guard.ts`: `JwtAuthGuard` short-circuits entirely on `@Public()`, and `PermissionsGuard` no-ops when a handler carries no `@RequirePermissions` metadata. **Decision:** every public Catalog read handler gets a bare `@Public()` and nothing else — no second guard, no empty `@RequirePermissions()` allow-list, and `catalog:read:any` (§7.1) stays reserved/unused, never attached to a route in this slice. This is the identical pattern already used in production by `auth.controller.ts`'s `login`/`register`/`refresh` handlers.
2. **`HEALTH_PRODUCT` dedup exemption (§3.6.4) — RESOLVED.** Accepted as specified: no dedup enforcement for `HEALTH_PRODUCT` in Slice 1. Rationale: no reliable "strength" concept across wellness/device SKUs, and duplicate health-product listings are a catalog-quality concern, not the patient-safety concern BR-CAT-08/dedup is primarily protecting against for medicines. A lighter key (e.g., `brandName + manufacturerId`) is not introduced speculatively; revisit only if real duplicate spam is observed in practice (candidate for Slice 2).
3. **`DELISTED` reversibility (§3.6.6) — RESOLVED, spec changed.** `DELISTED` is **not** fully terminal. Added `DELISTED → DRAFT` as a legal transition (§3.6 invariant 6, §4.2, §8.2, §11 edge case 7a); `DELISTED → ACTIVE` remains illegal — reactivating still requires the normal `DRAFT → ACTIVE` transition, preserving the "fresh review before going public again" intent without leaving an accidental delist unrecoverable short of a manual DB fix.
4. **Health-product dedup key, restated — RESOLVED.** Same answer as #2: no dedup enforcement, no alternate key introduced in Slice 1.
5. **Search latency budget — RESOLVED.** `ILIKE`/`pg_trgm` (§5) is accepted for Slice 1 launch volume. Cross-checked against the platform-wide NFR-PERF-01 target used consistently elsewhere in the architecture docs (≤2s p95, see `architecture/module-14-search-discovery.md` §2/§8) — trigram search on a young, small `products` table clears that target comfortably. No `tsvector` build-out needed now; still tracked as a Module 14 hand-off per §5.
6. **`manufacturerId IS NULL` dedup gap (§6.2) — RESOLVED, spec changed.** The gap is **closed**, not accepted: `manufacturerId` is now required at the business-rule level for `type = MEDICINE` (§3.1, §3.6 invariant 8, §4.1, §8.2, §11 edge case 14, §16.2), using the same DTO-optional/command-required enforcement split already used for `rxClassification`. Every `MEDICINE` row that can reach the partial unique index therefore always has a non-null `manufacturerId`, so the `NULL <> NULL` collision gap cannot occur. `HEALTH_PRODUCT` rows are unaffected (exempt from dedup entirely, decision #2) and may still omit it.
7. **Category product listing recursion (§8.1) — RESOLVED.** `GET /catalog/categories/:id/products` returns **direct assignments only**, not recursively into subcategories, for Slice 1. Simplest correct choice for the first slice; no correctness or compliance risk; recursive listing is deferred to a later slice.

**ADR impact:** none. All resolutions reuse existing, already-approved infrastructure (Module 01's guards/decorators, the existing raw-SQL partial-unique-index migration pattern from Module 02) or are local business-rule tightenings scoped to this module. No `architecture/00-decision-log.md` entry is required. (Optional process improvement, not a blocker: the "@Public()-only, no permission decorator" pattern is worth documenting once in `architecture/00-shared-conventions.md` since Modules 09/10/14 will need the same public-read pattern soon.)

---

## 15. Acceptance Criteria (Given/When/Then)

**AC-1 (BR-CAT-03, F-CAT-03).**
*Given* an admin, *when* they `POST /admin/catalog/products` with `type: MEDICINE` and no `rxClassification`, *then* the response is `422 VALIDATION_ERROR` and no row is persisted; *when* they resend with `rxClassification: 'RX'`, *then* the response is `201` and `GET /catalog/products/{id}` (as admin) returns it with `rxClassification: 'RX'`.

**AC-2 (BR-CAT-04, BRULE-13).**
*Given* an admin, *when* they create a product with `controlledSchedule: 'PROHIBITED'`, *then* the stored/returned `onlineSaleProhibited` is `true` even though the client never sent that field.

**AC-3 (BR-CAT-08, dedup).**
*Given* an existing `ACTIVE` medicine, *when* an admin `POST`s an identical generic+strength+form+manufacturer combination, *then* the response is `409 CATALOG_DUPLICATE_PRODUCT` with the existing product's id, and the database never ends up with two matching rows (verified by a concurrency test, §16).

**AC-4 (public visibility).**
*Given* a `DRAFT` product, *when* an unauthenticated client calls `GET /catalog/products/{id}`, *then* the response is `404 NOT_FOUND`; *when* the admin transitions it to `ACTIVE`, *then* the same unauthenticated call returns `200`.

**AC-5 (status state machine).**
*Given* a `DELISTED` product, *when* an admin attempts `POST .../status { status: 'ACTIVE' }` (direct), *then* the response is `422 INVALID_PRODUCT_STATUS_TRANSITION` and the product remains `DELISTED`; *when* the admin instead sends `POST .../status { status: 'DRAFT' }`, *then* the response is `200`, the product becomes `DRAFT`, and it is only public again after a subsequent, separate `DRAFT → ACTIVE` transition (§3.6 invariant 6).

**AC-6 (audit trail).**
*Given* any successful mutating admin call in this slice, *when* it completes, *then* exactly one new `audit_logs` row exists with the correct `action`/`resourceType`/`resourceId` and a valid hash chain (`prevHash` matches the prior row's `hash`) — same verification method as Module 02 AC-6.

**AC-7 (atomicity, per §9's outbox-from-day-one decision).**
*Given* a simulated outbox failure injected after the state mutation but before commit (same technique as `test/profiles/atomicity.e2e-spec.ts`), *when* `POST /admin/catalog/products` is called, *then* no `Product` row, no `audit_logs` row, and no `outbox` row are persisted — full rollback, no partial state.

---

## 16. QA Test Scenarios

### 16.1 Functional
- Create a `MEDICINE` product with full metadata → `201`, all fields round-trip via `GET`.
- Create a `HEALTH_PRODUCT` with no `rxClassification` → `201`.
- Update a product's `descriptionEn` only → `200`, other fields unchanged.
- Transition `DRAFT → ACTIVE → DEPRECATED` → each transition succeeds; `DEPRECATED` product still readable at `GET /catalog/products/{id}` but excluded from `GET /catalog/products` search.
- Create a category tree 3 levels deep; `GET /catalog/categories` returns the correctly nested structure.
- Assign a product to 2 categories; `GET /catalog/categories/{id}/products` returns it for both.
- Search by partial generic name (typo-tolerant via trigram) → returns the expected product.

### 16.2 Negative / validation
- `type: MEDICINE` + `rxClassification` omitted → `422 VALIDATION_ERROR`.
- `type: HEALTH_PRODUCT` + `rxClassification: 'OTC'` → `422 INVALID_CLASSIFICATION`.
- `type: MEDICINE` + `manufacturerId` omitted → `422 VALIDATION_ERROR`, field `manufacturerId` (§3.6 invariant 8).
- `type: HEALTH_PRODUCT` + `manufacturerId` omitted → `201` (allowed; only `MEDICINE` requires it).
- `manufacturerId` referencing a non-existent id → `404 MANUFACTURER_NOT_FOUND`.
- `categoryIds` containing one non-existent id → `404 CATEGORY_NOT_FOUND`, none of the valid ones partially applied.
- Duplicate medicine create → `409 CATALOG_DUPLICATE_PRODUCT`.
- `PATCH` with empty body `{}` → `422 VALIDATION_ERROR`.
- `PATCH` attempting to set `type` → `422 VALIDATION_ERROR` (`forbidNonWhitelisted`).
- Category `parentId` creating a cycle → `422 CATEGORY_CYCLE_DETECTED`.
- Disable a category still referenced by an active product → `409 CATEGORY_HAS_PRODUCTS`.
- Illegal status transition (`DELISTED → ACTIVE`, direct) → `422 INVALID_PRODUCT_STATUS_TRANSITION`.
- Legal recovery transition (`DELISTED → DRAFT`) → `200`, product returns to `DRAFT` and is no longer publicly visible until re-approved via `DRAFT → ACTIVE`.

### 16.3 Edge / concurrency
- Fire two concurrent `POST /admin/catalog/products` for the identical medicine → exactly one succeeds `201`; the other gets `409 CATALOG_DUPLICATE_PRODUCT`, never a `500` (mirrors Module 02 §16.3's default-address concurrency test, using the dedup index instead).
- Fire the poisoned-outbox atomicity test (AC-7) for `CreateProductCommand`, `UpdateProductCommand`, and `ChangeProductStatusCommand` — each must roll back completely.
- Soft-visibility check: confirm `DRAFT`/`DELISTED` products never appear in `GET /catalog/products` search results even when `q` matches exactly.

### 16.4 Security / access control
- Unauthenticated request to any `/admin/catalog/*` route → `401 UNAUTHENTICATED`.
- Authenticated `CUSTOMER` (no `catalog:manage:any`) attempting `POST /admin/catalog/products` → `403 FORBIDDEN`.
- Unauthenticated `GET /catalog/products` and `GET /catalog/products/{id}` (for an `ACTIVE` product) → both `200` (confirms public reads truly need no token).
- Confirm audit `context` for `PRODUCT_UPDATED` contains only field **names**, never field **values** (same discipline as Module 02 §16.4).

### 16.5 Regression / integration
- Confirm `ProfilesModule`/`IdentityModule` routes are unaffected after `CatalogModule` registration in `app.module.ts` (no guard-ordering regressions — same regression class Module 02 §16.5 checked for).
- Confirm the existing `catalog:manage:org` permission (reserved for the future pharmacy-proposal slice) is untouched and not accidentally granted `any`-scope capability.

---

## 17. Test Strategy & Definition of Done

Following `00-implementation-roadmap.md` §5 and the proof-of-pattern established in Module 02:
- **Domain unit tests**: `ClassificationPolicy`, dedup-key predicate, category-cycle detection, status-transition state machine — pure, no DB, highest coverage.
- **Application/command unit tests**: one spec per command with repositories/uow/audit/outbox mocked (mirrors `create-address.command.spec.ts` etc.) — verify orchestration order and emitted events, not real persistence.
- **Integration/E2E tests** (`test/catalog/*.e2e-spec.ts`, real Postgres via Testcontainers, same harness as `test/profiles/*`): product CRUD, category CRUD, manufacturer CRUD, search/filter, status transitions, dedup concurrency, and a dedicated `atomicity.e2e-spec.ts` mirroring Module 02's poisoned-outbox technique.
- **Contract tests**: every emitted `catalog.*` event validated against `00-domain-event-catalog.md`'s Module 03 row.
- **DoD (module gate, mirrors `backend/docs/02-profiles-spec.md`'s closure bar):** all unit + e2e suites green; `npm run build` clean; every mutating endpoint permission-guarded (or explicitly, deliberately public) and audited; every mutation atomic (state+audit+outbox in one Serializable transaction with a bounded retry, never an unhandled 500 under contention); no schema drift from what's documented in §6; QA exit review produced in the same format as the Module 02 exit review before Module 04 begins.

---

## 18. Dependencies & Vertical Slice Plan

- **Upstream dependency:** Module 01 (Identity/RBAC) only — already implemented, no new coupling introduced.
- **No dependency on Module 02** — confirmed in §2; Catalog and Profiles are independent siblings under Phase 0/1.
- **Downstream consumers (not built yet, contracts-first per §9):**
  - **Module 04 (Pharmacy/Inventory)** — will hold `listings` that reference `Product.id` by scalar UUID (ADR-002, no Prisma relation), and will subscribe to `catalog.product.classification_changed`/`catalog.product.status_changed` to gate/hide listings for delisted or newly-controlled products.
  - **Module 05 (Prescription/Matching)** — will read `rxClassification`/`onlineSaleProhibited` via a query port to gate Rx-required checkout flows.
  - **Module 14 (Search)** — will eventually project `catalog.product.*` events into its own CQRS read model, superseding this slice's direct `pg_trgm` search for cross-entity ranked results; Slice 1's search is not wasted work, it's what Module 04/05 development uses in the interim and what Module 14 replaces later without a Catalog-side change (events are already the right contract).
- **Frontend (web portal / mobile) vertical-slice mapping:**
  - **Admin/Portal (`web`)**: a new "Catalog" section (product list/detail/create/edit forms, category tree manager, manufacturer list) calling `/api/v1/admin/catalog/*` — this is the first real feature wiring `web` to the live backend beyond Identity (per the QA assessment's `GAP-WEB-002`, `web` currently only calls mock services). Recommend this be the concrete vehicle that finally closes that gap, rather than opening a separate frontend-wiring effort.
  - **Customer app (`app`)**: the existing local mock medicine-search/browse UI (per the QA assessment, currently client-side mock data) becomes wireable to `GET /catalog/products`/`GET /catalog/products/{id}` for the first time — with real product identity, names, classification, images-when-available, and the **reference price** on the detail read (`Product.price`, nullable). Per-pharmacy *selling* price and stock still come from Module 04 + Search, and the list/search projection remains deliberately price-free.
  - Both frontend integrations are **out of scope for this backend slice's own DoD** (§17) but are the natural next PRs once this slice ships, and should be tracked as explicit follow-up tickets so the "GAP-WEB-002" class of unwired-UI risk doesn't recur for Catalog the way it did for Identity.

---

## 19. Traceability Summary

| Requirement | Where addressed |
| --- | --- |
| BR-CAT-01/02 (name/form/strength/details) | §3.1, §4.1 |
| BR-CAT-03/04 (Rx/OTC, controlled) | §3.6.1/2, §9 AC-1/AC-2 |
| BR-CAT-05 (categories) | §3.2, §8.1/8.2 |
| BR-CAT-08 (dedup/moderation) | §3.6.4, §6.2, AC-3 |
| BR-CAT-09 (search/filter) | §5, §8.1 |
| BR-CAT-10 (manufacturer metadata) | §3.3, §8.2 |
| FR-CAT-01..06 | §3.1, §8.2 |
| FR-MET-01..06 | §3.1 (partial — ingredients deferred, §0.2) |
| FR-TAX-01..03 | §3.2 (partial — tags deferred, §0.2) |
| NFR-PERF-01 | §5, §14.5 |
| NFR-COMP-02/03/05 | §3.6.1/2, §12 |

---

**Next step:** Architect review is complete (§14) and the spec is **READY FOR IMPLEMENTATION**. Implementation proceeds per the folder layout in §10, in the order: domain → application → infrastructure → interface → tests (per `00-implementation-roadmap.md` §1 and §5), following the exact hardening pattern (transactional outbox, audit-in-transaction, Serializable isolation, bounded retry) already proven in Module 02.
