import { ErrorCode } from '../../../../shared/errors/error-codes';
import { ApiException } from '../../../../shared/errors/api-exception';
import { DeliveryJobStatus, DriverAvailability } from '../enums';
import {
  ACTIVE_JOB_STATUSES,
  hasCapacity,
  isConsistent,
  isDriverSettableAvailability,
  resolveConcurrentLimit,
} from '../services/driver-availability-policy';
import { DeliveryStatusPolicy } from '../services/delivery-status-policy';
import { GeoPoint } from '../value-objects/geo-point.vo';
import { ServiceArea } from '../value-objects/service-area.vo';
import { Vehicle, VehicleType } from '../value-objects/vehicle.vo';
import { DriverProfile, MAX_LOCATION_CLOCK_SKEW_MS } from './driver-profile.entity';

const USER = 'user-1';
const NOW = new Date('2026-09-16T08:00:00.000Z');

function newProfile(overrides: Partial<Parameters<typeof DriverProfile.create>[0]> = {}) {
  return DriverProfile.create({ id: 'profile-1', userId: USER, now: NOW, ...overrides });
}

/** A profile already on shift, the precondition for anything availability-related. */
function onShift() {
  return newProfile().startShift(NOW);
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as ApiException).code;
  }
  throw new Error('expected a throw');
}

