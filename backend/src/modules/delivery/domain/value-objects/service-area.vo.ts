import { DeliveryErrors } from '../errors';
import { GeoPoint } from './geo-point.vo';

/**
 * The ceiling on a service radius, in metres.
 *
 * 100 km is not a business rule — it is a typo guard. A driver who meant 5 km and typed 5000000
 * would otherwise declare themselves available for the whole country and be offered every job on
 * the platform, which is a dispatch failure that looks like a data-entry slip. The real policy
 * ceiling is product's to set, and when it exists it belongs in config alongside
 * `delivery.maxConcurrentJobs`, not here.
 */
export const MAX_SERVICE_RADIUS_METERS = 100_000;

/** Below this a radius is a point, and no job would ever match it. */
export const MIN_SERVICE_RADIUS_METERS = 100;

/**
 * Where a driver is willing to work (`architecture/module-08-delivery-tracking.md` §3.1 F-DRV-01's
 * "service area", §8's `driver_profiles.service_area`).
 *
 * ## Why a centre and a radius
 *
 * The design writes the column as "jsonb/geo" and leaves the shape open. This is the simplest
 * structure that §6's dispatch can actually consume — "find eligible, available, **nearby**
 * drivers" is a distance comparison, and a centre plus a radius is the least that answers it —
 * and it is the same `RADIUS` idea Module 04 already uses for branch coverage
 * (`service_zones.type = RADIUS`, `radius_meters`). Reusing an established shape is the point;
 * inventing a second vocabulary for "how far will you go" would mean dispatch had to understand
 * both.
 *
 * ## Why not a list of subcity names
 *
 * Ethiopian addresses in this platform are region/city/subcity/woreda strings (Modules 02 and 04),
 * so naming the areas a driver serves looks like the natural fit. It is not, for one concrete
 * reason: **there is no canonical list of those names anywhere in the repository.** `addresses`
 * and `branches` both store them as free-typed, nullable text. Matching a job's dropoff against a
 * driver's area would then be string equality between two pieces of free text — "Bole" against
 * "bole", "Nifas Silk-Lafto" against "Nifas Silk Lafto" — and a driver would silently receive no
 * work with no way to discover why. A radius has no spelling.
 *
 * §14's geohash/PostGIS indexing extends this (the centre is what gets indexed); it does not
 * replace it.
 */
export class ServiceArea {
  private constructor(
    readonly center: GeoPoint,
    readonly radiusMeters: number,
  ) {}

  static of(center: GeoPoint, radiusMeters: number): ServiceArea {
    if (!Number.isFinite(radiusMeters) || !Number.isInteger(radiusMeters)) {
      throw DeliveryErrors.validation('radiusMeters must be a whole number of metres.', {
        field: 'radiusMeters',
      });
    }
    if (radiusMeters < MIN_SERVICE_RADIUS_METERS || radiusMeters > MAX_SERVICE_RADIUS_METERS) {
      throw DeliveryErrors.validation(
        `radiusMeters must be between ${MIN_SERVICE_RADIUS_METERS} and ${MAX_SERVICE_RADIUS_METERS}.`,
        { field: 'radiusMeters', min: MIN_SERVICE_RADIUS_METERS, max: MAX_SERVICE_RADIUS_METERS },
      );
    }
    return new ServiceArea(center, radiusMeters);
  }

  /**
   * Reads a persisted `service_area` JSON value, returning `null` for anything unrecognisable.
   *
   * Defensive rather than strict, deliberately, and this is the one place in the module where
   * that choice is made consciously: a `Json` column has no compile-time shape, and a profile
   * whose service area was written by an older schema must still load. A driver with an
   * unreadable area is a driver dispatch will not consider — visible, correctable, and far better
   * than a read that throws and takes the whole profile with it.
   */
  static fromJson(value: unknown): ServiceArea | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    const { lat, lng, radiusMeters } = record;
    if (
      typeof lat !== 'number' ||
      typeof lng !== 'number' ||
      typeof radiusMeters !== 'number'
    ) {
      return null;
    }
    try {
      return ServiceArea.of(GeoPoint.of(lat, lng), radiusMeters);
    } catch {
      return null;
    }
  }

  toJson(): { lat: number; lng: number; radiusMeters: number } {
    return { lat: this.center.lat, lng: this.center.lng, radiusMeters: this.radiusMeters };
  }

  equals(other: ServiceArea): boolean {
    return this.center.equals(other.center) && this.radiusMeters === other.radiusMeters;
  }
}
