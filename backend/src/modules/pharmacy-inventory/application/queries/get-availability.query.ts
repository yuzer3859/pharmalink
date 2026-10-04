import { Inject, Injectable } from '@nestjs/common';
import { IListingRepository, LISTING_REPOSITORY } from '../../domain/repositories/listing.repository';

export interface AvailabilityItem {
  pharmacyId: string;
  branchId: string;
  listingId: string;
  price: number;
  currency: string;
  sellable: number;
  distanceMeters?: number;
  storageRequirement: string;
}

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * `GET /availability/product/:catalogProductId` (module-04 §5.5, §10.3, §15). Excludes
 * ineligible pharmacies and disabled/zero-sellable/soft-deleted listings at the repository
 * level. Response shape is a strict allowlist — never leaks license/compliance/staff/batch/
 * supplier data (§15).
 */
@Injectable()
export class GetAvailabilityQuery {
  constructor(@Inject(LISTING_REPOSITORY) private readonly listings: IListingRepository) {}

  async execute(
    catalogProductId: string,
    filters: { lat?: number; lng?: number; radiusMeters?: number; limit?: number },
  ): Promise<AvailabilityItem[]> {
    const limit = filters.limit ?? 20;
    const rows = await this.listings.findAvailability(catalogProductId, new Date(), Math.max(limit, 100));

    let items: AvailabilityItem[] = rows.map((r) => ({
      pharmacyId: r.pharmacyId,
      branchId: r.branchId,
      listingId: r.listingId,
      price: r.price,
      currency: r.currency,
      sellable: r.sellable,
      storageRequirement: r.storageRequirement,
      ...(filters.lat !== undefined && filters.lng !== undefined && r.lat !== null && r.lng !== null
        ? { distanceMeters: haversineMeters(filters.lat, filters.lng, r.lat, r.lng) }
        : {}),
    }));

    if (filters.lat !== undefined && filters.lng !== undefined) {
      if (filters.radiusMeters !== undefined) {
        items = items.filter((i) => i.distanceMeters === undefined || i.distanceMeters <= filters.radiusMeters!);
      }
      items = items.sort((a, b) => (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity));
    } else {
      items = items.sort((a, b) => a.price - b.price);
    }

    return items.slice(0, limit);
  }
}
