# Module 3 — Catalog (Design Document)

**Product:** PharmaLink Ethiopia — Digital Healthcare Marketplace
**Module:** 03 — Catalog (Medicines, Healthcare Products, Drug Metadata, Rx/OTC Classification)
**Status:** Design — Approved for implementation reference
**Architecture style:** Modular Monolith (NestJS) · Clean Architecture · DDD · SOLID
**Depends on:** Module 01 (Identity/RBAC). Consumed by: Pharmacy/Inventory, Cart/Order, Prescription, Search.
**Traceability:** FR-MED-01..10, FR-PRV-05, FR-PRV-06, FR-ADM-11, BRULE-10, BRULE-13, BRULE-15, BRULE-16, NFR-PERF-01, NFR-COMP-02/03/05, NFR-INTEROP

> Single source of truth for the Catalog bounded context. No implementation code — contracts, schemas, flows, and reasoning only.

---

## 1. Module Objectives

The Catalog is the **shared product master** of the marketplace. It answers: *what products exist, what are their clinical/commercial attributes, and are they prescription-only or controlled?*

**Critical architectural distinction — Catalog vs Inventory.**
- **Catalog (this module)** owns the **global, canonical product master**: the definition of a medicine/product independent of any pharmacy — name, generic (INN), form, strength, ATC class, Rx/OTC flag, controlled-substance flag, images, descriptions. **One product = one catalog record**, curated/moderated centrally.
- **Inventory (Module 4, Pharmacy)** owns **per-pharmacy listings**: which pharmacy stocks a catalog product, at what **selling** price, quantity, batch, and expiry.

**Two distinct prices, two distinct owners.** Pricing is deliberately split across these two modules, and the two values must never be conflated:

| Concept | Field | Owner | Meaning |
| --- | --- | --- | --- |
| **Reference price** | `Product.price` (`products.price`) | **Catalog (this module)** | The platform-wide reference/list price for the canonical product, independent of any pharmacy. Integer ETB minor units (`00-shared-conventions.md` §11 — money is never a float). **Nullable:** `null` means the product is *not currently priced*, therefore not purchasable — never "free". |
| **Selling price** | `InventoryListing.price` | **Inventory (Module 4)** | What one specific pharmacy branch charges for its own listing of that product. Set per pharmacy, changeable per pharmacy, audited per pharmacy (module-04 §13). |

Catalog owns the reference price **only**. It has no authority over, and no visibility into, what any individual pharmacy charges — a listing can set its own selling price freely and can never write back to `Product.price`.

This separation is the backbone of **intelligent pharmacy matching** (FR-MATCH): because every pharmacy references the *same* catalog product ID, we can compare stock/selling price across pharmacies for an identical medicine. It also enforces consistency (one authoritative Rx/OTC and controlled flag per drug, not per pharmacy) — essential for compliance (BRULE-10, BRULE-13).

**Primary objectives**
- Maintain a **canonical, deduplicated product master** for medicines and healthcare/wellness products (FR-MED-03, FR-MED-09).
- Authoritatively classify **Rx vs OTC** and **controlled/narcotic** status (FR-MED-04, BRULE-10, BRULE-13).
- Model rich **drug metadata** (generic name, strength, form, ATC, manufacturer) enabling brand↔generic search and substitution (FR-MED-01, FR-MED-06, BRULE-16).
- Provide fast, filterable **read models for search** (FR-MED-01/02/07, NFR-PERF-01).
- Support **central curation + moderation** and pharmacy catalog contributions with approval (FR-PRV-05, FR-ADM-11).

---

## 2. Business Requirements

| ID | Business Requirement | Source |
| --- | --- | --- |
| BR-CAT-01 | The catalog shall define medicines by brand and generic (INN) name. | FR-MED-01 |
| BR-CAT-02 | Each product shall record form, strength, and descriptive details. | FR-MED-03 |
| BR-CAT-03 | Each medicine shall be authoritatively classified as Rx or OTC. | FR-MED-04, BRULE-10 |
| BR-CAT-04 | Controlled/narcotic substances shall be flagged and handled per regulation or excluded from online sale. | FR-MED-04, BRULE-13, NFR-COMP-03 |
| BR-CAT-05 | The catalog shall support categories for medicines and health/wellness products. | FR-MED-09 |
| BR-CAT-06 | The catalog shall support generic/therapeutic equivalence to enable substitutes. | FR-MED-06, BRULE-16 |
| BR-CAT-07 | Pharmacies shall manage listings that reference catalog products; bulk import supported. | FR-PRV-05, FR-PRV-06 |
| BR-CAT-08 | The catalog shall be centrally moderated to prevent duplicates and unsafe listings. | FR-ADM-11 |
| BR-CAT-09 | The catalog shall expose fast search/filter reads (name, category, price band context). | FR-MED-01/02/07 |
| BR-CAT-10 | The catalog shall record manufacturer and, where feasible, sourcing/batch traceability metadata. | NFR-COMP-05 |
| BR-CAT-11 | Only products with valid (non-expired) stock shall be offered — enforced at listing/matching using catalog + inventory. | BRULE-15 |

