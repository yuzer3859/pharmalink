import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  BranchOperationsFilter,
  BranchOperationsPage,
  BranchOperationsView,
  IBranchOperationsReadPort,
} from '../../application/ports/inbound/branch-operations-read.port';
import { AVAILABLE_LISTING_FROM, availableListingWhere, eligiblePharmacyWhere, unexpiredSellablePositive } from './listing-availability.sql';
import { ListingCountRow, listingCountColumns, toListingCounts } from './listing-counts.sql';

interface BranchRow {
  id: string;
  pharmacyId: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  pharmacyEligible: boolean;
}
interface BranchListingCounts extends ListingCountRow { branchId: string }

/**
 * `IBranchOperationsReadPort` over Prisma, all in PostgreSQL inside one REPEATABLE READ transaction:
 *
 *  1. the page of live branches of live pharmacies — `branches` joined to its one pharmacy (a
 *     many-to-one join, so no branch is repeated), `pharmacyEligible` by `eligiblePharmacyWhere`, the
 *     purchasable filter an `EXISTS` over Work 26's own fragments;
 *  2. its total, over the same `FROM`/`WHERE`;
 *  3. one `GROUP BY branchId` over the page's listings with Work 47's `listingCountColumns`.
 *
 * Three statements per page, whatever its size. Outer aliases are `br`/`ph` because the shared
 * fragments use `b`/`p` for the listing's own branch and pharmacy.
 */
@Injectable()
export class PrismaBranchOperationsReadAdapter implements IBranchOperationsReadPort {
  constructor(private readonly prisma: PrismaService) {}

  async listBranches(f: BranchOperationsFilter, page: number, size: number, now: Date = new Date()): Promise<BranchOperationsPage> {
    const { items, total } = await this.read(this.where(f, now), now, size, (page - 1) * size);
    return { items, total, page, size };
  }

  async getBranch(branchId: string, now: Date = new Date()): Promise<BranchOperationsView | null> {
    const { items } = await this.read(this.where({}, now, branchId), now, 1, 0);
    return items[0] ?? null;
  }

  private where(f: BranchOperationsFilter, now: Date, branchId?: string): Prisma.Sql {
    const purchasable = Prisma.sql`EXISTS (SELECT 1 ${AVAILABLE_LISTING_FROM}
      WHERE il."branchId" = br."id" AND ${availableListingWhere(now)} AND ${unexpiredSellablePositive(now)})`;
    const conditions: Prisma.Sql[] = [Prisma.sql`br."deletedAt" IS NULL`, Prisma.sql`ph."deletedAt" IS NULL`];
    if (branchId) conditions.push(Prisma.sql`br."id" = ${branchId}`);
    if (f.pharmacyId) conditions.push(Prisma.sql`br."pharmacyId" = ${f.pharmacyId}`);
    if (f.isActive !== undefined) conditions.push(Prisma.sql`br."isActive" = ${f.isActive}`);
    if (f.hasPurchasableInventory !== undefined) conditions.push(f.hasPurchasableInventory ? purchasable : Prisma.sql`NOT ${purchasable}`);
    if (f.createdFrom) conditions.push(Prisma.sql`br."createdAt" >= ${f.createdFrom}`);
    if (f.createdTo) conditions.push(Prisma.sql`br."createdAt" < ${f.createdTo}`);
    return Prisma.join(conditions, ' AND ');
  }

  private async read(where: Prisma.Sql, now: Date, take: number, skip: number): Promise<{ items: BranchOperationsView[]; total: number }> {
    const from = Prisma.sql`FROM "branches" br JOIN "pharmacies" ph ON ph."id" = br."pharmacyId"`;
    return this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<BranchRow[]>`
          SELECT br."id", br."pharmacyId", br."isActive", br."createdAt", br."updatedAt",
                 (${eligiblePharmacyWhere('ph', now)}) AS "pharmacyEligible"
            ${from}
           WHERE ${where}
           ORDER BY br."createdAt" DESC, br."id" DESC
           LIMIT ${take} OFFSET ${skip}`;
        const [{ count }] = await tx.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*) AS "count" ${from} WHERE ${where}`;
        if (rows.length === 0) return { items: [], total: Number(count) };
        const counts = await tx.$queryRaw<BranchListingCounts[]>`
          SELECT il."branchId" AS "branchId",
                 ${listingCountColumns(now)}
          ${AVAILABLE_LISTING_FROM}
           WHERE il."branchId" IN (${Prisma.join(rows.map((r) => r.id))})
           GROUP BY il."branchId"`;
        const byBranch = new Map(counts.map((c) => [c.branchId, c]));
        const items = rows.map((r): BranchOperationsView => ({
          branchId: r.id,
          pharmacyId: r.pharmacyId,
          isActive: r.isActive,
          pharmacyEligible: r.pharmacyEligible,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          listings: toListingCounts(byBranch.get(r.id)),
        }));
        return { items, total: Number(count) };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
