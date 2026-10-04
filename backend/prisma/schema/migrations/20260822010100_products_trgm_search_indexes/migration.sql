-- Typo-tolerant public search (module-03 §5, §6.3). Slice 1 serves search directly off
-- `products` + `pg_trgm`, deferring a dedicated read model / `tsvector` build-out to Module 14
-- (Search) — accepted by Architect review (§14.5): comfortably clears the platform-wide
-- NFR-PERF-01 target (<=2s p95) at Slice 1 data volume.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "products_generic_name_trgm_idx" ON "products" USING GIN ("genericName" gin_trgm_ops);
CREATE INDEX "products_brand_name_trgm_idx" ON "products" USING GIN ("brandName" gin_trgm_ops);
