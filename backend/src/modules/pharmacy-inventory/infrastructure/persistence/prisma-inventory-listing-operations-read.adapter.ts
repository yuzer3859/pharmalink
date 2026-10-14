import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  IInventoryListingOperationsReadPort,
  InventoryListingOperationsDetail,
  InventoryListingOperationsFilter,
  InventoryListingOperationsPage,
  InventoryListingOperationsView,
} from '../../application/ports/inbound/inventory-listing-operations-read.port';
import {
  AVAILABLE_LISTING_FROM,
  availableListingWhere,
  computedSellableQuantity,
  unexpiredBatchQuantity,
  unexpiredSellablePositive,
} from './listing-availability.sql';

interface ListingRow {
  id: string;
  pharmacyId: string;
  branchId: string;
  catalogProductId: string;
  isEnabled: boolean;
  sellable: number;
  reserved: number;
  createdAt: Date;
  updatedAt: Date;
  computedSellable: bigint;
  customerPurchasable: boolean;
  unexpiredBatchCount: bigint;
  unexpiredBatchQuantity: bigint;
}

const toView = (r: ListingRow): InventoryListingOperationsView => ({
  listingId: r.id,
  pharmacyId: r.pharmacyId,
  branchId: r.branchId,
  catalogProductId: r.catalogProductId,
  isEnabled: r.isEnabled,
  storedSellable: r.sellable,
  computedSellable: Number(r.computedSellable),
  customerPurchasable: r.customerPurchasable,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

/**
 * `IInventoryListingOperationsReadPort` over Prisma: two statements in one REPEATABLE READ transaction
 * — the page and its total, over the same `FROM`/`WHERE`. The listing is joined to its one pharmacy and
 * its one branch (`AVAILABLE_LISTING_FROM`, many-to-one), and batches are reached only through scalar
 * sub-selects, so no listing is repeated however many batches it has. Every rule is a shared Module 04
 * fragment: `computedSellableQuantity` / `unexpiredBatchQuantity` (`SellableStockCalculator`) and
 * `availableListingWhere` + `unexpiredSellablePositive` (Work 26). Nothing is written.
 */
@Injectable()
export class PrismaInventoryListingOperationsReadAdapter implements IInventoryListingOperationsReadPort {
  constructor(private readonly prisma: PrismaService) {}

  async listListings(f: InventoryListingOperationsFilter, page: number, size: number, now: Date = new Date()): Promise<InventoryListingOperationsPage> {
    const { rows, total } = await this.read(this.where(f, now), now, size, (page - 1) * size);
    return { items: rows.map(toView), total, page, size };
  }

  async getListing(listingId: string, now: Date = new Date()): Promise<InventoryListingOperationsDetail | null> {
    const { rows } = await this.read(this.where({}, now, listingId), now, 1, 0);
    const r = rows[0];
    if (!r) return null;
    const view = toView(r);
    return {
      ...view,
      reserved: r.reserved,
      unexpiredBatchCount: Number(r.unexpiredBatchCount),
      unexpiredBatchQuantity: Number(r.unexpiredBatchQuantity),
      storedMatchesComputed: view.storedSellable === view.computedSellable,
    };
  }

  private where(f: InventoryListingOperationsFilter, now: Date, listingId?: string): Prisma.Sql {
    const purchasable = Prisma.sql`(${availableListingWhere(now)} AND ${unexpiredSellablePositive(now)})`;
    const conditions: Prisma.Sql[] = [Prisma.sql`il."deletedAt" IS NULL`];
    if (listingId) conditions.push(Prisma.sql`il."id" = ${listingId}`);
    if (f.pharmacyId) conditions.push(Prisma.sql`il."pharmacyId" = ${f.pharmacyId}`);
    if (f.branchId) conditions.push(Prisma.sql`il."branchId" = ${f.branchId}`);
    if (f.catalogProductId) conditions.push(Prisma.sql`il."catalogProductId" = ${f.catalogProductId}`);
    if (f.isEnabled !== undefined) conditions.push(Prisma.sql`il."isEnabled" = ${f.isEnabled}`);
    if (f.hasStoredSellableStock !== undefined) conditions.push(f.hasStoredSellableStock ? Prisma.sql`il."sellable" > 0` : Prisma.sql`il."sellable" <= 0`);
    if (f.customerPurchasable !== undefined) conditions.push(f.customerPurchasable ? purchasable : Prisma.sql`NOT ${purchasable}`);
    if (f.createdFrom) conditions.push(Prisma.sql`il."createdAt" >= ${f.createdFrom}`);
    if (f.createdTo) conditions.push(Prisma.sql`il."createdAt" < ${f.createdTo}`);
    return Prisma.join(conditions, ' AND ');
  }

  private async read(where: Prisma.Sql, now: Date, take: number, skip: number): Promise<{ rows: ListingRow[]; total: number }> {
    return this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<ListingRow[]>`
          SELECT il."id", il."pharmacyId", il."branchId", il."catalogProductId", il."isEnabled", il."sellable", il."reserved",
                 il."createdAt", il."updatedAt",
                 ${computedSellableQuantity(now)} AS "computedSellable",
                 (${availableListingWhere(now)} AND ${unexpiredSellablePositive(now)}) AS "customerPurchasable",
                 (SELECT COUNT(*) FROM "stock_batches" sb WHERE sb."listingId" = il."id" AND sb."expiryDate" > ${now}) AS "unexpiredBatchCount",
                 ${unexpiredBatchQuantity(now)} AS "unexpiredBatchQuantity"
          ${AVAILABLE_LISTING_FROM}
           WHERE ${where}
           ORDER BY il."createdAt" DESC, il."id" DESC
           LIMIT ${take} OFFSET ${skip}`;
        const [{ count }] = await tx.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*) AS "count" ${AVAILABLE_LISTING_FROM} WHERE ${where}`;
        return { rows, total: Number(count) };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
