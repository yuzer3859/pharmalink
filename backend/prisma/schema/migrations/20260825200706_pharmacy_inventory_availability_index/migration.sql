-- Module 04 — Pharmacy & Inventory, Slice 1 (backend/docs/04-pharmacy-inventory-spec.md §6.2).
-- Availability hot path filters WHERE catalogProductId = ? AND isEnabled = true AND
-- sellable > 0, joined to pharmacies for eligibility. This composite index avoids a slow-query
-- rediscovery of that filter shape at scale.
CREATE INDEX "inventory_listings_catalogProductId_isEnabled_sellable_idx" ON "inventory_listings"("catalogProductId", "isEnabled", "sellable");