---

## 3. Functional Requirements (Module Features)

### 3.1 Product Master
- **F-CAT-01** Create/edit a **canonical product** (medicine or health product) with full metadata.
- **F-CAT-02** Distinguish product type: `MEDICINE` vs `HEALTH_PRODUCT` (wellness, devices, supplies).
- **F-CAT-03** Rx/OTC classification (authoritative, medicine only).
- **F-CAT-04** Controlled-substance classification + regulatory schedule; option to mark `ONLINE_SALE_PROHIBITED` (BRULE-13).
- **F-CAT-05** Multi-image support (via Cloud Storage refs), localized names/descriptions (am/en).
- **F-CAT-06** Deduplication: detect near-duplicate products on create (name+strength+form+manufacturer).

### 3.2 Drug Metadata & Classification
- **F-MET-01** Generic name (INN), brand name(s), manufacturer, country of origin.
- **F-MET-02** Dosage form (tablet, capsule, syrup, injection, cream…), strength (value+unit), pack size.
- **F-MET-03** ATC code / therapeutic class for classification and equivalence.
- **F-MET-04** Active ingredient(s) list (composition) for multi-ingredient products.
- **F-MET-05** Storage requirements flag (e.g., cold-chain / temperature-sensitive) — feeds delivery rule BRULE-30.
- **F-MET-06** Usage notes, warnings, contraindications (informational; not medical advice).

### 3.3 Categories & Taxonomy
- **F-TAX-01** Hierarchical categories (e.g., Medicines → Antibiotics; Health → Vitamins).
- **F-TAX-02** Assign product to one or more categories; manage taxonomy (admin).
- **F-TAX-03** Tags/keywords for search relevance (including Amharic synonyms).

### 3.4 Equivalence & Substitution
- **F-EQV-01** Group products by generic equivalence (same INN + strength + form).
- **F-EQV-02** Provide substitution candidates for a given product (BRULE-16, FR-MED-06).
- **F-EQV-03** Flag therapeutic (non-identical) alternatives distinctly from generic-equivalent.

### 3.5 Curation, Moderation & Contribution
- **F-MOD-01** Central admin CRUD on the product master.
- **F-MOD-02** Pharmacy-proposed products enter a **moderation queue** (avoid duplicate/unsafe entries) — FR-ADM-11.
- **F-MOD-03** Approve/reject/merge proposed products (merge de-dupes into canonical).
- **F-MOD-04** Product lifecycle: `DRAFT → PENDING_REVIEW → ACTIVE → DEPRECATED/DELISTED`.
- **F-MOD-05** Bulk import/update via CSV/spreadsheet with validation + dry-run (supports FR-PRV-06 at catalog level).

### 3.6 Search Read Model
- **F-SRCH-01** Search by brand or generic name (FR-MED-01), typo-tolerant.
- **F-SRCH-02** Filter by category, type, Rx/OTC, manufacturer (FR-MED-02).
- **F-SRCH-03** Return catalog data + aggregated availability signals (min price, nearest-stock) computed with Inventory (FR-MED-05/08) — Catalog exposes product data; availability is joined by the Search module.
- **F-SRCH-04** Sort by relevance; distance/price/rating applied by Search using inventory data (FR-MED-07).

