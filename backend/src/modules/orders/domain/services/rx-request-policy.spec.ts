import { RX_REQUEST_DEFAULTS, RxRequestPolicy } from './rx-request-policy';

const config = (values: Record<string, unknown> = {}) => ({ get: <T>(key: string) => values[key] as T | undefined });

describe('RxRequestPolicy (Work 134)', () => {
  it('uses the defaults unless configured, and ignores nonsense values', () => {
    expect(RxRequestPolicy.offerMinutes(config())).toBe(RX_REQUEST_DEFAULTS.offerMinutes);
    expect(RxRequestPolicy.claimMinutes(config({ 'rxRequests.claimMinutes': 5 }))).toBe(5);
    expect(RxRequestPolicy.radiusMeters(config({ 'rxRequests.radiusMeters': -1 }))).toBe(10_000);
    expect(RxRequestPolicy.maxAgeDays(config())).toBe(14);
    expect(RxRequestPolicy.maxAgeDays(config({ 'prescriptions.maxAgeDays': 30 }))).toBe(30);
  });

  it('takes the strictest configured limit of the controlled schedules involved', () => {
    const c = config({ 'prescriptions.maxAgeDaysBySchedule': { SCHEDULE_2: 7, SCHEDULE_4: 10 } });
    expect(RxRequestPolicy.maxAgeDays(c, ['NONE'])).toBe(14);
    expect(RxRequestPolicy.maxAgeDays(c, ['SCHEDULE_4'])).toBe(10);
    expect(RxRequestPolicy.maxAgeDays(c, ['SCHEDULE_4', 'SCHEDULE_2', 'NONE'])).toBe(7);
  });

  it('accepts a prescription up to the limit in calendar days, and never one dated in the future', () => {
    const now = new Date('2026-11-17T18:00:00Z');
    expect(RxRequestPolicy.issueDateProblem(new Date('2026-11-03T00:00:00Z'), now, 14)).toBeNull();
    expect(RxRequestPolicy.issueDateProblem(new Date('2026-11-17T00:00:00Z'), now, 14)).toBeNull();
    expect(RxRequestPolicy.issueDateProblem(new Date('2026-11-02T00:00:00Z'), now, 14)).toMatch(/15 days old/);
    expect(RxRequestPolicy.issueDateProblem(new Date('2026-11-18T00:00:00Z'), now, 14)).toMatch(/future/);
    expect(RxRequestPolicy.issueDateProblem(new Date('nonsense'), now, 14)).toMatch(/valid date/);
  });

  it('measures distance on the globe', () => {
    const bole = { lat: 8.9806, lng: 38.7578 };
    expect(RxRequestPolicy.distanceMeters(bole, bole)).toBe(0);
    // About 1.1 km per 0.01 degree of latitude.
    expect(RxRequestPolicy.distanceMeters(bole, { lat: 8.9906, lng: 38.7578 })).toBeGreaterThan(1_100);
    expect(RxRequestPolicy.distanceMeters(bole, { lat: 8.9906, lng: 38.7578 })).toBeLessThan(1_120);
  });
});
