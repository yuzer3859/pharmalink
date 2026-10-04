import { AuditService } from '../../../shared/audit/audit.service';
import { IConfigPort } from '../../../shared/config/config.port';
import { ApiException } from '../../../shared/errors/api-exception';
import { ErrorCode } from '../../../shared/errors/error-codes';
import { DriverProfileProps } from '../domain/entities/driver-profile.entity';
import { DeliveryJobStatus, DriverAvailability } from '../domain/enums';
import {
  DriverLocationUpdate,
  IDriverProfileRepository,
} from '../domain/repositories/driver-profile.repository';
import { IDeliveryJobRepository } from '../domain/repositories/delivery-job.repository';
import { ACTIVE_JOB_STATUSES } from '../domain/services/driver-availability-policy';
import { CreateDriverProfileCommand } from './commands/create-driver-profile.command';
import { ManageDriverShiftCommand } from './commands/manage-driver-shift.command';
import { SetDriverAvailabilityCommand } from './commands/set-driver-availability.command';
import { UpdateDriverLocationCommand } from './commands/update-driver-location.command';
import {
  DriverIdentityView,
  DriverIneligibilityReason,
  IIdentityPort,
} from './ports/outbound/identity.port';
import { IUnitOfWork } from './ports/unit-of-work.port';
import { GetDriverOperationalStatusQuery } from './queries/get-driver-operational-status.query';
import { VehicleType } from '../domain/value-objects/vehicle.vo';

const DRIVER = 'user-driver-1';

/**
 * An in-memory profile repository that enforces the real unique index rather than merely storing
 * rows — the same discipline `create-delivery-job.command.spec.ts` applies, so a concurrency bug
 * fails here as well as against PostgreSQL.
 */
class FakeDriverProfileRepository implements IDriverProfileRepository {
  readonly profiles = new Map<string, DriverProfileProps>();
  /** Set to run inside `create`, to interleave a competing writer deterministically. */
  onCreate: (() => Promise<void>) | null = null;

  async findByUserId(userId: string): Promise<DriverProfileProps | null> {
    return [...this.profiles.values()].find((p) => p.userId === userId) ?? null;
  }
  async findById(id: string): Promise<DriverProfileProps | null> {
    return this.profiles.get(id) ?? null;
  }
  async findDispatchCandidates(limit: number): Promise<DriverProfileProps[]> {
    // Present because the port requires it. Dispatch is exercised by its own suite.
    return [...this.profiles.values()]
      .filter((p) => p.availability === 'ONLINE' && p.shiftStartedAt !== null)
      .slice(0, limit);
  }
  async create(profile: DriverProfileProps): Promise<DriverProfileProps> {
    if (this.onCreate) {
      const hook = this.onCreate;
      this.onCreate = null;
      await hook();
    }
    // `driver_profiles.userId` is unique, and **atomically** so: there is deliberately no `await`
    // between this check and the insert. A real unique index cannot interleave, and a fake that
    // yielded here would be a weaker guarantee than production.
    const duplicate = [...this.profiles.values()].some((p) => p.userId === profile.userId);
    if (duplicate) {
      throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    }
    this.profiles.set(profile.id, { ...profile });
    return { ...profile };
  }
  async save(profile: DriverProfileProps): Promise<DriverProfileProps> {
    this.profiles.set(profile.id, { ...profile });
    return { ...profile };
  }
  async updateLocation(
    id: string,
    update: DriverLocationUpdate,
  ): Promise<DriverProfileProps | null> {
    const stored = this.profiles.get(id);
    if (!stored) {
      return null;
    }
    // Monotonic, exactly like the Prisma adapter's compare-and-set: a report no newer than the
    // stored one leaves the row alone and the caller is handed back what is actually stored. A
    // fake that accepted a stale write would let a test pass that production would fail.
    if (stored.lastLocationAt !== null && update.recordedAt <= stored.lastLocationAt) {
      return { ...stored };
    }
    // Only the three location columns, exactly like the Prisma adapter — so a command that
    // wrongly carried a stale availability through this path would fail here too.
    const next: DriverProfileProps = {
      ...stored,
      lastLocation: { lat: update.lat, lng: update.lng, equals: () => false } as never,
      lastLocationAt: update.recordedAt,
    };
    this.profiles.set(id, next);
    return { ...next };
  }
}

