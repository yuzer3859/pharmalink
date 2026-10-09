import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  IPharmacyStockAvailabilityReadPort,
  ListingPurchasabilityView,
  PharmacyStockAvailabilityView,
} from '../../application/ports/inbound/pharmacy-stock-availability-read.port';
import { LicenseStatus, TransactingStatus } from '../../domain/enums';
import { AVAILABLE_LISTING_FROM, availableListingWhere, unexpiredSellablePositive } from './listing-availability.sql';

/**
 * `IPharmacyStockAvailabilityReadPort` over Prisma — `COUNT`s in one `REPEATABLE READ` transaction
 * each. The pharmacy predicate is `TransactingEligibilityPolicy`, as in
 * `PrismaPharmacyAnalyticsReadAdapter`; the availability predicate is `findAvailability`'s own SQL
 * (`listing-availability.sql`), so no row is loaded and no rule is written a second time.
 */
@Injectable()
export class PrismaPharmacyStockAvailabilityReadAdapter implements IPharmacyStockAvailabilityReadPort {
  constructor(private readonly prisma: PrismaService) {}

  async summarizeStockAvailability(now: Date = new Date()): Promise<PharmacyStockAvailabilityView> {
    const eligible: Prisma.PharmacyWhereInput = {
      deletedAt: null,
      transactingStatus: TransactingStatus.ACTIVE,
      licenseStatus: LicenseStatus.VALID,
      OR: [{ licenseExpiresAt: null }, { licenseExpiresAt: { gt: now } }],
    };
    const [eligibleCount, [{ count }]] = await this.prisma.$transaction(
      [
        this.prisma.pharmacy.count({ where: eligible }),
        // Pharmacies `findAvailability` would return for some product (its predicate includes eligibility).
        this.prisma.$queryRaw<Array<{ count: bigint }>>`
          SELECT COUNT(DISTINCT il."pharmacyId") AS "count" ${AVAILABLE_LISTING_FROM}
          WHERE ${availableListingWhere(now)}`,
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    const withAvailableStock = Number(count);
    return { eligible: eligibleCount, withAvailableStock, withoutAvailableStock: eligibleCount - withAvailableStock };
  }

  async summarizeListingPurchasability(now: Date = new Date()): Promise<ListingPurchasabilityView> {
    const [tracked, [{ count }]] = await this.prisma.$transaction(
      [
        // The `listings.total` population of `PrismaPharmacyAnalyticsReadAdapter`.
        this.prisma.inventoryListing.count({ where: { deletedAt: null } }),
        this.prisma.$queryRaw<Array<{ count: bigint }>>`
          SELECT COUNT(*) AS "count" ${AVAILABLE_LISTING_FROM}
          WHERE ${availableListingWhere(now)}
            AND ${unexpiredSellablePositive(now)}`,
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    const purchasable = Number(count);
    return { tracked, purchasable, unpurchasable: tracked - purchasable };
  }
}
