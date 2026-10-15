import {
  ReservationIntegrityDiscrepancy,
  ReservationIntegrityPage,
  ReservationIntegritySummary,
} from '../../../pharmacy-inventory/application/ports/inbound/reservation-integrity-read.port';

/** One discrepant live listing — listing-level quantities only; no reservation, order or owner detail. */
export interface ReservationIntegrityDiscrepancyResponse {
  listingId: string;
  pharmacyId: string;
  branchId: string;
  catalogProductId: string;
  storedReserved: number;
  reservationDerivedReserved: number;
  difference: number;
  contributingReservations: number;
}

export interface ReservationIntegrityListResponse {
  generatedAt: string;
  items: ReservationIntegrityDiscrepancyResponse[];
  total: number;
  page: number;
  size: number;
}

export interface ReservationIntegritySummaryResponse {
  generatedAt: string;
  listingsChecked: number;
  listingsConsistent: number;
  listingsWithDiscrepancy: number;
  listingsUndetermined: number;
}

// Explicit allow-lists, never spreads of port objects.
export function toReservationIntegrityDiscrepancyResponse(d: ReservationIntegrityDiscrepancy): ReservationIntegrityDiscrepancyResponse {
  return {
    listingId: d.listingId,
    pharmacyId: d.pharmacyId,
    branchId: d.branchId,
    catalogProductId: d.catalogProductId,
    storedReserved: d.storedReserved,
    reservationDerivedReserved: d.reservationDerivedReserved,
    difference: d.difference,
    contributingReservations: d.contributingReservations,
  };
}

export function toReservationIntegrityListResponse(p: ReservationIntegrityPage): ReservationIntegrityListResponse {
  return { generatedAt: p.generatedAt.toISOString(), items: p.items.map(toReservationIntegrityDiscrepancyResponse), total: p.total, page: p.page, size: p.size };
}

export function toReservationIntegritySummaryResponse(s: ReservationIntegritySummary): ReservationIntegritySummaryResponse {
  return {
    generatedAt: s.generatedAt.toISOString(),
    listingsChecked: s.listingsChecked,
    listingsConsistent: s.listingsConsistent,
    listingsWithDiscrepancy: s.listingsWithDiscrepancy,
    listingsUndetermined: s.listingsUndetermined,
  };
}
