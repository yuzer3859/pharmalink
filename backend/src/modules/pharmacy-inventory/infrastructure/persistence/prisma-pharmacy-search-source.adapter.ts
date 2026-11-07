import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  IPharmacySearchSourcePort,
  SearchAvailabilityOffer,
  SearchPharmacySource,
} from '../../application/ports/inbound/pharmacy-search-source.port';
import { IListingRepository, LISTING_REPOSITORY } from '../../domain/repositories/listing.repository';
import { LicenseStatus, TransactingStatus } from '../../domain/enums';
import { TransactingEligibilityPolicy } from '../../domain/services/transacting-eligibility.policy';

/** Work 98: Module 04's search source, over its own tables and its own availability rule. */
@Injectable()
export class PrismaPharmacySearchSourceAdapter implements IPharmacySearchSourcePort {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(LISTING_REPOSITORY) private readonly listings: IListingRepository,
  ) {}

  async offersForProduct(catalogProductId: string, limit = 500): Promise<SearchAvailabilityOffer[]> {
    const rows = await this.listings.findAvailability(catalogProductId, new Date(), limit);
    if (rows.length === 0) return [];
    const [pharmacies, branches] = await Promise.all([
      this.prisma.pharmacy.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.pharmacyId))] } }, select: { id: true, displayName: true } }),
      this.prisma.branch.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.branchId))] } }, select: { id: true, name: true, city: true } }),
    ]);
    const pharmacyName = new Map(pharmacies.map((p) => [p.id, p.displayName]));
    const branch = new Map(branches.map((b) => [b.id, b]));
    return rows.map((r) => ({
      pharmacyId: r.pharmacyId,
      pharmacyName: pharmacyName.get(r.pharmacyId) ?? '',
      branchId: r.branchId,
      branchName: branch.get(r.branchId)?.name ?? '',
      city: branch.get(r.branchId)?.city ?? null,
      lat: r.lat,
      lng: r.lng,
      listingId: r.listingId,
      price: r.price,
      currency: r.currency,
      sellable: r.sellable,
    }));
  }

  async productOfListing(listingId: string): Promise<string | null> {
    const row = await this.prisma.inventoryListing.findUnique({ where: { id: listingId }, select: { catalogProductId: true } });
    return row?.catalogProductId ?? null;
  }

  async productsOfPharmacy(pharmacyId: string): Promise<string[]> {
    const rows = await this.prisma.inventoryListing.findMany({ where: { pharmacyId }, select: { catalogProductId: true }, distinct: ['catalogProductId'] });
    return rows.map((r) => r.catalogProductId);
  }

  async pharmacy(pharmacyId: string): Promise<SearchPharmacySource | null> {
    const row = await this.prisma.pharmacy.findFirst({
      where: { id: pharmacyId, deletedAt: null },
      include: { branches: { where: { isActive: true, deletedAt: null }, select: { id: true, name: true, city: true, lat: true, lng: true } } },
    });
    if (!row) return null;
    return {
      pharmacyId: row.id,
      name: row.displayName,
      description: row.description,
      eligible: TransactingEligibilityPolicy.isEligible({
        transactingStatus: row.transactingStatus as TransactingStatus,
        licenseStatus: row.licenseStatus as LicenseStatus,
        licenseExpiresAt: row.licenseExpiresAt,
      }),
      ratingAvg: row.ratingAvg,
      branches: row.branches.map((b) => ({ branchId: b.id, name: b.name, city: b.city, lat: b.lat, lng: b.lng })),
    };
  }

  async pharmacyIds(): Promise<string[]> {
    return (await this.prisma.pharmacy.findMany({ where: { deletedAt: null }, select: { id: true }, orderBy: { createdAt: 'asc' } })).map((p) => p.id);
  }
}
