/**
 * Ethiopia geofence (BRULE-21, module-02 §5). A coarse bounding box, not a precise polygon —
 * acceptable for MVP; false positives/negatives near the border are a known, accepted
 * limitation for this slice. Declared as named constants (not hardcoded inline) so a later
 * IConfigPort-backed override is a one-line change.
 */
export const ETHIOPIA_BOUNDS = {
  minLat: 3.397,
  maxLat: 14.894,
  minLng: 32.998,
  maxLng: 47.978,
} as const;

/** Pure (no I/O) check of whether a coordinate pair falls within Ethiopia's bounding box. */
export function isWithinEthiopia(lat: number, lng: number): boolean {
  return (
    lat >= ETHIOPIA_BOUNDS.minLat &&
    lat <= ETHIOPIA_BOUNDS.maxLat &&
    lng >= ETHIOPIA_BOUNDS.minLng &&
    lng <= ETHIOPIA_BOUNDS.maxLng
  );
}
