# Module 14 — Search & Discovery (Design Document)

**Product:** PharmaLink Ethiopia — Digital Healthcare Marketplace
**Module:** 14 — Search & Discovery (Unified geo-aware, typo-tolerant search across catalog, pharmacies, providers, doctors)
**Status:** Design — Approved for implementation reference
**Architecture style:** Modular Monolith (NestJS) · Clean Architecture · DDD · SOLID
**Depends on:** Module 03 (Catalog), 04 (Pharmacy/Inventory availability), 09 (Provider Directory), 10 (Doctors), 11 (Diagnostics services). Consumed by: web/mobile clients, Cart/Order (product→pharmacy discovery).
**Traceability:** FR-MED-01/02/05/07/08, FR-HOSP-05/06, FR-DOC-04, FR-LAB-04, FR-MATCH-01/02/03, NFR-PERF-01, NFR-SCAL, NFR-LOC-02/03

> Single source of truth for the Search & Discovery bounded context. No implementation code — contracts, schemas, flows, and reasoning only.

---

## 1. Module Objectives

This is the **unified discovery surface** of the platform. It consolidates the per-domain search read-models designed across Modules 3 (catalog), 4 (pharmacy availability), 9 (providers), and 10 (doctors) into one fast, **geo-aware, typo-tolerant** search experience — the primary way users find medicines, pharmacies, hospitals, labs, and doctors.

**Why a dedicated module.** Each domain module already exposes a search read-model (`catalog_search_view`, `provider_search_view`, availability, doctor discovery). Rather than clients hitting four different APIs and stitching results, this module provides:
- **One search API** with consistent ranking, pagination, faceting, and geo-awareness.
- **The composition layer** that joins **product ↔ availability** (catalog price/stock across pharmacies — the core marketplace value, FR-MED-05/08) and **provider ↔ doctors**.
- **A backend abstraction** so we launch on **PostgreSQL FTS (pg_trgm/GIN + PostGIS)** and upgrade to **OpenSearch/Elasticsearch** at scale with no client change.

**Boundary.** Search **owns no source data** — it owns **indexes/read-models + query/ranking**. Source modules remain authoritative and emit events that keep indexes fresh. This is CQRS at the platform level: writes in domain modules, optimized reads here.

**Primary objectives**
- Medicine search by **brand or generic**, typo-tolerant, with filters (category, Rx/OTC, manufacturer) (FR-MED-01/02).
- **Product → pharmacy availability** results: which nearby pharmacies stock it, at what price, ranked by distance/price (FR-MED-05/07/08, FR-MATCH-01/02/03).
- **Provider/lab discovery** nearest-first with specialty/service filters (FR-HOSP-05/06, FR-LAB-04).
- **Doctor discovery** by specialty/name/provider/next-availability (FR-DOC-04).
- **Unified/global search** across entity types with relevance ranking.
- **Localized search** (Amharic/English, synonyms) and **geo ranking** (NFR-LOC-02/03).
- Fast (≤2s p95, NFR-PERF-01) and scalable (NFR-SCAL).

---

## 2. Business Requirements

| ID | Business Requirement | Source |
| --- | --- | --- |
| BR-SR-01 | Users search medicines by brand or generic name. | FR-MED-01 |
| BR-SR-02 | Users filter by category, Rx/OTC, manufacturer, price. | FR-MED-02 |
| BR-SR-03 | Search shows which pharmacies have a product in stock, with price. | FR-MED-05/08 |
| BR-SR-04 | Results rank by proximity, then price/rating. | FR-MED-07, FR-MATCH-02/03 |
| BR-SR-05 | Users discover hospitals/clinics/labs nearest-first with filters. | FR-HOSP-05/06, FR-LAB-04 |
| BR-SR-06 | Users search doctors by specialty/name/provider/availability. | FR-DOC-04 |
| BR-SR-07 | Search is typo-tolerant and supports Amharic + English. | NFR-LOC-02 |
| BR-SR-08 | Search returns within performance targets. | NFR-PERF-01 |
| BR-SR-09 | Only eligible/verified entities appear (no suspended pharmacies/providers, no expired stock). | BRULE-08/15/18 |
| BR-SR-10 | Search supports autocomplete/suggestions. | (Vision UX) |

---

## 3. Functional Requirements (Module Features)