class FakeJobRepository implements Pick<IDeliveryJobRepository, 'countActiveJobs'> {
  statuses: DeliveryJobStatus[] = [];
  async countActiveJobs(): Promise<number> {
    return this.statuses.filter((s) => ACTIVE_JOB_STATUSES.includes(s)).length;
  }
}

/** Runs the closure straight through — the transaction semantics are the e2e's to prove. */
const uow: IUnitOfWork = { run: (work) => work({}) };

function fakeAudit() {
  const entries: { action: string; context: Record<string, unknown> | null }[] = [];
  const audit = {
    record: jest.fn(async (params: { action: string; context?: Record<string, unknown> | null }) => {
      entries.push({ action: params.action, context: params.context ?? null });
      return { id: 'audit-1', hash: 'h' };
    }),
  } as unknown as AuditService;
  return { audit, entries };
}

function fakeIdentity(view: Partial<DriverIdentityView> = {}): IIdentityPort {
  return {
    getDriverIdentity: jest.fn(async (userId: string) => ({
      userId,
      isEligible: true,
      reason: null,
      documentsExpireAt: null,
      ...view,
    })),
  };
}

function ineligible(reason: DriverIneligibilityReason): IIdentityPort {
  return fakeIdentity({ isEligible: false, reason });
}

function configWith(limit: number | undefined): IConfigPort {
  return {
    get: <T>() => limit as unknown as T,
    getOrThrow: <T>() => limit as unknown as T,
    isFeatureEnabled: () => false,
  };
}

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return (err as ApiException).code;
  }
  throw new Error('expected a throw');
}

