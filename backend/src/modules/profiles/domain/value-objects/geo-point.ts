import { isWithinEthiopia } from '../services/geo-bounds';

/**
 * Immutable coordinate pair with the Ethiopia geofence check (BRULE-21, module-02 §5). Pure
 * value object — no I/O, no Prisma import.
 */
export class GeoPoint {
  private constructor(
    readonly lat: number,
    readonly lng: number,
  ) {}

  static create(lat: number, lng: number): GeoPoint {
    return new GeoPoint(lat, lng);
  }

  /** True if this point falls within Ethiopia's bounding box. */
  isWithinEthiopia(): boolean {
    return GeoPoint.withinEthiopia(this.lat, this.lng);
  }

  static withinEthiopia(lat: number, lng: number): boolean {
    return isWithinEthiopia(lat, lng);
  }
}
