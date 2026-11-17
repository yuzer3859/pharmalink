-- Work 134 (owner decision 2026-11-17): a prescription request offered to every eligible pharmacy;
-- the first to accept owns it. Two new tables; nothing existing changes.
CREATE TYPE "RxRequestStatus" AS ENUM ('OPEN', 'CLAIMED', 'QUOTED', 'CONFIRMED', 'CANCELLED', 'EXPIRED', 'NO_PHARMACY');

CREATE TYPE "RxRequestOfferStatus" AS ENUM ('OPEN', 'WON', 'TAKEN', 'DECLINED', 'LAPSED', 'CLOSED');

CREATE TABLE "rx_requests" (
    "id" TEXT NOT NULL,
    "customerUserId" TEXT NOT NULL,
    "prescriptionId" TEXT NOT NULL,
    "addressId" TEXT NOT NULL,
    "deliveryLat" DOUBLE PRECISION NOT NULL,
    "deliveryLng" DOUBLE PRECISION NOT NULL,
    "prescriptionIssueDate" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "status" "RxRequestStatus" NOT NULL DEFAULT 'OPEN',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "claimedPharmacyId" TEXT,
    "claimedBranchId" TEXT,
    "claimedByUserId" TEXT,
    "claimedAt" TIMESTAMP(3),
    "claimExpiresAt" TIMESTAMP(3),
    "quote" JSONB,
    "quotedAt" TIMESTAMP(3),
    "quoteExpiresAt" TIMESTAMP(3),
    "orderId" TEXT,
    "closedReason" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rx_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "rx_request_offers" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "pharmacyId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "distanceMeters" INTEGER NOT NULL,
    "status" "RxRequestOfferStatus" NOT NULL DEFAULT 'OPEN',
    "respondedAt" TIMESTAMP(3),
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rx_request_offers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "rx_requests_prescriptionId_key" ON "rx_requests"("prescriptionId");

CREATE INDEX "rx_requests_customerUserId_createdAt_idx" ON "rx_requests"("customerUserId", "createdAt");

CREATE INDEX "rx_requests_status_expiresAt_idx" ON "rx_requests"("status", "expiresAt");

CREATE INDEX "rx_requests_status_claimExpiresAt_idx" ON "rx_requests"("status", "claimExpiresAt");

CREATE UNIQUE INDEX "rx_request_offers_requestId_pharmacyId_key" ON "rx_request_offers"("requestId", "pharmacyId");

CREATE INDEX "rx_request_offers_pharmacyId_status_idx" ON "rx_request_offers"("pharmacyId", "status");

ALTER TABLE "rx_request_offers" ADD CONSTRAINT "rx_request_offers_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "rx_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
