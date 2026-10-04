import { DeliveryErrors } from '../errors';

/**
 * `(lat, lng)` validity wrapper (`architecture/module-08-delivery-tracking.md` §5.2's `GeoPoint`)
 * — an independently-owned copy of the pattern Modules 02 and 04 each already keep, per ADR-002
 * (no cross-module import). The shape is reused; the implementation is not.
 *
 * Like Module 04's copy, it does **not** apply Module 02's Ethiopia bounding box. That check is
 * Address-specific business logic, and applying it here would be wrong in a way that matters: a
 * pickup or dropoff point is a snapshot of where a delivery actually happens, and a job whose
 * coordinates fell marginally outside a bounding box must not become unrepresentable — the
 * coordinate is evidence, not a claim.
 */
export class GeoPoint {
  private constructor(
    readonly lat: number,
    readonly lng: number,
  ) {}

  static of(lat: number, lng: number): GeoPoint {
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      throw DeliveryErrors.validation('lat must be a number between -90 and 90.', { field: 'lat' });
    }
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
      throw DeliveryErrors.validation('lng must be a number between -180 and 180.', {
        field: 'lng',
      });
    }
    return new GeoPoint(lat, lng);
  }

  /**
   * Both-or-neither validation for a `(lat, lng)` pair, returning the point or `null`.
   *
   * A half-supplied coordinate is rejected rather than silently dropped: `delivery_jobs` stores
   * `pickupLat`/`pickupLng` as independently nullable columns, so nothing at the database level
   * stops one being written without the other, and a point with a latitude and no longitude is
   * not a location — it is a bug that would surface later as a dispatch sending a driver to the
   * prime meridian.
   */
  static optional(lat?: number | null, lng?: number | null): GeoPoint | null {
    const hasLat = lat !== undefined && lat !== null;
    const hasLng = lng !== undefined && lng !== null;
    if (hasLat !== hasLng) {
      throw DeliveryErrors.validation('lat and lng must both be present or both be absent.', {
        field: hasLat ? 'lng' : 'lat',
      });
    }
    return hasLat ? GeoPoint.of(lat as number, lng as number) : null;
  }

  equals(other: GeoPoint): boolean {
    return this.lat === other.lat && this.lng === other.lng;
  }
}
