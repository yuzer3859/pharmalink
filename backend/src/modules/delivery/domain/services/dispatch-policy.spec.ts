import { DriverProfileProps } from '../entities/driver-profile.entity';
import { DriverAvailability } from '../enums';
import { GeoPoint } from '../value-objects/geo-point.vo';
import { ServiceArea } from '../value-objects/service-area.vo';
import {
  FAIRNESS_WEIGHT,
  haversineMeters,
  PROXIMITY_SCALE_METERS,
  PROXIMITY_WEIGHT,
  rankCandidates,
  servesPickup,
} from './dispatch-policy';

const PICKUP = GeoPoint.of(9.03, 38.74);
const SHIFT = new Date('2026-09-17T06:00:00.000Z');

let seq = 0;

function driver(overrides: Partial<DriverProfileProps> = {}): DriverProfileProps {
  seq += 1;
  return {
    id: `driver-${String(seq).padStart(3, '0')}`,
    userId: `user-${seq}`,
    vehicle: null,
    serviceArea: null,
    availability: DriverAvailability.ONLINE,
    shiftStartedAt: SHIFT,
    lastOnlineAt: SHIFT,
    maxConcurrent: null,
    lastLocation: PICKUP,
    lastLocationAt: SHIFT,
    createdAt: SHIFT,
    updatedAt: SHIFT,
    ...overrides,
  };
}

function rank(
  drivers: DriverProfileProps[],
  counts: Record<string, number> = {},
  excluded: string[] = [],
) {
  return rankCandidates(drivers, {
    pickup: PICKUP,
    platformConcurrentLimit: 1,
    activeJobCounts: new Map(Object.entries(counts)),
    excludedDriverIds: new Set(excluded),
  });
}

describe('haversineMeters', () => {
  it('is zero for a point against itself', () => {
    expect(haversineMeters(PICKUP, PICKUP)).toBe(0);
  });

  it('is symmetric', () => {
    const other = GeoPoint.of(8.98, 38.79);
    expect(haversineMeters(PICKUP, other)).toBeCloseTo(haversineMeters(other, PICKUP), 6);
  });

  it('measures a known separation', () => {
    // One degree of latitude is ~111.2km anywhere on Earth — the one distance that can be
    // asserted without trusting the implementation being tested.
    const north = GeoPoint.of(PICKUP.lat + 1, PICKUP.lng);
    expect(haversineMeters(PICKUP, north)).toBeGreaterThan(110_000);
    expect(haversineMeters(PICKUP, north)).toBeLessThan(112_000);
  });

  it('measures a short city distance sensibly', () => {
    // Bole to Kazanchis, roughly 7km apart.
    const kazanchis = GeoPoint.of(8.98, 38.79);
    const metres = haversineMeters(PICKUP, kazanchis);
    expect(metres).toBeGreaterThan(5_000);
    expect(metres).toBeLessThan(10_000);
  });
});

describe('servesPickup', () => {
  it('admits a driver who has declared no service area', () => {
    // Fail-open: a freshly created profile has `serviceArea === null`, and treating that as
    // "serves nowhere" would make every new driver invisibly undispatchable.
    expect(servesPickup(driver({ serviceArea: null }), PICKUP)).toBe(true);
  });

  it('admits a driver whose radius covers the pickup', () => {
    const area = ServiceArea.of(PICKUP, 5_000);
    expect(servesPickup(driver({ serviceArea: area }), PICKUP)).toBe(true);
  });

  it('excludes a driver whose radius does not reach the pickup', () => {
    const faraway = ServiceArea.of(GeoPoint.of(11.6, 37.39), 5_000); // Bahir Dar
    expect(servesPickup(driver({ serviceArea: faraway }), PICKUP)).toBe(false);
  });

  it('admits at exactly the radius', () => {
    const north = GeoPoint.of(PICKUP.lat + 1, PICKUP.lng);
    const metres = Math.ceil(haversineMeters(PICKUP, north));
    const area = ServiceArea.of(PICKUP, Math.min(metres, 100_000));
    // The boundary is inclusive; a driver who said "5km" serves a pickup exactly 5km away.
    expect(servesPickup(driver({ serviceArea: area }), GeoPoint.of(PICKUP.lat, PICKUP.lng))).toBe(
      true,
    );
  });

  it('does not apply an area to a job with no pickup coordinate', () => {
    // The job-creation work degrades to a null pickup when the branch is soft-deleted. Nothing
    // can be excluded on a distance that does not exist.
    const area = ServiceArea.of(PICKUP, 1_000);
    expect(servesPickup(driver({ serviceArea: area }), null)).toBe(true);
  });
});

