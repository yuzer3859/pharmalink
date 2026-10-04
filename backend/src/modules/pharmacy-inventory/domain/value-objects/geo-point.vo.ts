import { PharmacyInventoryErrors } from '../errors';

/**
 * `(lat, lng)` validity wrapper (module-04 §3.8) — an independently-owned copy of Module 02's
 * `GeoPoint` pattern per ADR-002 (no cross-module import). Does not apply Module 02's
 * Ethiopia-bounding-box check — that is Address/Module 02-specific business logic.
 */
export class GeoPoint {
  private constructor(
    readonly lat: number,
    readonly lng: number,
  ) {}

  static of(lat: number, lng: number): GeoPoint {
    if (lat < -90 || lat > 90) {
      throw PharmacyInventoryErrors.validation('lat must be between -90 and 90.', { field: 'lat' });
    }
    if (lng < -180 || lng > 180) {
      throw PharmacyInventoryErrors.validation('lng must be between -180 and 180.', { field: 'lng' });
    }
    return new GeoPoint(lat, lng);
  }

  /** Both-or-neither validation for a (lat, lng) pair supplied together on a DTO. */
  static assertBothOrNeither(lat?: number | null, lng?: number | null): void {
    const hasLat = lat !== undefined && lat !== null;
    const hasLng = lng !== undefined && lng !== null;
    if (hasLat !== hasLng) {
      throw PharmacyInventoryErrors.validation('lat and lng must both be present or both be absent.', {
        field: 'lat',
      });
    }
  }
}
