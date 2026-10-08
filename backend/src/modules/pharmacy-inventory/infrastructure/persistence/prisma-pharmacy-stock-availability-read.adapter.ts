import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  IPharmacyStockAvailabilityReadPort,
  PharmacyStockAvailabilityView,
} from '../../application/ports/inbound/pharmacy-stock-availability-read.port';
import { LicenseStatus, TransactingStatus } from '../../domain/enums';

/**
 * `IPharmacyStockAvailabilityReadPort` over Prisma — two `COUNT`s in one `REPEATABLE READ`
 * transaction. The pharmacy predicate is `TransactingEligibilityPolicy`, as in
 * `PrismaPharmacyAnalyticsReadAdapter`; the listing predicate is `findAvailability`'s listing and
 * branch conditions, as a relation filter (`EXISTS`), so no row is loaded.
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
    const [eligibleCount, withAvailableStock] = await this.prisma.$transaction(
      [
        this.prisma.pharmacy.count({ where: eligible }),
        this.prisma.pharmacy.count({
          where: {
            ...eligible,
            listings: { some: { isEnabled: true, deletedAt: null, sellable: { gt: 0 }, branch: { isActive: true } } },
          },
        }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return { eligible: eligibleCount, withAvailableStock, withoutAvailableStock: eligibleCount - withAvailableStock };
  }
}
