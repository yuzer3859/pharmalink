# Search: Module 14 minimum (Work 98)

This Work closes the backend half of Phase 1 audit gap G5: there was no search. It builds the
roadmap's "minimal 14 Search (Postgres FTS over catalog/pharmacy)". The design is
`architecture/module-14-search-discovery.md`, and §7 (projection pipeline) and §9 (API) apply in
part. Doctors, providers and diagnostics (Modules 09–12) are out of scope.

## Public API (no sign-in)

| Route | Returns |
|---|---|
| `GET /search/medicines?q&categoryId&rx=RX\|OTC&lat&lng&radiusKm&availableOnly&page&size` | Products found by English or Amharic name, generic or brand name, manufacturer, strength or category. Each has its availability: purchasable branches, the lowest price, and the nearest distance when a location is given. Purchasable products come first, then text relevance, then name. |
| `GET /search/medicines/{productId}/pharmacies?lat&lng&radiusKm&limit` | Where the product can be bought now: pharmacy, branch, city, price, quantity and distance. Nearest first with a location, otherwise cheapest. |
| `GET /search/pharmacies?q&lat&lng&radiusKm&page&size` | Transacting pharmacies by name, branch or city. Nearest first with a location. |

Rules:
- `lat` and `lng` must come together.
- `radiusKm` defaults to 25 and may be at most 200.
- `size` may be at most 50.
- Query text keeps letters and digits in any script (so Amharic works), up to 8 words, each
  matched as a prefix. It is bound as a parameter, never spliced into SQL.

## Read models (Search-owned, additive migration `20261108020000_module14_minimal_search`)

- **`search_documents`** (an existing table) gains `searchTsv tsvector` with a GIN index. A
  `PRODUCT` row exists per searchable product (`ACTIVE`, not deleted, not prohibited online). A
  `PHARMACY` row exists per transacting-eligible pharmacy. The vector uses the `simple`
  configuration: no stemming, so Ge'ez-script and English tokens are treated alike.
- **`search_offers`** (new) holds every purchasable (product, branch) offer, with price, quantity
  and location.

## Keeping it in sync, without reading other modules' tables

Module 14 reads Modules 03 and 04 only through two new exported ports:
`CATALOG_SEARCH_SOURCE_PORT` and `PHARMACY_SEARCH_SOURCE_PORT`. Purchasability is Module 04's own
rule (`findAvailability`): an enabled listing with stock, an active branch, and a
transacting-eligible pharmacy. `SearchEventsHandler` listens to the outbox events below. Each
triggers an idempotent refresh, so duplicates and out-of-order delivery converge.

| Event | Refresh |
|---|---|
| `catalog.product.created`, `.updated`, `.classification_changed`, `.status_changed` | The product and its offers |
| `catalog.category.updated` | Every product in the category |
| `pharmacy.listing.created` | The product's offers |
| `pharmacy.listing.disabled`, `.price_changed`; `pharmacy.stock.received`, `.reserved`, `.released`, `.dispatched` | The listing's product's offers |
| `pharmacy.pharmacy.activated`, `.suspended` | The pharmacy, and the offers of every product it lists |

- **Rebuilding.** `npm run search:reindex` rebuilds everything from the source modules. It is
  idempotent and writes only Search's tables.
- **First start.** On the first start with an empty index (a new deployment, or the first after
  this Work), `SearchBootstrapJob` builds it once in the background.
- **Authority.** The projection is never authoritative. Checkout re-verifies prices, stock,
  prescriptions and eligibility (Modules 05 and 06).

## Not built

- Unified cross-entity search.
- Suggestions and trending.
- Synonyms and typo tolerance (`pg_trgm`).
- Rating-weighted ranking.
- Redis caching.
- OpenSearch.

The design keeps all of these behind the same read models.