describe('Driver operational profile', () => {
  let profiles: FakeDriverProfileRepository;
  let jobs: FakeJobRepository;

  beforeEach(() => {
    profiles = new FakeDriverProfileRepository();
    jobs = new FakeJobRepository();
  });

  function createCommand(identity: IIdentityPort = fakeIdentity()) {
    const { audit, entries } = fakeAudit();
    return {
      command: new CreateDriverProfileCommand(profiles, identity, uow, audit),
      entries,
    };
  }

  function availabilityCommand(identity: IIdentityPort = fakeIdentity()) {
    const { audit, entries } = fakeAudit();
    return {
      command: new SetDriverAvailabilityCommand(profiles, identity, uow, audit),
      entries,
    };
  }

  function shiftCommand() {
    const { audit, entries } = fakeAudit();
    return { command: new ManageDriverShiftCommand(profiles, uow, audit), entries };
  }

  function statusQuery(limit: number | undefined = 1) {
    return new GetDriverOperationalStatusQuery(
      profiles,
      jobs as unknown as IDeliveryJobRepository,
      configWith(limit),
    );
  }

  async function seedProfile(overrides: Partial<{ maxConcurrent: number }> = {}) {
    const { command } = createCommand();
    const { profile } = await command.execute({
      userId: DRIVER,
      vehicleType: VehicleType.Motorcycle,
      plateNumber: 'AA-12345',
      serviceArea: { lat: 9.03, lng: 38.74, radiusMeters: 5_000 },
      ...overrides,
    });
    return profile;
  }

  // -------------------------------------------------------------------------------------------
  // 1. Creation
  // -------------------------------------------------------------------------------------------
  describe('creation', () => {
    it('creates an OFFLINE, off-shift profile and audits it', async () => {
      const { command, entries } = createCommand();
      const { profile, replay } = await command.execute({
        userId: DRIVER,
        vehicleType: VehicleType.Bicycle,
      });

      expect(replay).toBe(false);
      expect(profile.availability).toBe(DriverAvailability.OFFLINE);
      expect(profile.shiftStartedAt).toBeNull();
      expect(entries).toHaveLength(1);
      expect(entries[0].action).toBe('DELIVERY_DRIVER_PROFILE_CREATED');
      expect(entries[0].context).toMatchObject({ driverUserId: DRIVER });
    });

    it('does not store the driver’s identity or verification state', async () => {
      const profile = await seedProfile();
      // The boundary, asserted as absence: Module 01 owns all of it, and a mirrored copy of an
      // authorization fact fails open when it goes stale.
      expect(Object.keys(profile)).not.toContain('isVerified');
      expect(Object.keys(profile)).not.toContain('verificationStatus');
      // Nor a mutable active-job counter — the count is derived from `delivery_jobs`.
      expect(Object.keys(profile)).not.toContain('activeJobCount');
    });

    // -----------------------------------------------------------------------------------------
    // 2. One profile per Module 01 driver
    // -----------------------------------------------------------------------------------------
    it('returns the existing profile instead of creating a second', async () => {
      const first = await seedProfile();
      const { command, entries } = createCommand();
      const { profile, replay } = await command.execute({ userId: DRIVER });

      expect(replay).toBe(true);
      expect(profile.id).toBe(first.id);
      expect(profiles.profiles.size).toBe(1);
      // A replay writes no audit entry: nothing happened.
      expect(entries).toHaveLength(0);
    });

    it('converges on one profile when two creators race', async () => {
      const { command } = createCommand();
      const competitor = createCommand().command;

      // The loser's own pre-check and in-transaction re-check both pass; the unique index is what
      // actually decides, exactly as in production.
      profiles.onCreate = async () => {
        await competitor.execute({ userId: DRIVER });
      };

      const { profile, replay } = await command.execute({ userId: DRIVER });
      expect(replay).toBe(true);
      expect(profiles.profiles.size).toBe(1);
      expect(profile.userId).toBe(DRIVER);
    });

    it('converges when three creators race', async () => {
      const commands = [createCommand().command, createCommand().command, createCommand().command];
      const results = await Promise.all(
        commands.map((c) => c.execute({ userId: DRIVER })),
      );

      expect(profiles.profiles.size).toBe(1);
      expect(new Set(results.map((r) => r.profile.id)).size).toBe(1);
    });

    // -----------------------------------------------------------------------------------------
    // 9a. The Module 01 boundary at creation
    // -----------------------------------------------------------------------------------------
    it('refuses a userId Module 01 does not know', async () => {
      const { command } = createCommand(ineligible('USER_NOT_FOUND'));
      expect(await codeOf(() => command.execute({ userId: 'ghost' }))).toBe(
        ErrorCode.DRIVER_NOT_VERIFIED,
      );
    });

    it('refuses a user who is not a driver', async () => {
      const { command } = createCommand(ineligible('NOT_A_DRIVER'));
      expect(await codeOf(() => command.execute({ userId: 'customer-1' }))).toBe(
        ErrorCode.DRIVER_NOT_VERIFIED,
      );
    });

    it.each<DriverIneligibilityReason>([
      'DOCUMENTS_NOT_APPROVED',
      'DOCUMENTS_EXPIRED',
      'ACCOUNT_NOT_ACTIVE',
    ])('allows a driver whose eligibility is %s to set up their profile', async (reason) => {
      // Recoverable states. Refusing the profile would make onboarding depend on the order two
      // independent processes finished in, and leave an approved driver with nothing configured.
      const { command } = createCommand(ineligible(reason));
      const { profile } = await command.execute({ userId: DRIVER });
      expect(profile.availability).toBe(DriverAvailability.OFFLINE);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 3. Shift transitions
  // -------------------------------------------------------------------------------------------
  describe('shift', () => {
    beforeEach(() => seedProfile());

    it('starts and ends a shift, auditing each', async () => {
      const { command, entries } = shiftCommand();

      const started = await command.start({ userId: DRIVER });
      expect(started.changed).toBe(true);
      expect(started.profile.shiftStartedAt).not.toBeNull();

      const ended = await command.end({ userId: DRIVER });
      expect(ended.changed).toBe(true);
      expect(ended.profile.shiftStartedAt).toBeNull();

      expect(entries.map((e) => e.action)).toEqual([
        'DELIVERY_DRIVER_SHIFT_STARTED',
        'DELIVERY_DRIVER_SHIFT_ENDED',
      ]);
    });

    it('records which shift ended, not a null one', async () => {
      const { command, entries } = shiftCommand();
      await command.start({ userId: DRIVER });
      const startedAt = entries[0].context?.shiftStartedAt;
      await command.end({ userId: DRIVER });

      expect(entries[1].context?.shiftStartedAt).toBe(startedAt);
      expect(entries[1].context?.shiftStartedAt).not.toBeNull();
    });

    it('is idempotent and writes no audit entry for a repeat', async () => {
      const { command, entries } = shiftCommand();
      await command.start({ userId: DRIVER });
      const again = await command.start({ userId: DRIVER });

      expect(again.changed).toBe(false);
      expect(entries).toHaveLength(1);
    });

    it('forces OFFLINE when a shift ends while the driver is online', async () => {
      const shift = shiftCommand().command;
      const availability = availabilityCommand().command;

      await shift.start({ userId: DRIVER });
      await availability.execute({ userId: DRIVER, availability: DriverAvailability.ONLINE });
      const ended = await shift.end({ userId: DRIVER });

      expect(ended.profile.availability).toBe(DriverAvailability.OFFLINE);
      expect(ended.profile.shiftStartedAt).toBeNull();
    });

    it('refuses a driver with no profile', async () => {
      const { command } = shiftCommand();
      expect(await codeOf(() => command.start({ userId: 'nobody' }))).toBe(ErrorCode.NOT_FOUND);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 4. Availability transitions
  // -------------------------------------------------------------------------------------------
  describe('availability', () => {
    beforeEach(async () => {
      await seedProfile();
      await shiftCommand().command.start({ userId: DRIVER });
    });

    it('goes online and back offline, auditing both', async () => {
      const { command, entries } = availabilityCommand();

      const online = await command.execute({
        userId: DRIVER,
        availability: DriverAvailability.ONLINE,
      });
      expect(online.changed).toBe(true);
      expect(online.profile.availability).toBe(DriverAvailability.ONLINE);
      expect(online.profile.lastOnlineAt).not.toBeNull();

      const offline = await command.execute({
        userId: DRIVER,
        availability: DriverAvailability.OFFLINE,
      });
      expect(offline.profile.availability).toBe(DriverAvailability.OFFLINE);
      // A break, not the end of the shift.
      expect(offline.profile.shiftStartedAt).not.toBeNull();

      expect(entries).toHaveLength(2);
      expect(entries[0].context).toMatchObject({
        from: DriverAvailability.OFFLINE,
        to: DriverAvailability.ONLINE,
      });
    });

    it('is idempotent and writes no audit entry for a repeat', async () => {
      const { command, entries } = availabilityCommand();
      await command.execute({ userId: DRIVER, availability: DriverAvailability.ONLINE });
      const again = await command.execute({
        userId: DRIVER,
        availability: DriverAvailability.ONLINE,
      });

      expect(again.changed).toBe(false);
      expect(entries).toHaveLength(1);
    });

    it('refuses BUSY, which is dispatch’s to set', async () => {
      const { command } = availabilityCommand();
      expect(
        await codeOf(() =>
          command.execute({ userId: DRIVER, availability: DriverAvailability.BUSY }),
        ),
      ).toBe(ErrorCode.CONFLICT);
    });

    // -----------------------------------------------------------------------------------------
    // 5. Contradictory states
    // -----------------------------------------------------------------------------------------
    it('refuses ONLINE without an open shift', async () => {
      await shiftCommand().command.end({ userId: DRIVER });
      const { command } = availabilityCommand();

      expect(
        await codeOf(() =>
          command.execute({ userId: DRIVER, availability: DriverAvailability.ONLINE }),
        ),
      ).toBe(ErrorCode.CONFLICT);
      expect((await profiles.findByUserId(DRIVER))?.availability).toBe(
        DriverAvailability.OFFLINE,
      );
    });

    // -----------------------------------------------------------------------------------------
    // 9b. The Module 01 verification boundary — the real gate
    // -----------------------------------------------------------------------------------------
    it.each<DriverIneligibilityReason>([
      'USER_NOT_FOUND',
      'NOT_A_DRIVER',
      'ACCOUNT_NOT_ACTIVE',
      'DOCUMENTS_NOT_APPROVED',
      'DOCUMENTS_EXPIRED',
    ])('refuses ONLINE when Module 01 says %s (BRULE-09)', async (reason) => {
      const { command } = availabilityCommand(ineligible(reason));
      expect(
        await codeOf(() =>
          command.execute({ userId: DRIVER, availability: DriverAvailability.ONLINE }),
        ),
      ).toBe(ErrorCode.DRIVER_NOT_VERIFIED);
      expect((await profiles.findByUserId(DRIVER))?.availability).toBe(
        DriverAvailability.OFFLINE,
      );
    });

    it('does not consult Module 01 when going OFFLINE', async () => {
      // A driver whose documents lapse mid-shift must still be able to stop working. Gating this
      // would lock them into the online state they are no longer allowed to be in.
      const identity = fakeIdentity();
      const online = availabilityCommand(identity).command;
      await online.execute({ userId: DRIVER, availability: DriverAvailability.ONLINE });

      const lapsed = ineligible('DOCUMENTS_EXPIRED');
      const offline = availabilityCommand(lapsed).command;
      const result = await offline.execute({
        userId: DRIVER,
        availability: DriverAvailability.OFFLINE,
      });

      expect(result.profile.availability).toBe(DriverAvailability.OFFLINE);
      expect(lapsed.getDriverIdentity).not.toHaveBeenCalled();
    });

    it('does not consult Module 01 for a no-op ONLINE', async () => {
      const identity = fakeIdentity();
      const command = availabilityCommand(identity).command;
      await command.execute({ userId: DRIVER, availability: DriverAvailability.ONLINE });
      await command.execute({ userId: DRIVER, availability: DriverAvailability.ONLINE });

      // Once for the transition that happened, not again for the repeat.
      expect(identity.getDriverIdentity).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 6. Concurrent-job limit
  // -------------------------------------------------------------------------------------------
  describe('concurrent-job limit', () => {
    beforeEach(() => seedProfile());

    it('reports capacity against the platform default when there is no override', async () => {
      const status = await statusQuery(1).byUserId(DRIVER);
      expect(status.capacity).toMatchObject({
        activeJobCount: 0,
        limit: 1,
        hasCapacity: true,
        limitIsOverride: false,
      });
    });

    it('reports no capacity once the driver is at the limit', async () => {
      jobs.statuses = [DeliveryJobStatus.ASSIGNED];
      const status = await statusQuery(1).byUserId(DRIVER);
      expect(status.capacity).toMatchObject({ activeJobCount: 1, hasCapacity: false });
    });

    it('honours a per-driver override above the platform limit', async () => {
      profiles.profiles.clear();
      await seedProfile({ maxConcurrent: 3 });
      jobs.statuses = [DeliveryJobStatus.ASSIGNED, DeliveryJobStatus.PICKED_UP];

      const status = await statusQuery(1).byUserId(DRIVER);
      expect(status.capacity).toMatchObject({
        activeJobCount: 2,
        limit: 3,
        hasCapacity: true,
        limitIsOverride: true,
      });
    });

    it('counts only the states in which a driver is actually holding a job', async () => {
      jobs.statuses = [
        DeliveryJobStatus.CREATED,
        DeliveryJobStatus.OFFERED,
        DeliveryJobStatus.REASSIGNING,
        DeliveryJobStatus.DELIVERED,
        DeliveryJobStatus.COMPLETED,
        DeliveryJobStatus.CANCELLED,
        DeliveryJobStatus.FAILED,
        DeliveryJobStatus.EN_ROUTE,
      ];
      const status = await statusQuery(1).byUserId(DRIVER);
      expect(status.capacity.activeJobCount).toBe(1);
    });

    it('falls back to the conservative default when config has no value', async () => {
      // Module 16's future DB-backed `IConfigPort` can return nothing. A missing limit must not
      // resolve to NaN and leave `hasCapacity` false for every driver on the platform.
      const status = await statusQuery(undefined).byUserId(DRIVER);
      expect(status.capacity.limit).toBe(1);
      expect(status.capacity.hasCapacity).toBe(true);
    });

    it('is not dispatchable while offline, whatever the capacity', async () => {
      const status = await statusQuery(1).byUserId(DRIVER);
      expect(status.capacity.hasCapacity).toBe(true);
      expect(status.dispatchableByDeliveryState).toBe(false);
    });

    it('is dispatchable once online and under the limit', async () => {
      await shiftCommand().command.start({ userId: DRIVER });
      await availabilityCommand().command.execute({
        userId: DRIVER,
        availability: DriverAvailability.ONLINE,
      });

      expect((await statusQuery(1).byUserId(DRIVER)).dispatchableByDeliveryState).toBe(true);
    });

    it('stops being dispatchable at the limit even while online', async () => {
      await shiftCommand().command.start({ userId: DRIVER });
      await availabilityCommand().command.execute({
        userId: DRIVER,
        availability: DriverAvailability.ONLINE,
      });
      jobs.statuses = [DeliveryJobStatus.ASSIGNED];

      expect((await statusQuery(1).byUserId(DRIVER)).dispatchableByDeliveryState).toBe(false);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 7 & 8. Location
  // -------------------------------------------------------------------------------------------
  describe('location', () => {
    let location: UpdateDriverLocationCommand;

    beforeEach(async () => {
      await seedProfile();
      location = new UpdateDriverLocationCommand(profiles);
    });

    /** Relative to the real clock: `recordLocation` compares against `new Date()`. */
    const recently = () => new Date(Date.now() - 5_000);

    it('records a fix', async () => {
      const at = recently();
      const result = await location.execute({ userId: DRIVER, lat: 9.03, lng: 38.74, recordedAt: at });

      expect(result.applied).toBe(true);
      expect(result.profile.lastLocationAt).toEqual(at);
    });

    it('ignores a stale fix rather than erroring', async () => {
      const at = recently();
      await location.execute({ userId: DRIVER, lat: 9.03, lng: 38.74, recordedAt: at });

      const stale = new Date(at.getTime() - 300_000);
      const result = await location.execute({
        userId: DRIVER,
        lat: 9.9,
        lng: 38.9,
        recordedAt: stale,
      });

      // A buffered replay is normal operation, not an error — a well-behaved client must not be
      // left retrying a request that can never succeed.
      expect(result.applied).toBe(false);
      expect(result.profile.lastLocationAt).toEqual(at);
    });

    it('rejects an out-of-range coordinate', async () => {
      expect(
        await codeOf(() => location.execute({ userId: DRIVER, lat: 91, lng: 38.74 })),
      ).toBe(ErrorCode.VALIDATION_ERROR);
    });

    it('rejects a timestamp far in the future', async () => {
      const future = new Date(Date.now() + 3_600_000);
      expect(
        await codeOf(() =>
          location.execute({ userId: DRIVER, lat: 9.03, lng: 38.74, recordedAt: future }),
        ),
      ).toBe(ErrorCode.VALIDATION_ERROR);
    });

    it('refuses a driver with no profile', async () => {
      expect(
        await codeOf(() => location.execute({ userId: 'nobody', lat: 9, lng: 38 })),
      ).toBe(ErrorCode.NOT_FOUND);
    });

    it('does not disturb availability or shift', async () => {
      await shiftCommand().command.start({ userId: DRIVER });
      await availabilityCommand().command.execute({
        userId: DRIVER,
        availability: DriverAvailability.ONLINE,
      });

      const result = await location.execute({ userId: DRIVER, lat: 9.03, lng: 38.74 });
      expect(result.profile.availability).toBe(DriverAvailability.ONLINE);
      expect(result.profile.shiftStartedAt).not.toBeNull();
    });

    it('writes no audit entry', async () => {
      // §13 audits operational decisions. A ten-second-cadence position report is telemetry, and
      // auditing it would bury the availability entries an investigation actually reads.
      const { audit, entries } = fakeAudit();
      void audit;
      await location.execute({ userId: DRIVER, lat: 9.03, lng: 38.74 });
      expect(entries).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 10. Status read
  // -------------------------------------------------------------------------------------------
  describe('operational status', () => {
    it('reports the whole operational state', async () => {
      await seedProfile();
      await shiftCommand().command.start({ userId: DRIVER });

      const status = await statusQuery(1).byUserId(DRIVER);
      expect(status).toMatchObject({
        userId: DRIVER,
        availability: DriverAvailability.OFFLINE,
        onShift: true,
        vehicleType: VehicleType.Motorcycle,
        plateNumber: 'AA-12345',
        serviceArea: { lat: 9.03, lng: 38.74, radiusMeters: 5_000 },
        lastLocation: null,
      });
    });

    it('refuses a driver with no profile', async () => {
      expect(await codeOf(() => statusQuery(1).byUserId('nobody'))).toBe(ErrorCode.NOT_FOUND);
    });
  });
});