### 3.1 Medicine & Pharmacy Search
- **F-SR-01** Full-text medicine search (brand/generic/composition/tags), typo-tolerant (pg_trgm) (FR-MED-01).
- **F-SR-02** Filters/facets: category, type (medicine/health product), Rx/OTC, manufacturer, price range (FR-MED-02).
- **F-SR-03** **Product detail → availability**: nearby eligible pharmacies with sellable stock, price, distance, rating (composes Module 4) (FR-MED-05/08).
- **F-SR-04** Rank pharmacies for a product by distance → price → rating (FR-MED-07, FR-MATCH-02/03).
- **F-SR-05** "Available near me" product listing (products with in-stock pharmacies within radius).
- **F-SR-06** Substitute/equivalent suggestions surfaced (via Module 3 equivalence, BRULE-16).

### 3.2 Provider, Lab & Doctor Search
- **F-SR-07** Provider search (hospital/clinic/diagnostic/lab) nearest-first + filters (specialty, service, emergency) (FR-HOSP-05/06, FR-LAB-04).
- **F-SR-08** Diagnostic service search (test/imaging/package) across centers with price/distance compare (FR-LAB-04).
- **F-SR-09** Doctor search by specialty/name/provider, sortable by next-available slot or rating (FR-DOC-04).

### 3.3 Unified & Assistive
- **F-SR-10** **Global search**: single query across medicines, pharmacies, providers, doctors → grouped, relevance-ranked results.
- **F-SR-11** **Autocomplete/suggestions** (prefix + popular queries), localized.
- **F-SR-12** Geo-awareness: use device location for distance ranking + radius filtering (NFR-LOC-03).
- **F-SR-13** Sorting options: relevance, distance, price, rating, availability.
- **F-SR-14** Popular/trending + recent searches (personalized, lightweight).

---

## 4. Non-Functional Requirements

| Attribute | Requirement | Design Response |
| --- | --- | --- |
| **Performance** | ≤2s p95 (NFR-PERF-01) | Denormalized indexes; Redis cache for hot queries; geo + trigram indexes; async availability join with short-TTL cache. |
| **Scalability** | Growing catalog/providers (NFR-SCAL) | `ISearchEngine` abstraction: pg_trgm/PostGIS now → OpenSearch later; read replicas. |
| **Freshness** | Indexes reflect source changes | Event-driven index updates (CQRS projections) from domain events; acceptable eventual consistency (seconds). |
| **Localization** | am/en + synonyms (NFR-LOC-02) | Localized analyzers/synonym sets; Amharic tokenization (OpenSearch later); tags. |
| **Relevance** | Useful ranking | Configurable ranking weights (text score, distance, price, rating, availability). |
| **Correctness/Compliance** | Only eligible entities (BRULE-08/15/18) | Index carries eligibility flags; queries filter suspended/expired; availability re-checked at Module 4 on selection. |
| **Resilience** | Degrade gracefully | If availability service slow, return catalog results with "checking stock"; cache last-known. |

---

## 5. Architecture & Design Decisions

### 5.1 CQRS read-side at platform scale
Search is the **read side** of a CQRS split: domain modules own writes; Search maintains **query-optimized projections** updated via domain events (`ProductCreated/Updated`, `ListingCreated/PriceChanged/StockChanged`, `ProviderActivated/Suspended`, `DoctorProfileUpdated`, `SlotChanged`). Projections are eventually consistent (seconds) — acceptable for discovery, since **final correctness (price/stock/eligibility) is re-verified** by the authoritative module at add-to-cart/booking time (Modules 4/6/10). Search optimizes discovery; it never becomes the source of truth for a transaction.

### 5.2 `ISearchEngine` abstraction (launch simple, scale later)
A single port abstracts the engine:
- **Launch:** `PostgresSearchAdapter` — pg_trgm/GIN for typo-tolerant text, PostGIS/geohash for geo, materialized views for facets. Zero new infra (reuses the primary DB / replicas).
- **Scale:** `OpenSearchAdapter` — inverted index, Amharic analyzers, faceting, fuzzy, geo, relevance tuning. Swap behind the port with **no API/client change** (Open/Closed).

This is the key decision that lets us **ship the MVP on Postgres** (matching Modules 3/9 open questions) yet scale to a dedicated search cluster without rework.

### 5.3 The product↔availability composition (core marketplace value)
The defining marketplace feature — "who near me has this medicine and for how much" — is a **join across two modules**: Catalog (product identity) + Inventory (per-pharmacy sellable stock + price + geo). Search performs this composition:
1. Text-match products (Catalog index).
2. For a chosen product (or top results), fetch **eligible in-stock pharmacies** within radius from Module 4's availability (cached).
3. Rank by distance → price → rating.

This is exactly the matching input Module 5 uses; Search and Matching share the availability read-model (single source), differing only in purpose (browse vs order fulfillment).

---

## 6. Domain Model (read-model oriented)

