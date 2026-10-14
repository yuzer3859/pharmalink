import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  IPharmacyOperationsReadPort,
  LicenseStatus,
  PharmacyOperationsFilter,
  PharmacyOperationsPage,
  PharmacyOperationsView,
  TransactingStatus,
} from '../../application/ports/inbound/pharmacy-operations-read.port';
import { AVAILABLE_LISTING_FROM, availableListingWhere, eligiblePharmacyWhere, unexpiredSellablePositive } from './listing-availability.sql';

interface PharmacyRow {
  id: string;
  transactingStatus: TransactingStatus;
  licenseStatus: LicenseStatus;
  licenseExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  eligible: boolean;
}
interface ListingCounts { pharmacyId: string; total: bigint; enabled: bigint; inStock: bigint; purchasable: bigint }
interface BranchCounts { pharmacyId: string; total: bigint; active: bigint }

/**
 * `IPharmacyOperationsReadPort` over Prisma, all in PostgreSQL inside one REPEATABLE READ transaction:
 *
 *  1. the page of live pharmacies — one statement, `eligible` computed by `eligiblePharmacyWhere`, the
 *     purchasable-inventory filter an `EXISTS` over Work 26's own fragments (`AVAILABLE_LISTING_FROM`,
 *     `availableListingWhere`, `unexpiredSellablePositive`);
 *  2. its total, over the same `WHERE`;
 *  3. one `GROUP BY pharmacyId` over the page's listings and 4. one over its branches.
 *
 * Counts never multiply: (1) and (2) read `pharmacies` alone (the `EXISTS` returns no rows), and each
 * grouped query counts one table's rows per pharmacy. Four statements per page, whatever its size.
 * The outer alias is `ph` because the shared fragments use `p` for the listing's own pharmacy.
 */
@Injectable()
export class PrismaPharmacyOperationsReadAdapter implements IPharmacyOperationsReadPort {
  constructor(private readonly prisma: PrismaService) {}

  async listPharmacies(f: PharmacyOperationsFilter, page: number, size: number, now: Date = new Date()): Promise<PharmacyOperationsPage> {
    const { items, total } = await this.read(this.where(f, now), now, size, (page - 1) * size);
    return { items, total, page, size };
  }

  async getPharmacy(pharmacyId: string, now: Date = new Date()): Promise<PharmacyOperationsView | null> {
    const { items } = await this.read(this.where({}, now, pharmacyId), now, 1, 0);
    return items[0] ?? null;
  }

  private where(f: PharmacyOperationsFilter, now: Date, pharmacyId?: string): Prisma.Sql {
    const eligible = eligiblePharmacyWhere('ph', now);
    const purchasable = Prisma.sql`EXISTS (SELECT 1 ${AVAILABLE_LISTING_FROM}
      WHERE il."pharmacyId" = ph."id" AND ${availableListingWhere(now)} AND ${unexpiredSellablePositive(now)})`;
    const conditions: Prisma.Sql[] = [Prisma.sql`ph."deletedAt" IS NULL`];
    if (pharmacyId) conditions.push(Prisma.sql`ph."id" = ${pharmacyId}`);
    if (f.transactingStatus) conditions.push(Prisma.sql`ph."transactingStatus" = ${f.transactingStatus}::"TransactingStatus"`);
    if (f.eligible !== undefined) conditions.push(f.eligible ? Prisma.sql`(${eligible})` : Prisma.sql`NOT (${eligible})`);
    if (f.hasPurchasableInventory !== undefined) conditions.push(f.hasPurchasableInventory ? purchasable : Prisma.sql`NOT ${purchasable}`);
    if (f.createdFrom) conditions.push(Prisma.sql`ph."createdAt" >= ${f.createdFrom}`);
    if (f.createdTo) conditions.push(Prisma.sql`ph."createdAt" < ${f.createdTo}`);
    return Prisma.join(conditions, ' AND ');
  }

  private async read(where: Prisma.Sql, now: Date, take: number, skip: number): Promise<{ items: PharmacyOperationsView[]; total: number }> {
    return this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<PharmacyRow[]>`
          SELECT ph."id", ph."transactingStatus", ph."licenseStatus", ph."licenseExpiresAt", ph."createdAt", ph."updatedAt",
                 (${eligiblePharmacyWhere('ph', now)}) AS "eligible"
            FROM "pharmacies" ph
           WHERE ${where}
           ORDER BY ph."createdAt" DESC, ph."id" DESC
           LIMIT ${take} OFFSET ${skip}`;
        const [{ count }] = await tx.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*) AS "count" FROM "pharmacies" ph WHERE ${where}`;
        if (rows.length === 0) return { items: [], total: Number(count) };
        const ids = Prisma.join(rows.map((r) => r.id));
        const listingCounts = await tx.$queryRaw<ListingCounts[]>`
          SELECT il."pharmacyId" AS "pharmacyId",
                 COUNT(*) FILTER (WHERE il."deletedAt" IS NULL) AS "total",
                 COUNT(*) FILTER (WHERE il."deletedAt" IS NULL AND il."isEnabled" = true) AS "enabled",
                 COUNT(*) FILTER (WHERE il."deletedAt" IS NULL AND il."isEnabled" = true AND il."sellable" > 0) AS "inStock",
                 COUNT(*) FILTER (WHERE ${availableListingWhere(now)} AND ${unexpiredSellablePositive(now)}) AS "purchasable"
          ${AVAILABLE_LISTING_FROM}
           WHERE il."pharmacyId" IN (${ids})
           GROUP BY il."pharmacyId"`;
        const branchCounts = await tx.$queryRaw<BranchCounts[]>`
          SELECT b."pharmacyId" AS "pharmacyId",
                 COUNT(*) FILTER (WHERE b."deletedAt" IS NULL) AS "total",
                 COUNT(*) FILTER (WHERE b."deletedAt" IS NULL AND b."isActive" = true) AS "active"
            FROM "branches" b
           WHERE b."pharmacyId" IN (${ids})
           GROUP BY b."pharmacyId"`;
        const listings = new Map(listingCounts.map((c) => [c.pharmacyId, c]));
        const branches = new Map(branchCounts.map((c) => [c.pharmacyId, c]));
        const items = rows.map((r): PharmacyOperationsView => {
          const l = listings.get(r.id);
          const b = branches.get(r.id);
          const total = Number(l?.total ?? 0);
          const enabled = Number(l?.enabled ?? 0);
          const inStock = Number(l?.inStock ?? 0);
          const purchasable = Number(l?.purchasable ?? 0);
          return {
            pharmacyId: r.id,
            transactingStatus: r.transactingStatus,
            licenseStatus: r.licenseStatus,
            licenseExpiresAt: r.licenseExpiresAt,
            eligible: r.eligible,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
            branches: { total: Number(b?.total ?? 0), active: Number(b?.active ?? 0) },
            listings: {
              total,
              enabled,
              disabled: total - enabled,
              inStock,
              outOfStock: enabled - inStock,
              customerPurchasable: purchasable,
              customerUnpurchasable: total - purchasable,
            },
          };
        });
        return { items, total: Number(count) };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
