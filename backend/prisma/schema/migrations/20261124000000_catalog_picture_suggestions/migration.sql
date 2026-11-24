-- Work 151: pictures a pharmacy suggests for a product it stocks, waiting for catalogue staff. Additive.
-- CreateEnum
CREATE TYPE "ProductImageSuggestionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "product_image_suggestions" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "pharmacyId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "status" "ProductImageSuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "suggestedById" TEXT NOT NULL,
    "decidedById" TEXT,
    "decisionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "product_image_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_image_suggestions_status_createdAt_idx" ON "product_image_suggestions"("status", "createdAt");

-- CreateIndex
CREATE INDEX "product_image_suggestions_pharmacyId_productId_createdAt_idx" ON "product_image_suggestions"("pharmacyId", "productId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "product_image_suggestions_url_key" ON "product_image_suggestions"("url");

-- AddForeignKey
ALTER TABLE "product_image_suggestions" ADD CONSTRAINT "product_image_suggestions_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