### 6.1 Projections (read models)
- **ProductSearchDoc** — product identity + metadata + tags + eligibility (from Catalog).
- **PharmacyAvailabilityDoc** — per (product, pharmacy-branch): price, sellable, geo, rating, eligibility (from Inventory) — the geo-priced index.
- **ProviderSearchDoc** — provider profile + location(s) + specialties/services + eligibility + rating (from Directory).
- **DoctorSearchDoc** — doctor profile + specialties + affiliations + next-available + rating (from Doctors/Appointments).

### 6.2 Value Objects
- `SearchQuery` (text, filters, geo, sort, page), `GeoPoint`, `Radius`, `Facet`, `RankingWeights` (config), `EntityType` (MEDICINE|PHARMACY|PROVIDER|DOCTOR|SERVICE), `Relevance` (score), `Suggestion`.

### 6.3 Invariants
- Only **eligible** entities are returned: pharmacies/providers not suspended & license-valid (BRULE-08/18), products with **sellable stock** (expiry-aware, BRULE-15). Eligibility flags are denormalized into docs and filtered at query time.
- Projections are **derived** — never authoritative; a transaction always re-verifies against the owning module.
- Geo ranking requires a location; without one, fall back to text-relevance + rating (no distance sort).
- Search results **never expose** data a user can't act on (e.g., prohibited/controlled products flagged per Module 3).

---

## 7. Indexing / Projection Pipeline

```
Domain events (outbox) → Search projector (per entity type, idempotent)
  ProductCreated/Updated/Merged        → upsert ProductSearchDoc
  ListingCreated/PriceChanged/StockChanged/ListingDisabled → upsert/remove PharmacyAvailabilityDoc
  PharmacySuspended/Reactivated/LicenseExpired → flip eligibility flag on docs
  ProviderActivated/Suspended/ProfileUpdated/ServiceAdded → upsert ProviderSearchDoc
  DoctorProfileUpdated/AffiliationChanged/SlotChanged → upsert DoctorSearchDoc
Projector → write to ISearchEngine (Postgres views/tables now; OpenSearch later)
Projector → invalidate affected Redis query caches
```

- **Idempotent** upserts keyed by entity id + version (handle out-of-order/duplicate events).
- **Rebuildable**: a full reindex job can replay from source modules (bootstrap / disaster recovery / engine migration).
- **Freshness SLO**: index reflects changes within seconds (acceptable for discovery).

**Design rationale.** Consuming existing domain events (already emitted via the outbox pattern in Modules 3/4/6/9/10) means Search adds **no write-path burden** on domain modules and stays decoupled. Rebuildability makes the OpenSearch migration and DR safe.

---

## 8. Database / Index Design

**Launch (PostgreSQL):** reuse/extend the module search views + dedicated Search-owned indexes.

**product_search_docs** (or materialized view over Catalog)
- `product_id`, `type`, `name_en`, `name_am`, `generic_name`, `brand_name`, `manufacturer`, `category_paths` (array), `rx_classification`, `controlled`, `tags` (array), `is_active`, `search_tsv` (tsvector), `trgm` indexes.

**pharmacy_availability_docs** — geo-priced product availability (Search-maintained projection of Module 4).
- `product_id`, `pharmacy_id`, `branch_id`, `price`, `sellable` (bool/qty), `lat`, `lng`, `geohash`, `rating`, `is_eligible` (bool), `updated_at`.
- Indexes: `(product_id, is_eligible)`, geo index on `(lat,lng)`/geohash, `(product_id, price)`.

**provider_search_docs**
- `provider_id`, `type`, `name_en/am`, `city`, `lat`,`lng`,`geohash`, `specialties` (array), `services` (array), `emergency`, `rating`, `is_eligible`, `search_tsv`.

**doctor_search_docs**
- `doctor_id`, `name`, `specialty`, `sub_specialties` (array), `provider_ids` (array), `languages` (array), `next_available_at` (nullable), `rating`, `accepts_telemedicine`, `is_verified`, `search_tsv`.

**search_suggestions** — autocomplete corpus.
- `id`, `term`, `entity_type`, `popularity`, `locale`.

**search_query_log** — analytics + popular/trending (privacy-aware, no PII beyond user id ref).
- `id`, `user_id` (nullable), `query`, `filters` (jsonb), `result_count`, `clicked_entity` (nullable), `created_at`.

**Scale (OpenSearch):** indices `products`, `availability`, `providers`, `doctors` with Amharic + English analyzers, synonyms, geo_point mapping, and function-score ranking. Same logical docs as above.

