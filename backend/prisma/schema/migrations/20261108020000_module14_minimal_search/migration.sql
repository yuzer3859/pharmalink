-- Work 98: Module 14 minimal search (Postgres full-text search). Additive only.

-- Full-text vector over a search document's English and Amharic names, generic and brand names,
-- manufacturer and category names. 'simple' configuration: no stemming, so Amharic (Ge'ez script)
-- and English tokens are matched alike; prefix matching is done at query time.
ALTER TABLE "search_documents" ADD COLUMN "searchTsv" tsvector;
CREATE INDEX "search_documents_searchTsv_idx" ON "search_documents" USING GIN ("searchTsv");

-- Search-owned projection of Module 04's purchasable offers: one row per (product, branch).
CREATE TABLE "search_offers" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "pharmacyId" TEXT NOT NULL,
    "pharmacyName" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "branchName" TEXT NOT NULL,
    "city" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "price" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ETB',
    "sellable" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "search_offers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "search_offers_productId_branchId_key" ON "search_offers"("productId", "branchId");
CREATE INDEX "search_offers_pharmacyId_idx" ON "search_offers"("pharmacyId");
