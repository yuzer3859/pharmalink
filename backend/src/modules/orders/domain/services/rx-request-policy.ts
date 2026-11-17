/**
 * Work 134 (owner decision 2026-11-17): the rules of a prescription request, pure.
 *
 * A customer sends a prescription; it is offered to every eligible pharmacy near the delivery
 * address; the first to accept owns it. Every period is configurable, because the legal limits and
 * the operating pace are not fixed yet:
 *
 * | key | default | meaning |
 * |---|---|---|
 * | `rxRequests.offerMinutes` | 30 | how long pharmacies have to accept |
 * | `rxRequests.claimMinutes` | 15 | how long the accepting pharmacy has to quote, before it is offered again |
 * | `rxRequests.radiusMeters` | 10000 | how far from the delivery address a pharmacy's branch may be |
 * | `prescriptions.maxAgeDays` | 14 | the oldest prescription accepted (proposed policy) |
 * | `prescriptions.maxAgeDaysBySchedule` | `{}` | a stricter (or looser) limit per controlled schedule, e.g. `{ "SCHEDULE_2": 7 }` (Work 135 applies it to the quoted medicines) |
 */

export const RX_REQUEST_DEFAULTS = {
  offerMinutes: 30,
  claimMinutes: 15,
  radiusMeters: 10_000,
  maxAgeDays: 14,
} as const;

/** The reason a request's offers end when the request does. */
export const RX_REQUEST_CLOSED_REASON = {
  ACCEPTED_ELSEWHERE: 'accepted-by-another-pharmacy',
  EXPIRED: 'no-pharmacy-accepted-in-time',
  NO_PHARMACY: 'no-pharmacy-available',
  CANCELLED: 'cancelled-by-customer',
  CLAIM_LAPSED: 'not-quoted-in-time',
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

type ConfigReader = { get<T>(key: string): T | undefined };

function positiveNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const RxRequestPolicy = {
  offerMinutes: (config: ConfigReader) => positiveNumber(config.get('rxRequests.offerMinutes'), RX_REQUEST_DEFAULTS.offerMinutes),
  claimMinutes: (config: ConfigReader) => positiveNumber(config.get('rxRequests.claimMinutes'), RX_REQUEST_DEFAULTS.claimMinutes),
  radiusMeters: (config: ConfigReader) => positiveNumber(config.get('rxRequests.radiusMeters'), RX_REQUEST_DEFAULTS.radiusMeters),

  /**
   * The age limit for a prescription, in days: the general limit, or the strictest limit of the
   * given controlled schedules when one is configured for them.
   */
  maxAgeDays(config: ConfigReader, schedules: readonly string[] = []): number {
    const general = positiveNumber(config.get('prescriptions.maxAgeDays'), RX_REQUEST_DEFAULTS.maxAgeDays);
    const bySchedule = config.get<Record<string, unknown>>('prescriptions.maxAgeDaysBySchedule') ?? {};
    const specific = schedules
      .map((s) => bySchedule[s])
      .filter((v) => v !== undefined)
      .map((v) => positiveNumber(v, general));
    return specific.length > 0 ? Math.min(...specific) : general;
  },

  /**
   * Why a prescription dated `issueDate` cannot be accepted on `now`, or `null` when it can. The
   * date is a calendar day: a prescription issued 14 days ago is still within a 14-day limit.
   */
  issueDateProblem(issueDate: Date, now: Date, maxAgeDays: number): string | null {
    if (Number.isNaN(issueDate.getTime())) return 'The prescription date is not a valid date.';
    const issuedDay = Date.UTC(issueDate.getUTCFullYear(), issueDate.getUTCMonth(), issueDate.getUTCDate());
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    if (issuedDay > today) return 'The prescription date cannot be in the future.';
    const ageDays = Math.round((today - issuedDay) / DAY_MS);
    if (ageDays > maxAgeDays) {
      return `The prescription is ${ageDays} days old; prescriptions older than ${maxAgeDays} days are not accepted.`;
    }
    return null;
  },

  /** Great-circle distance in whole metres. */
  distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
    const R = 6_371_000;
    const rad = (d: number) => (d * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(h))));
  },

  addMinutes: (from: Date, minutes: number) => new Date(from.getTime() + minutes * 60_000),
};