**Rationale.** Geohash/PostGIS enables radius + nearest-first; `tsvector` + `pg_trgm` gives typo tolerance and Amharic/English matching at launch. Keeping docs logically identical between Postgres and OpenSearch makes the engine swap a pure infrastructure change.

---

## 9. API Design

Base path: `/api/v1/search`. Auth optional (permissive; personalization if authed). Geo via `lat,lng,radius`. Envelope/errors per Module 1 §14. Redis-cached hot queries.

- **GET `/search`** — **unified/global**. Query: `q, lat, lng, types[], page`. → grouped results per `EntityType` with top hits + counts (FR-SR-10).
- **GET `/search/medicines`** — Query: `q, category, rx, manufacturer, priceMin, priceMax, lat, lng, radius, sort(relevance|distance|price|rating|availability), page`. → products (+ availability summary: min price, nearest in-stock) (FR-MED-01/02/07/08).
- **GET `/search/medicines/{productId}/pharmacies`** — nearby eligible pharmacies with stock+price+distance, ranked (FR-MED-05, FR-MATCH-01/02/03). (Composition endpoint — the marketplace core.)
- **GET `/search/providers`** — Query: `q, type, specialty, service, city, emergency, lat, lng, radius, sort`. (FR-HOSP-05/06, FR-LAB-04).
- **GET `/search/services`** — diagnostic service search across centers (price/distance compare) (FR-LAB-04).
- **GET `/search/doctors`** — Query: `q, specialty, providerId, language, availableFrom, sort(next_available|rating)`. (FR-DOC-04).
- **GET `/search/suggest`** — Query: `q, type?` → autocomplete suggestions (localized) (FR-SR-11).
- **GET `/search/trending`** — popular/recent searches (FR-SR-14).

**Response essentials:** each hit carries `entityType`, `id`, localized display fields, `distanceMeters` (if geo), ranking `score`, and entity-specific summary (price/availability, next-available slot, rating). Eligibility already filtered.

**Representative errors:** `INVALID_SEARCH_QUERY`, `LOCATION_REQUIRED_FOR_DISTANCE_SORT`, `SEARCH_BACKEND_UNAVAILABLE` (degrade gracefully), `VALIDATION_ERROR`.

---

## 10. NestJS Folder Structure (Clean Architecture)

```
src/modules/search/
  domain/
    value-objects/       # SearchQuery, GeoPoint, Radius, Facet, RankingWeights, EntityType, Relevance, Suggestion
    models/              # ProductSearchDoc, PharmacyAvailabilityDoc, ProviderSearchDoc, DoctorSearchDoc
    services/            # RankingStrategy (distance/price/rating/text weights), FacetBuilder,
    │                    # GeoRanker, EligibilityFilter, QueryParser
    repositories/        # ISearchEngine (query), ISearchIndex (write/projection)
  application/
    queries/             # UnifiedSearch, SearchMedicines, SearchProductPharmacies, SearchProviders,
    │                    # SearchServices, SearchDoctors, Suggest, Trending
    projectors/          # ProductProjector, AvailabilityProjector, ProviderProjector, DoctorProjector
    ports/               # IAvailabilityPort(4, live re-check), ICatalogPort(3), IProviderPort(9),
    │                    # IDoctorPort(10), ICachePort, IEventConsumerPort, IAnalyticsPort
    dtos/  mappers/
  infrastructure/
    engine/
      postgres/          # PostgresSearchAdapter (pg_trgm/GIN + PostGIS)  [ISearchEngine/ISearchIndex]
      opensearch/        # OpenSearchAdapter (future) — same interface
    projection/          # EventConsumers (subscribe outbox events), ReindexJob (full rebuild)
    cache/               # RedisQueryCache
    analytics/           # QueryLogWriter (trending/popular)
  interface/
    http/
      controllers/       # SearchController (all read endpoints)
      dtos/ filters/ interceptors/  # CacheInterceptor
  search.module.ts
```

**Rationale.** `ISearchEngine`/`ISearchIndex` are the pivotal ports — Postgres now, OpenSearch later, no domain/controller change. **Projectors** consume domain events to maintain read models (CQRS). `RankingStrategy` centralizes configurable relevance (text/distance/price/rating). For fresh price/stock at the point of a product→pharmacy query, `IAvailabilityPort` can **live re-check** Module 4 (cached) rather than trust a stale projection — balancing speed and accuracy for the money-sensitive availability view.

---

## 11. Sequence Flows