> **Boundary note (revised — see §1's two-price table).** Catalog owns the **platform reference price** (`Product.price`) and nothing more of the commercial picture: it does **not** own per-pharmacy selling price, and does **not** own stock. Beyond that reference price it exposes product identity + metadata. The **Search & Matching** module composes Catalog + Inventory to produce selling-price/stock/distance-ranked results, and this module's own **browse/list/search projections stay deliberately price-free** (§7.1) — the reference price is served only on the single-product detail read, so list rendering remains cacheable and mostly read-only.
>
> *Reconciliation note.* This note previously read "Catalog does **not** own price or stock," which was written before `products.price` existed and was contradicted once Module 06's checkout began repricing orders from `ICatalogPort.getProduct().price`. The corrected boundary is the one stated above; see `00-decision-log.md` **ADR-015**.

---

## 4. Non-Functional Requirements

| Attribute | Requirement | Design Response |
| --- | --- | --- |
| **Performance** | Search ≤ 2s p95 (NFR-PERF-01) | Denormalized `catalog_search_view`; Redis cache for hot products; search index (Postgres GIN/pg_trgm now, OpenSearch-ready later). |
| **Consistency** | One authoritative Rx/controlled flag per drug (BRULE-10/13) | Single canonical `products` record; pharmacy listings reference it, cannot override classification. |
| **Compliance** | Controlled handling, sourcing traceability (NFR-COMP-03/05) | `controlled_schedule`, `online_sale_prohibited`, manufacturer + batch metadata hooks. |
| **Scalability** | Millions of listings over shared master (NFR-SCAL) | Catalog is read-heavy & cacheable; heavy writes isolated to admin/import; CDN for images. |
| **Maintainability** | Config-driven taxonomy (NFR-MAINT-03) | Categories/tags data-driven, editable without redeploy. |
| **Localization** | am/en names & descriptions (NFR-USE-02) | Localized fields + Amharic search synonyms. |
| **Interoperability** | Future distributor/formulary integration (NFR-INTEROP-03) | Import adapters behind ports; ATC/INN standard coding for interop. |
| **Data quality** | No duplicates, safe listings (BR-CAT-08) | Dedup rules on write + moderation queue + merge. |

---

## 5. Domain Model

### 5.1 Aggregates & Entities
- **Product** (aggregate root) — canonical medicine or health product with metadata, classification, media.
- **Category** (entity) — hierarchical taxonomy node.
- **EquivalenceGroup** (entity) — groups generically-equivalent products (same INN+strength+form).
- **ProductProposal** (entity) — a pharmacy-submitted product pending moderation.
- **Manufacturer** (reference entity) — normalized manufacturer records.

### 5.2 Value Objects
- `GenericName` (INN), `BrandName`, `Strength` (value+unit), `DosageForm` (enum), `PackSize`, `AtcCode`, `RxClassification` (RX|OTC), `ControlledSchedule` (NONE|SCHEDULE_x|PROHIBITED), `Composition` (list of {ingredient, amount}), `LocalizedText` (am/en), `StorageRequirement` (AMBIENT|COLD_CHAIN|CONTROLLED_TEMP), `ReferencePrice` (integer ETB minor units, nullable — see §1).

### 5.3 Invariants
- A `MEDICINE` product **must** carry an `RxClassification`; a `HEALTH_PRODUCT` must not.
- If `ControlledSchedule == PROHIBITED`, product is `online_sale_prohibited=true` and cannot be listed for sale (BRULE-13) — enforced at Inventory listing time via a Catalog check.
- Rx/OTC and controlled classification are **immutable by pharmacies** — only admins/regulatory curation may change them (BRULE-10).
- Two products are duplicates if `generic + strength + form + manufacturer` match → must merge, not coexist.
- An `EquivalenceGroup` contains products sharing `generic + strength + form` (used for substitution, BRULE-16).
- `Product.price`, when present, is a **non-negative integer** in ETB minor units; it is never a float and never negative. `null` is a legitimate state meaning "not priced yet" and is never defaulted to `0` — a product nobody has priced is not purchasable, not free (Module 06's checkout rejects it rather than placing a zero-value order).

**Design rationale — canonical master + equivalence groups.** Modeling equivalence explicitly (rather than inferring at query time) makes substitution deterministic and auditable — the pharmacist and matching engine rely on a curated, safe equivalence set rather than fuzzy string matching, which is safety-critical for medicines.

---

## 6. Database Design (PostgreSQL via Prisma)

UUID v7 PKs, `created_at`/`updated_at`, soft-delete where lifecycle applies.

**products** — canonical product master (aggregate root).
- `id`, `type` (MEDICINE|HEALTH_PRODUCT), `generic_name` (nullable for health products), `brand_name`, `manufacturer_id` (FK), `dosage_form`, `strength_value`, `strength_unit`, `pack_size`, `atc_code` (nullable), `rx_classification` (RX|OTC|NULL), `controlled_schedule` (enum, default NONE), `online_sale_prohibited` (bool), `storage_requirement` (enum), `equivalence_group_id` (FK, nullable), `name_am`, `name_en`, `description_am`, `description_en`, `warnings`, `price` (int minor units, **nullable** — the platform reference price of §1; distinct from `inventory_listings.price`), `status` (DRAFT|PENDING_REVIEW|ACTIVE|DEPRECATED|DELISTED), `created_by`, `created_at`, `updated_at`, `deleted_at`.
- Unique dedup index on (`generic_name`,`strength_value`,`strength_unit`,`dosage_form`,`manufacturer_id`) where type=MEDICINE.

**manufacturers**
- `id`, `name` (unique), `country`, `status`, `created_at`.

**categories** — hierarchical taxonomy.
- `id`, `parent_id` (self-FK, nullable), `slug` (unique), `name_am`, `name_en`, `applies_to` (MEDICINE|HEALTH_PRODUCT|BOTH), `sort_order`, `is_active`.

**product_categories** — M:N products↔categories.
- `product_id` (FK), `category_id` (FK). PK composite.

**product_ingredients** — composition (multi-active-ingredient).
- `id`, `product_id` (FK), `ingredient_name`, `amount_value`, `amount_unit`.

**product_images**
- `id`, `product_id` (FK), `url`, `is_primary`, `sort_order`.

**equivalence_groups**
- `id`, `generic_name`, `strength_value`, `strength_unit`, `dosage_form`, `atc_code` (nullable), `created_at`.
- *Purpose:* substitution candidates (BRULE-16).

**product_tags** — search keywords/synonyms (incl. Amharic).
- `id`, `product_id` (FK), `tag`, `locale`.

**product_proposals** — pharmacy-submitted, pending moderation (FR-ADM-11).
- `id`, `submitted_by_user_id` (FK), `organization_id` (FK, pharmacy), `payload` (jsonb — proposed product data), `status` (PENDING|APPROVED|REJECTED|MERGED), `merged_into_product_id` (FK, nullable), `reviewer_id` (FK, nullable), `reject_reason`, `submitted_at`, `reviewed_at`.

**catalog_search_view** — denormalized read model (materialized view or maintained table).
- Flattened: `product_id`, `type`, display names (am/en), `generic_name`, `brand_name`, `manufacturer_name`, category paths, `rx_classification`, `controlled`, `search_tsv` (tsvector), tags. Refreshed on product change via domain events.

**Relationships (summary)**
- `products N—1 manufacturers`; `products N—1 equivalence_groups`; `products N—N categories`; `products 1—N ingredients/images/tags`.
- `categories 1—N categories` (tree).
- `product_proposals N—1 products` (via merge target).

**Rationale.** The `catalog_search_view` isolates read-optimized denormalization from the normalized write model — Catalog can serve fast, typo-tolerant search (pg_trgm/GIN on `search_tsv`) without complex joins on the hot path, and can later be projected into OpenSearch behind the same query port (NFR-PERF, NFR-SCAL).

---

## 7. API Design

Base paths: `/api/v1/catalog` (public reads), `/api/v1/admin/catalog` (curation), `/api/v1/pharmacy/catalog` (proposals). Envelope + error codes per Module 1 §14.

### 7.1 Public / Customer reads (auth optional; permissive)
- **GET `/catalog/products`** — search & filter. Query: `q, type, categoryId, rx, manufacturerId, sort, page, size`. → paginated product summaries. **Intentionally price-free**: the summary projection carries no `price`, and availability/selling price are added by the Search module joining Inventory. The reference price is served by the detail route below.
- **GET `/catalog/products/{id}`** — full product detail incl. metadata, images, warnings, equivalence group, and the **reference price** (`price`, nullable — §1). This is the only public read that carries a price, and it is the reference price, not any pharmacy's selling price.
- **GET `/catalog/products/{id}/substitutes`** — generic-equivalent + therapeutic alternatives (FR-MED-06).
- **GET `/catalog/categories`** — taxonomy tree.
- **GET `/catalog/categories/{id}/products`** — products in a category.

### 7.2 Admin curation (`catalog:manage` — Admin/Super Admin)
- **POST `/admin/catalog/products`** — create canonical product, optionally with a reference `price`. Dedup check → 409 `CATALOG_DUPLICATE_PRODUCT` with candidate.
- **PATCH `/admin/catalog/products/{id}`** — edit (incl. classification, controlled schedule, reference `price`). Curating the reference price is an admin action on the Catalog aggregate — it is the **only** supported way to set it; nothing outside this module writes `products.price`.
- **POST `/admin/catalog/products/{id}/status`** — lifecycle transition (activate/deprecate/delist).
- **POST `/admin/catalog/products/merge`** — Body `{ sourceId, targetId }` — merge duplicates.
- **CRUD `/admin/catalog/categories`** — manage taxonomy.
- **CRUD `/admin/catalog/manufacturers`**.
- **POST `/admin/catalog/import`** — bulk import (CSV) with `dryRun` flag → validation report.
- **GET `/admin/catalog/proposals`** — moderation queue.
- **POST `/admin/catalog/proposals/{id}/approve|reject|merge`** — Body includes reason / merge target. Audited.

### 7.3 Pharmacy contribution (`catalog:propose:org` — Pharmacy Owner/Manager)
- **POST `/pharmacy/catalog/proposals`** — propose a product not yet in the master. → 202 `PENDING`.
- **GET `/pharmacy/catalog/proposals`** — status of own proposals.

**Representative errors:** `CATALOG_DUPLICATE_PRODUCT, PRODUCT_NOT_FOUND, INVALID_CLASSIFICATION, CONTROLLED_PROHIBITED, CATEGORY_NOT_FOUND, IMPORT_VALIDATION_FAILED, RBAC_FORBIDDEN, VALIDATION_ERROR`.

---

## 8. NestJS Folder Structure (Clean Architecture)

```
src/modules/catalog/
  domain/
    entities/            # Product, Category, EquivalenceGroup, ProductProposal, Manufacturer
    value-objects/       # GenericName, Strength, DosageForm, RxClassification, ControlledSchedule,
    │                    # Composition, AtcCode, LocalizedText, StorageRequirement
    events/              # ProductCreated, ProductUpdated, ProductClassificationChanged,
    │                    # ProductMerged, ProposalApproved, ProductStatusChanged
    enums/               # ProductType, ProductStatus, ProposalStatus, ControlledSchedule
    repositories/        # IProductRepository, ICategoryRepository, IEquivalenceRepository,
    │                    # IProposalRepository, IManufacturerRepository, ICatalogSearchReadRepository
    services/            # DeduplicationService, EquivalenceResolver, ClassificationPolicy
  application/
    commands/            # CreateProduct, UpdateProduct, ChangeClassification, MergeProducts,
    │                    # SubmitProposal, ReviewProposal, ChangeProductStatus, BulkImport
    queries/             # SearchProducts, GetProduct, GetSubstitutes, GetCategoryTree, ListProposals
    ports/               # IStoragePort (images), ISearchIndexPort, ICachePort, IAuditPort, IImportParserPort
    dtos/  mappers/
  infrastructure/
    persistence/prisma/  repositories/       # Prisma*Repository, CatalogSearchReadRepository (view)
    search/              # PgTrgmSearchAdapter (ISearchIndexPort) [OpenSearchAdapter later]
    storage/             # CloudStorageImageAdapter
    cache/               # RedisCacheAdapter
    import/              # CsvImportParserAdapter
    audit/               # shared HashChainAuditAdapter
  interface/
    http/
      controllers/       # CatalogController (public), AdminCatalogController, PharmacyCatalogController
      dtos/ guards/ decorators/ filters/ interceptors/
    events/              # on ProductCreated/Updated/Merged → refresh catalog_search_view + invalidate cache
  catalog.module.ts
```

**Rationale.** `ISearchIndexPort` abstracts the search backend so we ship fast with Postgres pg_trgm/GIN and later swap to OpenSearch/Elastic at scale with no domain/controller change (Dependency Inversion, Open/Closed). Classification lives in a `ClassificationPolicy` domain service so the Rx/controlled rules (compliance-critical) have one home.

---

## 9. Sequence Flows

### 9.1 Admin Create Product (with dedup)
```
Admin → AdminCatalogController: POST /admin/catalog/products {generic,brand,strength,form,mfr,rx,...}
CreateProduct → ClassificationPolicy: validate (MEDICINE⇒rx required; PROHIBITED⇒online_sale_prohibited)
CreateProduct → DeduplicationService: findDuplicate(generic,strength,form,mfr)
  found → 409 CATALOG_DUPLICATE_PRODUCT {candidateId}
CreateProduct → EquivalenceResolver: attach/create equivalence_group
CreateProduct → IProductRepository: save (status DRAFT/ACTIVE)
CreateProduct → emit ProductCreated
ProductCreated handler → refresh catalog_search_view + ICachePort invalidate
CreateProduct → IAuditPort: PRODUCT_CREATED
→ 201 {productId}
```

### 9.2 Pharmacy Proposal → Moderation → Merge
```
Pharmacy → POST /pharmacy/catalog/proposals {payload}
SubmitProposal → IProposalRepository: save(status=PENDING) → 202
...
Admin → GET /admin/catalog/proposals → queue
Admin → POST /admin/catalog/proposals/{id}/merge {targetProductId}
ReviewProposal → DeduplicationService: confirm equivalence
ReviewProposal → mark proposal MERGED, merged_into=target
ReviewProposal → IAuditPort: PROPOSAL_MERGED
ReviewProposal → INotificationPort: notify submitting pharmacy
→ 200
(then pharmacy can create an inventory listing referencing the canonical product)
```

### 9.3 Search (catalog side)
```
Client → GET /catalog/products?q=amoxicillin&rx=RX&sort=relevance
SearchProducts → ICatalogSearchReadRepository: query catalog_search_view (tsvector + trgm)
SearchProducts → ICachePort: cache hot queries (short TTL)
→ 200 {items: product summaries, page}
(Search & Matching module later joins Inventory for price/stock/distance)
```

### 9.4 Substitutes (BRULE-16)
```
Client → GET /catalog/products/{id}/substitutes
GetSubstitutes → EquivalenceResolver: same equivalence_group (generic-equivalent)
GetSubstitutes → + therapeutic alternatives (same ATC class, flagged distinctly)
→ 200 {genericEquivalents:[...], therapeuticAlternatives:[...]}
```

---

## 10. Error Handling

Reuses Module 1 §14 envelope/filter. Module codes: `CATALOG_DUPLICATE_PRODUCT` (includes candidate ref), `PRODUCT_NOT_FOUND`, `INVALID_CLASSIFICATION` (e.g., medicine without Rx flag), `CONTROLLED_PROHIBITED` (attempt to enable sale of prohibited item), `CATEGORY_NOT_FOUND`, `IMPORT_VALIDATION_FAILED` (returns per-row errors), `PROPOSAL_NOT_FOUND`, `RBAC_FORBIDDEN`, `VALIDATION_ERROR`. Classification/controlled violations are treated as hard errors (safety-critical), never warnings.

---

## 11. Logging & Auditing

Reuses hash-chained `audit_logs`. **Must-log:**
- Product created/updated, **classification change** (Rx↔OTC, controlled schedule) — high-sensitivity, always audited (compliance).
- Product merged, status change (activate/deprecate/delist).
- Proposal submitted/approved/rejected/merged (actor + reason).
- Bulk import runs (who, file, counts, dry-run vs applied).
- Category/manufacturer changes.

Operational logs capture search query volume/latency for performance tuning (no PII in catalog).

---

## 12. Future Scalability & Evolution

- **Search backend swap** — `ISearchIndexPort` lets us move from Postgres pg_trgm/GIN to OpenSearch/Elastic (facets, synonyms, ranking) at scale with no API change.
- **Read/cache scaling** — Catalog is read-dominant and highly cacheable: Redis + CDN for images; `catalog_search_view` served from read replicas.
- **Formulary/distributor integration** (NFR-INTEROP-03) — import adapters behind `IImportParserPort`; standardized INN/ATC coding eases external data ingestion.
- **AI enrichment (future)** — auto-suggest categories, detect duplicates, extract composition from labels — added as application services consuming the same ports.
- **Sourcing/batch traceability** (NFR-COMP-05) — manufacturer + batch metadata hooks already modeled; batch/expiry lives in Inventory but references catalog identity.
- **Extraction-ready** — Catalog exposes query ports and emits domain events; can become a standalone Product service feeding an event-driven search projection.

---

## Open Questions for Product/Compliance
1. **Authoritative drug reference** — will we seed from EFDA/national formulary or a licensed drug database for INN/ATC accuracy?
2. **Controlled-substance policy** — which schedules are *prohibited online* vs *allowed with extra controls*? (drives `controlled_schedule` values and BRULE-13 enforcement).
3. **Substitution safety** — is pharmacist approval required for *every* substitution, or only for certain classes? (affects how Catalog flags therapeutic vs generic alternatives).
4. **Search engine choice at launch** — Postgres full-text/pg_trgm for MVP (recommended) vs OpenSearch from day one?

---

**End of Module 3 design.** Awaiting your approval to proceed. Recommended next module: **Pharmacy & Inventory** (Module 5 in the master plan) — pharmacy onboarding, per-pharmacy listings, price/stock/batch/expiry referencing this Catalog, and license-based transacting eligibility (BRULE-05/08/15).