describe('rankCandidates', () => {
  // -------------------------------------------------------------------------------------------
  // Eligibility filters
  // -------------------------------------------------------------------------------------------
  describe('filters', () => {
    it('admits an online, on-shift, idle driver', () => {
      const d = driver();
      expect(rank([d]).map((c) => c.driver.id)).toEqual([d.id]);
    });

    it('excludes an OFFLINE driver', () => {
      expect(rank([driver({ availability: DriverAvailability.OFFLINE })])).toHaveLength(0);
    });

    it('excludes a BUSY driver', () => {
      // Redundant with the capacity filter, and applied anyway so the two can never disagree.
      expect(rank([driver({ availability: DriverAvailability.BUSY })])).toHaveLength(0);
    });

    it('excludes a driver with no open shift', () => {
      expect(rank([driver({ shiftStartedAt: null })])).toHaveLength(0);
    });

    it('excludes a driver outside their own service area', () => {
      const faraway = ServiceArea.of(GeoPoint.of(11.6, 37.39), 5_000);
      expect(rank([driver({ serviceArea: faraway })])).toHaveLength(0);
    });

    it('excludes a driver already at the concurrent-job limit', () => {
      const d = driver();
      expect(rank([d], { [d.id]: 1 })).toHaveLength(0);
    });

    it('admits a driver under a raised per-driver limit', () => {
      const d = driver({ maxConcurrent: 3 });
      expect(rank([d], { [d.id]: 2 })).toHaveLength(1);
    });

    it('excludes a driver at their raised per-driver limit', () => {
      const d = driver({ maxConcurrent: 3 });
      expect(rank([d], { [d.id]: 3 })).toHaveLength(0);
    });

    it('excludes an explicitly excluded driver', () => {
      const d = driver();
      expect(rank([d], {}, [d.id])).toHaveLength(0);
    });

    it('keeps every other driver when one is excluded', () => {
      const a = driver();
      const b = driver();
      expect(rank([a, b], {}, [a.id]).map((c) => c.driver.id)).toEqual([b.id]);
    });
  });

  // -------------------------------------------------------------------------------------------
  // Ranking
  // -------------------------------------------------------------------------------------------
  describe('ranking', () => {
    it('prefers the closer of two idle drivers', () => {
      const near = driver({ lastLocation: PICKUP });
      const far = driver({ lastLocation: GeoPoint.of(9.09, 38.80) });

      expect(rank([far, near]).map((c) => c.driver.id)).toEqual([near.id, far.id]);
    });

    it('prefers the less loaded of two equidistant drivers', () => {
      const idle = driver({ maxConcurrent: 4 });
      const busy = driver({ maxConcurrent: 4 });

      expect(rank([busy, idle], { [busy.id]: 3 }).map((c) => c.driver.id)).toEqual([
        idle.id,
        busy.id,
      ]);
    });

    it('lets proximity outweigh a small load difference', () => {
      // The weights are 0.7/0.3, so a driver at the pickup beats one 15km away even when the
      // nearer one is carrying more — which is the trade the weighting is chosen to make.
      const nearLoaded = driver({ maxConcurrent: 4, lastLocation: PICKUP });
      const farIdle = driver({ maxConcurrent: 4, lastLocation: GeoPoint.of(9.2, 38.9) });

      expect(rank([farIdle, nearLoaded], { [nearLoaded.id]: 1 })[0].driver.id).toBe(
        nearLoaded.id,
      );
    });

    it('ranks a driver with no known location below every located driver', () => {
      const located = driver({ lastLocation: GeoPoint.of(9.2, 38.9), lastLocationAt: SHIFT });
      const unlocated = driver({ lastLocation: null, lastLocationAt: null });

      const ranked = rank([unlocated, located]);
      expect(ranked.map((c) => c.driver.id)).toEqual([located.id, unlocated.id]);
      // Included, not excluded: a driver who just came online has no fix yet.
      expect(ranked).toHaveLength(2);
      expect(ranked[1].distanceMeters).toBeNull();
    });

    it('scores between 0 and 1', () => {
      const ranked = rank([driver(), driver({ lastLocation: null })]);
      for (const candidate of ranked) {
        expect(candidate.score).toBeGreaterThanOrEqual(0);
        expect(candidate.score).toBeLessThanOrEqual(1);
      }
    });

    it('gives an idle driver at the pickup the maximum score', () => {
      expect(rank([driver()])[0].score).toBeCloseTo(PROXIMITY_WEIGHT + FAIRNESS_WEIGHT, 10);
    });

    it('gives no proximity credit beyond the scale distance', () => {
      const atScale = driver({
        lastLocation: GeoPoint.of(PICKUP.lat + PROXIMITY_SCALE_METERS / 111_000, PICKUP.lng),
      });
      const farBeyond = driver({ lastLocation: GeoPoint.of(PICKUP.lat + 3, PICKUP.lng) });

      const ranked = rank([atScale, farBeyond]);
      // Both are at or past the scale, so proximity contributes nothing and they tie on score.
      expect(ranked[0].score).toBeCloseTo(ranked[1].score, 6);
    });

    it('reports the inputs to the score, not only the score', () => {
      const d = driver({ maxConcurrent: 3 });
      const [candidate] = rank([d], { [d.id]: 1 });

      expect(candidate.activeJobCount).toBe(1);
      expect(candidate.limit).toBe(3);
      expect(candidate.distanceMeters).toBeCloseTo(0, 6);
    });

    it('breaks ties deterministically and identically across runs', () => {
      // Dispatch re-runs after every decline and expiry. A ranking that reordered equal
      // candidates between runs could offer one driver the same job twice and skip another.
      const a = driver({ id: 'driver-zzz' } as Partial<DriverProfileProps>);
      const b = driver({ id: 'driver-aaa' } as Partial<DriverProfileProps>);

      const first = rank([a, b]).map((c) => c.driver.id);
      const second = rank([b, a]).map((c) => c.driver.id);
      expect(first).toEqual(second);
      expect(first[0]).toBe('driver-aaa');
    });

    it('returns an empty list when nobody is eligible', () => {
      expect(rank([driver({ availability: DriverAvailability.OFFLINE })])).toEqual([]);
    });

    it('is pure — it does not mutate the input array or the profiles', () => {
      const drivers = [driver(), driver()];
      const snapshot = JSON.stringify(drivers);
      rank(drivers);
      expect(JSON.stringify(drivers)).toBe(snapshot);
    });
  });
});
