import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  IPharmacyAnalyticsReadPort,
  LicenseStatus,
  PharmacyAnalyticsView,
  TransactingStatus,
} from '../../application/ports/inbound/pharmacy-analytics-read.port';

/**
 * `IPharmacyAnalyticsReadPort` over Prisma — counts and two `GROUP BY`s, all in PostgreSQL. The
 * eligibility count is `TransactingEligibilityPolicy` written as a `WHERE`, identical to the
 * provider half of `PrismaListingRepository.findAvailability`'s predicate.
 */
@Injectable()
export class PrismaPharmacyAnalyticsReadAdapter implements IPharmacyAnalyticsReadPort {
  constructor(private readonly prisma: PrismaService) {}

  async summarizeProviders(now: Date = new Date()): Promise<PharmacyAnalyticsView> {
    const live = { deletedAt: null };
    const [
      pharmacyTotal,
      eligible,
      byTransacting,
      byLicense,
      branchTotal,
      branchActive,
      listingTotal,
      listingEnabled,
      listingInStock,
    ] = await Promise.all([
      this.prisma.pharmacy.count({ where: live }),
      this.prisma.pharmacy.count({
        where: {
          ...live,
          transactingStatus: TransactingStatus.ACTIVE,
          licenseStatus: LicenseStatus.VALID,
          OR: [{ licenseExpiresAt: null }, { licenseExpiresAt: { gt: now } }],
        },
      }),
      this.prisma.pharmacy.groupBy({ by: ['transactingStatus'], where: live, _count: { _all: true } }),
      this.prisma.pharmacy.groupBy({ by: ['licenseStatus'], where: live, _count: { _all: true } }),
      this.prisma.branch.count({ where: live }),
      this.prisma.branch.count({ where: { ...live, isActive: true } }),
      this.prisma.inventoryListing.count({ where: live }),
      this.prisma.inventoryListing.count({ where: { ...live, isEnabled: true } }),
      this.prisma.inventoryListing.count({ where: { ...live, isEnabled: true, sellable: { gt: 0 } } }),
    ]);
    const transacting = new Map(byTransacting.map((g) => [g.transactingStatus as string, g._count._all]));
    const license = new Map(byLicense.map((g) => [g.licenseStatus as string, g._count._all]));
    return {
      pharmacies: {
        total: pharmacyTotal,
        eligible,
        byTransactingStatus: Object.values(TransactingStatus).map((status) => ({
          status,
          count: transacting.get(status) ?? 0,
        })),
        byLicenseStatus: Object.values(LicenseStatus).map((status) => ({
          status,
          count: license.get(status) ?? 0,
        })),
      },
      branches: {
        total: branchTotal,
        active: branchActive,
        inactive: branchTotal - branchActive,
      },
      listings: {
        total: listingTotal,
        enabled: listingEnabled,
        disabled: listingTotal - listingEnabled,
        inStock: listingInStock,
        outOfStock: listingEnabled - listingInStock,
      },
    };
  }
}
