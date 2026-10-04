import { Injectable } from '@nestjs/common';
import { GetAvailabilityQuery } from '../../../pharmacy-inventory/application/queries/get-availability.query';
import {
  IAvailabilityPort,
  PharmacyAvailabilityCandidate,
} from '../../application/ports/outbound/availability.port';

/**
 * `IAvailabilityPort` adapter (module-05 §2.1) — a direct, in-process Nest DI injection of
 * Module 04's exported `GetAvailabilityQuery` (`PharmacyInventoryModule` is imported by
 * `PrescriptionMatchingModule`), never an HTTP round-trip, mirroring the same in-process
 * reasoning Module 04 itself uses for its own `ICatalogPort`/`IIdentityPort` adapters (module-04
 * §10.3). Translates Module 04's `AvailabilityItem[]` (one row per
 * `(catalogProductId, pharmacy, listing)`) into this module's own `PharmacyAvailabilityCandidate[]`
 * shape — the same per-line granularity, just this module's own type rather than a cross-module
 * import of Module 04's application-layer type (ADR-002).
 *
 * Deliberately does not add a rating field (§0.2 — rating is explicitly excluded from Slice 1's
 * `MatchRankingStrategy`, and Module 04's `AvailabilityItem` carries none anyway).
 */
@Injectable()
export class AvailabilityPortAdapter implements IAvailabilityPort {
  constructor(private readonly getAvailability_: GetAvailabilityQuery) {}

  async getAvailability(
    catalogProductId: string,
    geo?: { lat: number; lng: number },
  ): Promise<PharmacyAvailabilityCandidate[]> {
    const items = await this.getAvailability_.execute(catalogProductId, {
      lat: geo?.lat,
      lng: geo?.lng,
    });

    return items.map((item) => ({
      pharmacyId: item.pharmacyId,
      branchId: item.branchId,
      listingId: item.listingId,
      price: item.price,
      currency: item.currency,
      sellable: item.sellable,
      distanceMeters: item.distanceMeters,
    }));
  }
}