describe('DriverProfile', () => {
  // -------------------------------------------------------------------------------------------
  // 1. Creation
  // -------------------------------------------------------------------------------------------
  describe('create', () => {
    it('starts OFFLINE and off shift', () => {
      const props = newProfile().toProps();
      expect(props.availability).toBe(DriverAvailability.OFFLINE);
      expect(props.shiftStartedAt).toBeNull();
      expect(props.lastOnlineAt).toBeNull();
    });

    it('carries the vehicle, service area and concurrent-job override it is given', () => {
      const area = ServiceArea.of(GeoPoint.of(9.03, 38.74), 5_000);
      const props = newProfile({
        vehicle: Vehicle.of(VehicleType.Motorcycle, 'AA-12345'),
        serviceArea: area,
        maxConcurrent: 3,
      }).toProps();

      expect(props.vehicle?.type).toBe(VehicleType.Motorcycle);
      expect(props.vehicle?.plateNumber).toBe('AA-12345');
      expect(props.serviceArea?.equals(area)).toBe(true);
      expect(props.maxConcurrent).toBe(3);
    });

    it('records no location at all', () => {
      const props = newProfile().toProps();
      expect(props.lastLocation).toBeNull();
      expect(props.lastLocationAt).toBeNull();
    });

    it('normalises a non-positive concurrent-job override to "no override"', () => {
      // Stored as null so the column and `resolveConcurrentLimit` agree. A stored 0 would
      // otherwise sit in the database while the policy quietly ignored it.
      expect(newProfile({ maxConcurrent: 0 }).toProps().maxConcurrent).toBeNull();
      expect(newProfile({ maxConcurrent: -2 }).toProps().maxConcurrent).toBeNull();
      expect(newProfile({ maxConcurrent: 1.5 }).toProps().maxConcurrent).toBeNull();
    });

    it('refuses a blank userId', () => {
      expect(codeOf(() => newProfile({ userId: '  ' }))).toBe(ErrorCode.VALIDATION_ERROR);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 2. Shift transitions
  // -------------------------------------------------------------------------------------------
  describe('shift', () => {
    it('starts a shift', () => {
      expect(newProfile().startShift(NOW).toProps().shiftStartedAt).toEqual(NOW);
    });

    it('is idempotent and keeps the original start time', () => {
      const first = newProfile().startShift(NOW);
      const later = new Date(NOW.getTime() + 3 * 3_600_000);
      const second = first.startShift(later);

      // Same instance, so a caller can detect "nothing changed" without comparing fields — and
      // the morning's start time is not erased by a reconnect three hours in.
      expect(second).toBe(first);
      expect(second.toProps().shiftStartedAt).toEqual(NOW);
    });

    it('ends a shift', () => {
      expect(onShift().endShift(NOW).toProps().shiftStartedAt).toBeNull();
    });

    it('forces OFFLINE when a shift ends while the driver is online', () => {
      const online = onShift().setAvailability(DriverAvailability.ONLINE, NOW);
      const ended = online.endShift(NOW);

      expect(ended.toProps().shiftStartedAt).toBeNull();
      expect(ended.toProps().availability).toBe(DriverAvailability.OFFLINE);
    });

    it('is idempotent when no shift is open', () => {
      const off = newProfile();
      expect(off.endShift(NOW)).toBe(off);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 3. Availability transitions
  // -------------------------------------------------------------------------------------------
  describe('availability', () => {
    it('goes online while on shift and stamps lastOnlineAt', () => {
      const online = onShift().setAvailability(DriverAvailability.ONLINE, NOW);
      expect(online.toProps().availability).toBe(DriverAvailability.ONLINE);
      expect(online.toProps().lastOnlineAt).toEqual(NOW);
    });

    it('goes offline again without ending the shift', () => {
      const offline = onShift()
        .setAvailability(DriverAvailability.ONLINE, NOW)
        .setAvailability(DriverAvailability.OFFLINE, NOW);

      expect(offline.toProps().availability).toBe(DriverAvailability.OFFLINE);
      // A break is not the end of a shift.
      expect(offline.toProps().shiftStartedAt).toEqual(NOW);
    });

    it('is idempotent and does not restamp lastOnlineAt on a repeat', () => {
      const online = onShift().setAvailability(DriverAvailability.ONLINE, NOW);
      const later = new Date(NOW.getTime() + 60_000);
      const again = online.setAvailability(DriverAvailability.ONLINE, later);

      expect(again).toBe(online);
      expect(again.toProps().lastOnlineAt).toEqual(NOW);
    });

    it('refuses ONLINE without an open shift', () => {
      expect(codeOf(() => newProfile().setAvailability(DriverAvailability.ONLINE, NOW))).toBe(
        ErrorCode.CONFLICT,
      );
    });

    it('refuses BUSY, which is dispatch’s to set', () => {
      expect(codeOf(() => onShift().setAvailability(DriverAvailability.BUSY, NOW))).toBe(
        ErrorCode.CONFLICT,
      );
    });
  });

  // -------------------------------------------------------------------------------------------
  // 4. Contradictory states are unrepresentable
  // -------------------------------------------------------------------------------------------
  describe('invariants', () => {
    it('refuses to rehydrate a row that is ONLINE with no open shift', () => {
      const props = { ...newProfile().toProps(), availability: DriverAvailability.ONLINE };
      expect(codeOf(() => DriverProfile.rehydrate(props))).toBe(ErrorCode.CONFLICT);
    });

    it('refuses to rehydrate a row that is BUSY with no open shift', () => {
      // BUSY is not driver-settable but is rehydratable, so the invariant has to cover it too —
      // otherwise dispatch could write a state the aggregate would then refuse to load.
      const props = { ...newProfile().toProps(), availability: DriverAvailability.BUSY };
      expect(codeOf(() => DriverProfile.rehydrate(props))).toBe(ErrorCode.CONFLICT);
    });

    it('accepts BUSY while a shift is open', () => {
      const props = { ...onShift().toProps(), availability: DriverAvailability.BUSY };
      expect(DriverProfile.rehydrate(props).toProps().availability).toBe(
        DriverAvailability.BUSY,
      );
    });

    it('accepts OFFLINE while on shift — a break is not a contradiction', () => {
      expect(DriverProfile.rehydrate(onShift().toProps()).isOnShift).toBe(true);
    });

    it('refuses a location with no timestamp, and a timestamp with no location', () => {
      const base = onShift().toProps();
      expect(
        codeOf(() =>
          DriverProfile.rehydrate({ ...base, lastLocation: GeoPoint.of(9, 38) }),
        ),
      ).toBe(ErrorCode.VALIDATION_ERROR);
      expect(
        codeOf(() => DriverProfile.rehydrate({ ...base, lastLocationAt: NOW })),
      ).toBe(ErrorCode.VALIDATION_ERROR);
    });

    it('refuses a non-positive stored concurrent-job override', () => {
      const props = { ...newProfile().toProps(), maxConcurrent: 0 };
      expect(codeOf(() => DriverProfile.rehydrate(props))).toBe(ErrorCode.VALIDATION_ERROR);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 5. Location
  // -------------------------------------------------------------------------------------------
  describe('recordLocation', () => {
    const point = GeoPoint.of(9.03, 38.74);

    it('records a first fix', () => {
      const props = newProfile().recordLocation(point, NOW, NOW).toProps();
      expect(props.lastLocation?.equals(point)).toBe(true);
      expect(props.lastLocationAt).toEqual(NOW);
    });

    it('applies a newer fix', () => {
      const later = new Date(NOW.getTime() + 10_000);
      const moved = GeoPoint.of(9.04, 38.75);
      const props = newProfile()
        .recordLocation(point, NOW, NOW)
        .recordLocation(moved, later, later)
        .toProps();

      expect(props.lastLocation?.equals(moved)).toBe(true);
      expect(props.lastLocationAt).toEqual(later);
    });

    it('ignores a stale fix rather than moving the driver backwards', () => {
      // The buffered-replay case (NFR-LOC-04): the app reconnects and flushes points it took
      // while offline. Applying one would drag the driver back on the customer's live map.
      const current = newProfile().recordLocation(point, NOW, NOW);
      const stale = new Date(NOW.getTime() - 300_000);
      const after = current.recordLocation(GeoPoint.of(9.1, 38.9), stale, NOW);

      expect(after).toBe(current);
      expect(after.toProps().lastLocation?.equals(point)).toBe(true);
    });

    it('ignores a fix with exactly the stored timestamp', () => {
      const current = newProfile().recordLocation(point, NOW, NOW);
      expect(current.recordLocation(GeoPoint.of(9.1, 38.9), NOW, NOW)).toBe(current);
    });

    it('throws on a timestamp far ahead of the server clock', () => {
      // A badly-set handset, not a buffered replay. Accepting it would write a `lastLocationAt`
      // no genuine later fix could beat, freezing the driver until the clock caught up.
      const future = new Date(NOW.getTime() + MAX_LOCATION_CLOCK_SKEW_MS + 1_000);
      expect(codeOf(() => newProfile().recordLocation(point, future, NOW))).toBe(
        ErrorCode.VALIDATION_ERROR,
      );
    });

    it('tolerates ordinary clock skew', () => {
      const slightlyAhead = new Date(NOW.getTime() + MAX_LOCATION_CLOCK_SKEW_MS - 1_000);
      expect(
        newProfile().recordLocation(point, slightlyAhead, NOW).toProps().lastLocationAt,
      ).toEqual(slightlyAhead);
    });

    it('throws on an invalid date', () => {
      expect(
        codeOf(() => newProfile().recordLocation(point, new Date('nonsense'), NOW)),
      ).toBe(ErrorCode.VALIDATION_ERROR);
    });

    it('records a location while OFFLINE', () => {
      // A driver mid-route who goes offline is exactly when last-known position matters most.
      const props = newProfile().recordLocation(point, NOW, NOW).toProps();
      expect(props.availability).toBe(DriverAvailability.OFFLINE);
      expect(props.lastLocation).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------------------------
  // 6. Details
  // -------------------------------------------------------------------------------------------
  describe('updateDetails', () => {
    it('leaves absent keys alone and clears explicit nulls', () => {
      const area = ServiceArea.of(GeoPoint.of(9.03, 38.74), 5_000);
      const profile = newProfile({
        vehicle: Vehicle.of(VehicleType.Car, 'AA-1'),
        serviceArea: area,
      });

      const vehicleOnly = profile.updateDetails({ vehicle: null, now: NOW });
      expect(vehicleOnly.toProps().vehicle).toBeNull();
      // "I did not mention my service area" is not "I no longer restrict where I work".
      expect(vehicleOnly.toProps().serviceArea?.equals(area)).toBe(true);
    });

    it('never changes availability or shift', () => {
      const online = onShift().setAvailability(DriverAvailability.ONLINE, NOW);
      const updated = online.updateDetails({ maxConcurrent: 4, now: NOW });
      expect(updated.toProps().availability).toBe(DriverAvailability.ONLINE);
      expect(updated.toProps().shiftStartedAt).toEqual(NOW);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 7. Immutability
  // -------------------------------------------------------------------------------------------
  it('never mutates the instance a transition was called on', () => {
    const before = newProfile();
    const snapshot = before.toProps();
    before.startShift(NOW).setAvailability(DriverAvailability.ONLINE, NOW);
    expect(before.toProps()).toEqual(snapshot);
  });

  it('never hands out a reference into its own state', () => {
    const profile = onShift();
    const props = profile.toProps();
    props.availability = DriverAvailability.ONLINE;
    expect(profile.toProps().availability).toBe(DriverAvailability.OFFLINE);
  });
});

describe('DriverAvailabilityPolicy', () => {
  describe('isConsistent', () => {
    it('requires an open shift for every working availability', () => {
      expect(isConsistent(DriverAvailability.ONLINE, null)).toBe(false);
      expect(isConsistent(DriverAvailability.BUSY, null)).toBe(false);
      expect(isConsistent(DriverAvailability.OFFLINE, null)).toBe(true);
    });

    it('allows any availability inside an open shift', () => {
      for (const availability of Object.values(DriverAvailability)) {
        expect(isConsistent(availability, NOW)).toBe(true);
      }
    });
  });

  describe('driver-settable availability', () => {
    it('is exactly ONLINE and OFFLINE', () => {
      expect(isDriverSettableAvailability(DriverAvailability.ONLINE)).toBe(true);
      expect(isDriverSettableAvailability(DriverAvailability.OFFLINE)).toBe(true);
      expect(isDriverSettableAvailability(DriverAvailability.BUSY)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------------------------
  // The concurrent-job limit (BRULE-28)
  // -------------------------------------------------------------------------------------------
  describe('resolveConcurrentLimit', () => {
    it('prefers a per-driver override', () => {
      expect(resolveConcurrentLimit(3, 1)).toBe(3);
    });

    it('falls back to the platform default when there is no override', () => {
      expect(resolveConcurrentLimit(null, 2)).toBe(2);
      expect(resolveConcurrentLimit(undefined, 2)).toBe(2);
    });

    it('treats a non-positive or fractional override as no override', () => {
      // Zero would permanently remove a driver from dispatch, which nothing in the design
      // describes a way to express. The safe reading of an ambiguous limit is the platform's.
      expect(resolveConcurrentLimit(0, 2)).toBe(2);
      expect(resolveConcurrentLimit(-1, 2)).toBe(2);
      expect(resolveConcurrentLimit(1.5, 2)).toBe(2);
    });
  });

  describe('hasCapacity', () => {
    it('is strictly less than the limit', () => {
      expect(hasCapacity(0, 1)).toBe(true);
      expect(hasCapacity(1, 1)).toBe(false);
      expect(hasCapacity(2, 1)).toBe(false);
      expect(hasCapacity(2, 3)).toBe(true);
    });
  });

  describe('ACTIVE_JOB_STATUSES', () => {
    it('spans assignment to the doorstep', () => {
      expect([...ACTIVE_JOB_STATUSES]).toEqual([
        DeliveryJobStatus.ASSIGNED,
        DeliveryJobStatus.ARRIVED_PICKUP,
        DeliveryJobStatus.PICKED_UP,
        DeliveryJobStatus.EN_ROUTE,
        DeliveryJobStatus.ARRIVED_DROPOFF,
      ]);
    });

    it('excludes every terminal state', () => {
      const terminal = Object.values(DeliveryJobStatus).filter((s) =>
        DeliveryStatusPolicy.isTerminal(s),
      );
      expect(terminal.length).toBeGreaterThan(0);
      for (const status of terminal) {
        expect(ACTIVE_JOB_STATUSES).not.toContain(status);
      }
    });

    it('excludes the states in which no driver holds the job', () => {
      // CREATED and OFFERED have no assigned driver at all; REASSIGNING is the driver being
      // released, and `DeliveryStatusPolicy` proves they never get the job back.
      for (const status of [
        DeliveryJobStatus.CREATED,
        DeliveryJobStatus.OFFERED,
        DeliveryJobStatus.REASSIGNING,
      ]) {
        expect(ACTIVE_JOB_STATUSES).not.toContain(status);
      }
      expect([...DeliveryStatusPolicy.nextStates(DeliveryJobStatus.REASSIGNING)]).not.toContain(
        DeliveryJobStatus.ASSIGNED,
      );
    });

    it('agrees with the status policy that every active state requires a driver', () => {
      // The two tables are maintained separately and nothing enforces their agreement, so it is
      // asserted: a state where a driver is counted as busy must be one the job says needs one.
      for (const status of ACTIVE_JOB_STATUSES) {
        expect(DeliveryStatusPolicy.requiresAssignedDriver(status)).toBe(true);
      }
    });
  });
});