### 11.1 Medicine Search → Availability (marketplace core)
```
Client → GET /search/medicines?q=amoxiciline&lat&lng&sort=distance   (note typo)
SearchMedicines → RedisQueryCache hit? return
 miss → QueryParser normalize; ISearchEngine.searchProducts (trgm fuzzy → matches "amoxicillin")
      → EligibilityFilter (active products)
      → for top N: IAvailabilityPort/PharmacyAvailabilityDoc → nearest eligible in-stock + min price
      → RankingStrategy (distance→price→rating); GeoRanker distances
      → cache (short TTL)
→ 200 [{product, minPrice, nearestPharmacyDistance, inStockCount}]
```

### 11.2 Product → Pharmacies (ranked, FR-MATCH-02/03)
```
Client → GET /search/medicines/{productId}/pharmacies?lat&lng&radius
SearchProductPharmacies → IAvailabilityPort(Module 4): eligible in-stock pharmacies in radius (authoritative, cached)
 → attach price, distance, rating; RankingStrategy distance→price→rating
→ 200 [{pharmacyId, branch, price, distance, sellable, rating}]
(same read-model Module 5 matching uses → consistent results)
```

### 11.3 Unified Search
```
Client → GET /search?q=cardiology&lat&lng
UnifiedSearch → parallel: ISearchEngine.searchProviders (specialty=cardiology),
                          searchDoctors (specialty=cardiology), searchProducts (n/a low)
 → merge, group by EntityType, relevance+distance rank per group
→ 200 {providers:[...], doctors:[...], medicines:[...]}
```

### 11.4 Projection Update (freshness)
```
Module 4 emits PriceChanged/StockChanged (outbox) → AvailabilityProjector (idempotent)
 → upsert PharmacyAvailabilityDoc (price/sellable/eligibility)
 → invalidate affected product query caches
Module 4 emits PharmacySuspended → flip is_eligible=false on that pharmacy's docs (removed from results)
```

---

## 12. Error Handling

Reuses Module 1 §14. Search **degrades gracefully**: if the availability service is slow/unavailable, return catalog matches with a "checking availability" state + last-known cached stock rather than failing the whole search (`SEARCH_BACKEND_UNAVAILABLE` only if the core engine is down). `LOCATION_REQUIRED_FOR_DISTANCE_SORT` when distance sort requested without geo. Malformed queries → `INVALID_SEARCH_QUERY` with guidance. Never surface ineligible/suspended entities even on partial failures.

---

## 13. Logging & Auditing

Search is low-sensitivity (public discovery), so **operational analytics** dominate: `search_query_log` captures query, filters, result count, and click-through (for relevance tuning, trending, and zero-result analysis) — **privacy-aware** (no health-sensitive profiling; respects Module 12/2 privacy). No hash-chained audit needed for reads, but **admin ranking/synonym/template config changes are audited**. Operational logs track query latency + cache hit-rate + backend health (NFR-PERF-01).

---

## 14. Future Scalability & Evolution

- **Engine upgrade** — `OpenSearchAdapter` behind `ISearchEngine`: Amharic analyzers, synonyms, fuzzy, facets, geo, function-score ranking — no client change. The headline scalability path.
- **Personalization & ranking ML** — learn-to-rank on `search_query_log` (click-through) behind `RankingStrategy`; personalized/"for you" discovery.
- **Semantic/vector search (future)** — symptom→medicine or natural-language health queries via embeddings, as an additional engine adapter.
- **Real-time availability** — as Module 4 scales its geo cache, product→pharmacy stays fast at nationwide volume.
- **Autocomplete quality** — popular-query mining + edge-n-gram suggesters at scale.
- **Extraction-ready** — already a pure read/CQRS service consuming events; the natural companion to a dedicated search cluster; can be extracted with the OpenSearch migration.

---

## Open Questions for Product
1. **Search engine at launch** — confirm PostgreSQL FTS + PostGIS for MVP (recommended), with OpenSearch as the scale path (consolidates Modules 3/9 open questions)?
2. **Amharic search depth** — transliteration/synonym handling and Amharic tokenization needs at launch (affects engine choice timing)?
3. **Availability freshness vs speed** — live re-check Module 4 on every product→pharmacy query (accurate) vs trust projection with short TTL (faster)? Recommend live-check-with-cache for the price/stock view.
4. **Default radius & ranking weights** — default search radius and relative weights (distance vs price vs rating) per entity type.
5. **Personalization scope** — how much history-based personalization at launch given health-privacy sensitivity?

---

**End of Module 14 design.** Awaiting your approval to proceed. Recommended next module: **Reviews & Ratings** — post-transaction ratings for pharmacies, doctors, providers, and delivery, feeding the rating signals this search module ranks on (FR-REV, BRULE-45..47), with moderation and verified-purchase enforcement.
