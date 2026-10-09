import { Prisma } from '@prisma/client';

/**
 * Module 04's customer-availability rules as SQL, written once (module-16 Work 26 extracted them
 * from `PrismaListingRepository.findAvailability`, unchanged). Every fragment is over the aliases
 * of `AVAILABLE_LISTING_FROM`: `il` (inventory_listings), `p` (pharmacies), `b` (branches).
 */

/** The listing, its pharmacy and its branch. */
export const AVAILABLE_LISTING_FROM = Prisma.sql`
  FROM "inventory_listings" il
  JOIN "pharmacies" p ON p."id" = il."pharmacyId"
  JOIN "branches" b ON b."id" = il."branchId"`;

/**
 * Discovery (module-04 §10.3) — what `GET /availability` offers a customer: a live, enabled listing
 * with stored `sellable > 0`, on an active branch, of a live pharmacy that is eligible by
 * `TransactingEligibilityPolicy` (`ACTIVE`, licence `VALID`, `licenseExpiresAt` null or after `now`).
 */
export const availableListingWhere = (now: Date) => Prisma.sql`
  il."isEnabled" = true
  AND il."deletedAt" IS NULL
  AND il."sellable" > 0
  AND b."isActive" = true
  AND p."deletedAt" IS NULL
  AND p."transactingStatus" = 'ACTIVE'
  AND p."licenseStatus" = 'VALID'
  AND (p."licenseExpiresAt" IS NULL OR p."licenseExpiresAt" > ${now})`;

/**
 * BRULE-15 (`SellableStockCalculator`) at `now`, positive: the listing's unexpired batch quantity
 * (`expiryDate > now`; a batch expiring exactly at `now` is expired) minus `reserved` is above zero —
 * the stock `ReserveStockCommand` recomputes under its lock before it lets anyone buy. The stored
 * `sellable` is that same figure as of the listing's last stock write; a batch that expired since is
 * still in it, which is why discovery alone can offer a listing a reservation would refuse.
 */
export const unexpiredSellablePositive = (now: Date) => Prisma.sql`
  (SELECT COALESCE(SUM(sb."quantity"), 0) FROM "stock_batches" sb
     WHERE sb."listingId" = il."id" AND sb."expiryDate" > ${now}) - il."reserved" > 0`;
