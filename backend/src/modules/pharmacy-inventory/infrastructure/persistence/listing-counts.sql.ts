import { Prisma } from '@prisma/client';
import { availableListingWhere, unexpiredSellablePositive } from './listing-availability.sql';

/**
 * Per-listing counts for the admin operations reads (module-16 Works 47 and 48), written once so a
 * pharmacy's figures and its branches' figures are the same definitions and add up.
 *
 * SELECT columns over `AVAILABLE_LISTING_FROM`'s aliases, for a `GROUP BY` the caller chooses:
 *  - `total`, `enabled`, `inStock` — Work 08's tracked definitions: live listings; live and enabled;
 *    enabled with stored `sellable > 0`;
 *  - `purchasable` — Work 26's rule: discovery (`availableListingWhere`) **and** BRULE-15 stock
 *    recomputed at `now` (`unexpiredSellablePositive`).
 * Listing rows, never quantities or distinct products.
 */
export const listingCountColumns = (now: Date) => Prisma.sql`COUNT(*) FILTER (WHERE il."deletedAt" IS NULL) AS "total",
                 COUNT(*) FILTER (WHERE il."deletedAt" IS NULL AND il."isEnabled" = true) AS "enabled",
                 COUNT(*) FILTER (WHERE il."deletedAt" IS NULL AND il."isEnabled" = true AND il."sellable" > 0) AS "inStock",
                 COUNT(*) FILTER (WHERE ${availableListingWhere(now)} AND ${unexpiredSellablePositive(now)}) AS "purchasable"`;

export interface ListingCountRow {
  total: bigint;
  enabled: bigint;
  inStock: bigint;
  purchasable: bigint;
}

export interface ListingCounts {
  total: number;
  enabled: number;
  disabled: number;
  inStock: number;
  outOfStock: number;
  customerPurchasable: number;
  customerUnpurchasable: number;
}

/** The derived figures, as Work 08 and Work 26 define them: differences within one row. A missing row is all zeros. */
export function toListingCounts(row: ListingCountRow | undefined): ListingCounts {
  const total = Number(row?.total ?? 0);
  const enabled = Number(row?.enabled ?? 0);
  const inStock = Number(row?.inStock ?? 0);
  const purchasable = Number(row?.purchasable ?? 0);
  return {
    total,
    enabled,
    disabled: total - enabled,
    inStock,
    outOfStock: enabled - inStock,
    customerPurchasable: purchasable,
    customerUnpurchasable: total - purchasable,
  };
}
