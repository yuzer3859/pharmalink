import { randomUUID } from 'crypto';
import { CreateDriverProfileCommand } from '../../src/modules/delivery/application/commands/create-driver-profile.command';
import { ManageDriverShiftCommand } from '../../src/modules/delivery/application/commands/manage-driver-shift.command';
import { SetDriverAvailabilityCommand } from '../../src/modules/delivery/application/commands/set-driver-availability.command';
import { UpdateDriverLocationCommand } from '../../src/modules/delivery/application/commands/update-driver-location.command';
import {
  IDENTITY_PORT,
  IIdentityPort,
} from '../../src/modules/delivery/application/ports/outbound/identity.port';
import { GetDriverOperationalStatusQuery } from '../../src/modules/delivery/application/queries/get-driver-operational-status.query';
import { DriverProfile } from '../../src/modules/delivery/domain/entities/driver-profile.entity';
import { DeliveryJobStatus, DriverAvailability } from '../../src/modules/delivery/domain/enums';
import {
  DRIVER_PROFILE_REPOSITORY,
  IDriverProfileRepository,
} from '../../src/modules/delivery/domain/repositories/driver-profile.repository';
import {
  DELIVERY_JOB_REPOSITORY,
  IDeliveryJobRepository,
} from '../../src/modules/delivery/domain/repositories/delivery-job.repository';
import { VehicleType } from '../../src/modules/delivery/domain/value-objects/vehicle.vo';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { uniquePhone } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

/**
 * The Delivery-owned operational driver profile against real PostgreSQL
 * (§3.1 F-DRV-01..04, §5.1, BRULE-09, BRULE-28).
 *
 * Real `AppModule`, real commands, the real `IdentityPortAdapter` reading Module 01's own `users`
 * and `verification_requests`, the real Prisma repository, real `Serializable` transactions and
 * the real hash-chained audit trail. The Module 01 rows are seeded directly — Module 08 reads them
 * and does not create them, and driving a driver through registration, document submission and
 * admin approval over HTTP would be a test of Module 01.
 *
 * Three claims are under test that the unit suite cannot make:
 *
 *  1. the migration's reshaped table round-trips the aggregate, including the columns it added;
 *  2. the unique index on `userId` — not the application's check — is what guarantees one profile
 *     per driver;
 *  3. BRULE-09 is answered from Module 01's real tables, so the verification boundary is a live
 *     read rather than a mirrored flag.
 */
describe('Driver operational profile (e2e)', () => {
  let ctx: TestContext;
  let create: CreateDriverProfileCommand;
  let availability: SetDriverAvailabilityCommand;
  let shift: ManageDriverShiftCommand;
  let location: UpdateDriverLocationCommand;
  let status: GetDriverOperationalStatusQuery;
  let profiles: IDriverProfileRepository;
  let jobs: IDeliveryJobRepository;
  let identity: IIdentityPort;

  beforeAll(async () => {
    ctx = await createTestApp();
    create = ctx.app.get(CreateDriverProfileCommand);
    availability = ctx.app.get(SetDriverAvailabilityCommand);
    shift = ctx.app.get(ManageDriverShiftCommand);
    location = ctx.app.get(UpdateDriverLocationCommand);
    status = ctx.app.get(GetDriverOperationalStatusQuery);
    profiles = ctx.app.get<IDriverProfileRepository>(DRIVER_PROFILE_REPOSITORY);
    jobs = ctx.app.get<IDeliveryJobRepository>(DELIVERY_JOB_REPOSITORY);
    identity = ctx.app.get<IIdentityPort>(IDENTITY_PORT);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  // -------------------------------------------------------------------------------------------
  // Fixtures — the Module 01 rows Module 08 reads.
  // -------------------------------------------------------------------------------------------

  interface DriverSeed {
    role?: 'DRIVER' | 'CUSTOMER';
    userStatus?: 'ACTIVE' | 'SUSPENDED' | 'PENDING_VERIFICATION';
    /** `'none'` submits no request at all. */
    documents?: 'APPROVED' | 'PENDING' | 'REJECTED' | 'none';
    /** Expiry on the approved DRIVER_DOCS request (BRULE-08). */
    documentsExpireAt?: Date | null;
  }

  async function seedDriver(options: DriverSeed = {}): Promise<string> {
    const user = await ctx.prisma.user.create({
      data: {
        primaryRole: options.role ?? 'DRIVER',
        status: options.userStatus ?? 'ACTIVE',
        phone: uniquePhone(),
      },
    });

    const documents = options.documents ?? 'APPROVED';
    if (documents !== 'none') {
      await ctx.prisma.verificationRequest.create({
        data: {
          userId: user.id,
          type: 'DRIVER_DOCS',
          status: documents,
          reviewedAt: documents === 'PENDING' ? null : new Date(),
          expiresAt: options.documentsExpireAt ?? null,
        },
      });
    }

    return user.id;
  }

  /** A driver with a profile, on shift and online — the fully operational starting point. */
  async function onlineDriver(): Promise<{ userId: string; profileId: string }> {
    const userId = await seedDriver();
    const { profile } = await create.execute({
      userId,
      vehicleType: VehicleType.Motorcycle,
      plateNumber: 'AA-12345',
      serviceArea: { lat: 9.03, lng: 38.74, radiusMeters: 5_000 },
    });
    await shift.start({ userId });
    await availability.execute({ userId, availability: DriverAvailability.ONLINE });
    return { userId, profileId: profile.id };
  }

  async function codeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
    try {
      await fn();
    } catch (err) {
      return (err as { code?: string }).code;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------------------------
  // 1. Creation and persistence
  // -------------------------------------------------------------------------------------------

  it('creates a profile and persists every column the migration added', async () => {
    const userId = await seedDriver();

    const { profile, replay } = await create.execute({
      userId,
      vehicleType: VehicleType.Van,
      plateNumber: '3-A12345 ET',
      serviceArea: { lat: 9.03, lng: 38.74, radiusMeters: 7_500 },
      maxConcurrent: 3,
    });

    expect(replay).toBe(false);

    const row = await ctx.prisma.driverProfile.findUnique({ where: { id: profile.id } });
    expect(row).toMatchObject({
      userId,
      vehicleType: VehicleType.Van,
      plateNumber: '3-A12345 ET',
      availability: DriverAvailability.OFFLINE,
      shiftStartedAt: null,
      lastOnlineAt: null,
      lastLat: null,
      lastLng: null,
      lastLocationAt: null,
      maxConcurrent: 3,
    });
    expect(row?.serviceArea).toEqual({ lat: 9.03, lng: 38.74, radiusMeters: 7_500 });
  });

  it('stores no override when none is given, so the platform limit applies', async () => {
    // The column is nullable now; Phase 0's `NOT NULL DEFAULT 1` pinned every driver at one job
    // and made `delivery.maxConcurrentJobs` unreachable.
    const userId = await seedDriver();
    const { profile } = await create.execute({ userId });

    const row = await ctx.prisma.driverProfile.findUnique({ where: { id: profile.id } });
    expect(row?.maxConcurrent).toBeNull();
  });

  it('round-trips through the repository and rehydrates into the aggregate', async () => {
    const { userId, profileId } = await onlineDriver();
    const at = new Date(Date.now() - 5_000);
    await location.execute({ userId, lat: 9.031, lng: 38.741, recordedAt: at });

    const byId = await profiles.findById(profileId);
    const byUser = await profiles.findByUserId(userId);
    expect(byId).toEqual(byUser);

    // The persisted row is a legal aggregate: every invariant holds after a DB round trip, and
    // the value objects reassemble from the columns they were flattened into.
    const rehydrated = DriverProfile.rehydrate(byId!);
    expect(rehydrated.availability).toBe(DriverAvailability.ONLINE);
    expect(rehydrated.isOnShift).toBe(true);
    expect(rehydrated.toProps().vehicle?.type).toBe(VehicleType.Motorcycle);
    expect(rehydrated.toProps().serviceArea?.radiusMeters).toBe(5_000);
    expect(rehydrated.lastLocation?.lat).toBeCloseTo(9.031, 6);
    expect(rehydrated.lastLocationAt).toEqual(at);

    // And it can still be driven forward.
    expect(rehydrated.endShift().availability).toBe(DriverAvailability.OFFLINE);
  });

  it('writes a hash-chained audit entry for the creation', async () => {
    const userId = await seedDriver();
    const { profile } = await create.execute({ userId });

    const entries = await ctx.prisma.auditLog.findMany({
      where: { resourceType: 'DriverProfile', resourceId: profile.id },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe('DELIVERY_DRIVER_PROFILE_CREATED');
  });

  // -------------------------------------------------------------------------------------------
  // 2. One profile per Module 01 driver — enforced by the index, not the check
  // -------------------------------------------------------------------------------------------

  it('returns the existing profile rather than creating a second', async () => {
    const userId = await seedDriver();
    const first = await create.execute({ userId });
    const second = await create.execute({ userId });

    expect(second.replay).toBe(true);
    expect(second.profile.id).toBe(first.profile.id);
    expect(await ctx.prisma.driverProfile.count({ where: { userId } })).toBe(1);
  });

  it('converges on one profile when three creators race', async () => {
    const userId = await seedDriver();

    const results = await Promise.all([
      create.execute({ userId }),
      create.execute({ userId }),
      create.execute({ userId }),
    ]);

    expect(await ctx.prisma.driverProfile.count({ where: { userId } })).toBe(1);
    expect(new Set(results.map((r) => r.profile.id)).size).toBe(1);
  });

  it('refuses a second profile at the database level, whatever the application does', async () => {
    // The guarantee is the unique index's, not the command's. A direct insert that bypasses
    // every check must still fail.
    const userId = await seedDriver();
    await create.execute({ userId });

    const code = await codeOf(() =>
      ctx.prisma.driverProfile.create({ data: { id: randomUUID(), userId } }),
    );
    expect(code).toBe('P2002');
  });

  // -------------------------------------------------------------------------------------------
  // 3. The Module 01 verification boundary (BRULE-09), read live
  // -------------------------------------------------------------------------------------------

  describe('verification boundary', () => {
    it('reports an approved, active driver as eligible', async () => {
      const userId = await seedDriver();
      await expect(identity.getDriverIdentity(userId)).resolves.toMatchObject({
        isEligible: true,
        reason: null,
      });
    });

    it.each([
      ['an unknown user', { userId: randomUUID() }, 'USER_NOT_FOUND'],
      ['a non-driver account', { role: 'CUSTOMER' as const }, 'NOT_A_DRIVER'],
      ['a suspended account', { userStatus: 'SUSPENDED' as const }, 'ACCOUNT_NOT_ACTIVE'],
      ['no submitted documents', { documents: 'none' as const }, 'DOCUMENTS_NOT_APPROVED'],
      ['pending documents', { documents: 'PENDING' as const }, 'DOCUMENTS_NOT_APPROVED'],
      ['rejected documents', { documents: 'REJECTED' as const }, 'DOCUMENTS_NOT_APPROVED'],
    ])('fails closed for %s', async (_label, seed, reason) => {
      const userId =
        'userId' in seed ? (seed.userId as string) : await seedDriver(seed as DriverSeed);
      await expect(identity.getDriverIdentity(userId)).resolves.toMatchObject({
        isEligible: false,
        reason,
      });
    });

    it('treats a lapsed licence as ineligible (BRULE-08)', async () => {
      const expired = new Date(Date.now() - 86_400_000);
      const userId = await seedDriver({ documentsExpireAt: expired });

      await expect(identity.getDriverIdentity(userId)).resolves.toMatchObject({
        isEligible: false,
        reason: 'DOCUMENTS_EXPIRED',
        documentsExpireAt: expired,
      });
    });

    it('treats a future expiry as eligible and reports the date', async () => {
      const expires = new Date(Date.now() + 30 * 86_400_000);
      const userId = await seedDriver({ documentsExpireAt: expires });

      await expect(identity.getDriverIdentity(userId)).resolves.toMatchObject({
        isEligible: true,
        documentsExpireAt: expires,
      });
    });

    it('refuses ONLINE for a driver whose documents are not approved', async () => {
      const userId = await seedDriver({ documents: 'PENDING' });
      await create.execute({ userId });
      await shift.start({ userId });

      const code = await codeOf(() =>
        availability.execute({ userId, availability: DriverAvailability.ONLINE }),
      );
      expect(code).toBe(ErrorCode.DRIVER_NOT_VERIFIED);
      expect((await profiles.findByUserId(userId))?.availability).toBe(
        DriverAvailability.OFFLINE,
      );
    });

    it('reflects a revocation immediately, with no cached copy to go stale', async () => {
      // The whole reason `is_verified` was dropped. The driver is online; Module 01 revokes the
      // approval; the very next attempt to go online is refused — no synchronisation, no event,
      // no window in which Module 08 believes something Module 01 no longer says.
      const { userId } = await onlineDriver();
      await availability.execute({ userId, availability: DriverAvailability.OFFLINE });

      await ctx.prisma.verificationRequest.updateMany({
        where: { userId, type: 'DRIVER_DOCS' },
        data: { status: 'REJECTED' },
      });

      const code = await codeOf(() =>
        availability.execute({ userId, availability: DriverAvailability.ONLINE }),
      );
      expect(code).toBe(ErrorCode.DRIVER_NOT_VERIFIED);
    });

    it('still lets a driver whose documents lapsed go OFFLINE', async () => {
      const { userId } = await onlineDriver();
      await ctx.prisma.verificationRequest.updateMany({
        where: { userId, type: 'DRIVER_DOCS' },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });

      const result = await availability.execute({
        userId,
        availability: DriverAvailability.OFFLINE,
      });
      expect(result.profile.availability).toBe(DriverAvailability.OFFLINE);
    });

    it('refuses to create a profile for a user who is not a driver', async () => {
      const userId = await seedDriver({ role: 'CUSTOMER' });
      expect(await codeOf(() => create.execute({ userId }))).toBe(
        ErrorCode.DRIVER_NOT_VERIFIED,
      );
      expect(await ctx.prisma.driverProfile.count({ where: { userId } })).toBe(0);
    });

    it('lets a driver awaiting review set up their profile', async () => {
      const userId = await seedDriver({ documents: 'PENDING' });
      const { profile } = await create.execute({ userId, vehicleType: VehicleType.Bicycle });
      expect(profile.availability).toBe(DriverAvailability.OFFLINE);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 4. Availability and shift, persisted
  // -------------------------------------------------------------------------------------------

  describe('availability and shift', () => {
    it('persists a shift, then going online, then offline', async () => {
      const userId = await seedDriver();
      const { profile } = await create.execute({ userId });

      await shift.start({ userId });
      expect(
        (await ctx.prisma.driverProfile.findUnique({ where: { id: profile.id } }))
          ?.shiftStartedAt,
      ).not.toBeNull();

      await availability.execute({ userId, availability: DriverAvailability.ONLINE });
      const online = await ctx.prisma.driverProfile.findUnique({ where: { id: profile.id } });
      expect(online?.availability).toBe(DriverAvailability.ONLINE);
      expect(online?.lastOnlineAt).not.toBeNull();

      await availability.execute({ userId, availability: DriverAvailability.OFFLINE });
      const offline = await ctx.prisma.driverProfile.findUnique({ where: { id: profile.id } });
      expect(offline?.availability).toBe(DriverAvailability.OFFLINE);
      // A break, not the end of the shift.
      expect(offline?.shiftStartedAt).not.toBeNull();
    });

    it('forces OFFLINE when an online driver ends their shift', async () => {
      const { userId, profileId } = await onlineDriver();

      await shift.end({ userId });

      const row = await ctx.prisma.driverProfile.findUnique({ where: { id: profileId } });
      expect(row).toMatchObject({
        availability: DriverAvailability.OFFLINE,
        shiftStartedAt: null,
      });
    });

    it('refuses ONLINE without an open shift and writes nothing', async () => {
      const userId = await seedDriver();
      const { profile } = await create.execute({ userId });

      const code = await codeOf(() =>
        availability.execute({ userId, availability: DriverAvailability.ONLINE }),
      );
      expect(code).toBe(ErrorCode.CONFLICT);

      const row = await ctx.prisma.driverProfile.findUnique({ where: { id: profile.id } });
      expect(row).toMatchObject({
        availability: DriverAvailability.OFFLINE,
        shiftStartedAt: null,
      });
    });

    it('audits every availability and shift change, and nothing else', async () => {
      const { userId, profileId } = await onlineDriver();
      await availability.execute({ userId, availability: DriverAvailability.OFFLINE });
      // Idempotent repeats, which must add nothing.
      await availability.execute({ userId, availability: DriverAvailability.OFFLINE });
      await shift.start({ userId });
      await location.execute({ userId, lat: 9.03, lng: 38.74 });
      await shift.end({ userId });

      const entries = await ctx.prisma.auditLog.findMany({
        where: { resourceType: 'DriverProfile', resourceId: profileId },
        orderBy: { createdAt: 'asc' },
      });

      expect(entries.map((e) => e.action)).toEqual([
        'DELIVERY_DRIVER_PROFILE_CREATED',
        'DELIVERY_DRIVER_SHIFT_STARTED',
        'DELIVERY_DRIVER_AVAILABILITY_CHANGED',
        'DELIVERY_DRIVER_AVAILABILITY_CHANGED',
        'DELIVERY_DRIVER_SHIFT_ENDED',
      ]);
      // The location update is deliberately absent: telemetry, not an operational decision.
    });
  });

  // -------------------------------------------------------------------------------------------
  // 5. Location
  // -------------------------------------------------------------------------------------------

  describe('location', () => {
    it('persists a fix and applies a newer one', async () => {
      const { userId, profileId } = await onlineDriver();
      const first = new Date(Date.now() - 30_000);
      const second = new Date(Date.now() - 5_000);

      await location.execute({ userId, lat: 9.03, lng: 38.74, recordedAt: first });
      const applied = await location.execute({
        userId,
        lat: 9.05,
        lng: 38.76,
        recordedAt: second,
      });

      expect(applied.applied).toBe(true);
      const row = await ctx.prisma.driverProfile.findUnique({ where: { id: profileId } });
      expect(row?.lastLat).toBeCloseTo(9.05, 6);
      expect(row?.lastLng).toBeCloseTo(38.76, 6);
      expect(row?.lastLocationAt).toEqual(second);
    });

    it('ignores a buffered replay without touching the row', async () => {
      const { userId, profileId } = await onlineDriver();
      const fresh = new Date(Date.now() - 5_000);
      await location.execute({ userId, lat: 9.03, lng: 38.74, recordedAt: fresh });

      const stale = new Date(fresh.getTime() - 300_000);
      const result = await location.execute({
        userId,
        lat: 9.9,
        lng: 38.9,
        recordedAt: stale,
      });

      expect(result.applied).toBe(false);
      const row = await ctx.prisma.driverProfile.findUnique({ where: { id: profileId } });
      expect(row?.lastLat).toBeCloseTo(9.03, 6);
      expect(row?.lastLocationAt).toEqual(fresh);
    });

    it('rejects an out-of-range coordinate', async () => {
      const { userId } = await onlineDriver();
      expect(await codeOf(() => location.execute({ userId, lat: 9.03, lng: 200 }))).toBe(
        ErrorCode.VALIDATION_ERROR,
      );
    });

    it('rejects a timestamp far ahead of the server clock', async () => {
      const { userId } = await onlineDriver();
      const future = new Date(Date.now() + 3_600_000);
      expect(
        await codeOf(() =>
          location.execute({ userId, lat: 9.03, lng: 38.74, recordedAt: future }),
        ),
      ).toBe(ErrorCode.VALIDATION_ERROR);
    });

    it('does not disturb availability or shift', async () => {
      const { userId, profileId } = await onlineDriver();
      await location.execute({ userId, lat: 9.03, lng: 38.74 });

      const row = await ctx.prisma.driverProfile.findUnique({ where: { id: profileId } });
      expect(row?.availability).toBe(DriverAvailability.ONLINE);
      expect(row?.shiftStartedAt).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------------------------
  // 6. Concurrent-job limit (BRULE-28), counted from real jobs
  // -------------------------------------------------------------------------------------------

  describe('concurrent-job limit', () => {
    /** A job assigned to this driver in the given state. Only the columns the count reads. */
    async function assignJob(
      driverProfileId: string,
      jobStatus: DeliveryJobStatus,
    ): Promise<void> {
      await ctx.prisma.deliveryJob.create({
        data: {
          orderId: randomUUID(),
          fulfillmentId: randomUUID(),
          pharmacyId: randomUUID(),
          branchId: randomUUID(),
          assignedDriverId: driverProfileId,
          status: jobStatus,
        },
      });
    }

    it('counts nothing for a driver with no jobs', async () => {
      const { profileId } = await onlineDriver();
      expect(await jobs.countActiveJobs(profileId)).toBe(0);
    });

    it('counts only the states in which the driver is holding a job', async () => {
      const { profileId } = await onlineDriver();

      for (const jobStatus of [
        DeliveryJobStatus.ASSIGNED,
        DeliveryJobStatus.ARRIVED_PICKUP,
        DeliveryJobStatus.PICKED_UP,
        DeliveryJobStatus.EN_ROUTE,
        DeliveryJobStatus.ARRIVED_DROPOFF,
      ]) {
        await assignJob(profileId, jobStatus);
      }
      for (const jobStatus of [
        DeliveryJobStatus.CREATED,
        DeliveryJobStatus.OFFERED,
        DeliveryJobStatus.REASSIGNING,
        DeliveryJobStatus.DELIVERED,
        DeliveryJobStatus.COMPLETED,
        DeliveryJobStatus.CANCELLED,
        DeliveryJobStatus.FAILED,
      ]) {
        await assignJob(profileId, jobStatus);
      }

      expect(await jobs.countActiveJobs(profileId)).toBe(5);
    });

    it('does not count another driver’s jobs', async () => {
      const mine = await onlineDriver();
      const theirs = await onlineDriver();
      await assignJob(theirs.profileId, DeliveryJobStatus.PICKED_UP);

      expect(await jobs.countActiveJobs(mine.profileId)).toBe(0);
      expect(await jobs.countActiveJobs(theirs.profileId)).toBe(1);
    });

    it('reports capacity against the platform limit', async () => {
      const { userId, profileId } = await onlineDriver();

      const before = await status.byUserId(userId);
      expect(before.capacity).toMatchObject({
        activeJobCount: 0,
        limit: 1,
        hasCapacity: true,
        limitIsOverride: false,
      });
      expect(before.dispatchableByDeliveryState).toBe(true);

      await assignJob(profileId, DeliveryJobStatus.ASSIGNED);

      const after = await status.byUserId(userId);
      expect(after.capacity).toMatchObject({ activeJobCount: 1, hasCapacity: false });
      expect(after.dispatchableByDeliveryState).toBe(false);
    });

    it('honours a per-driver override', async () => {
      const userId = await seedDriver();
      const { profile } = await create.execute({ userId, maxConcurrent: 3 });
      await shift.start({ userId });
      await availability.execute({ userId, availability: DriverAvailability.ONLINE });

      await ctx.prisma.deliveryJob.createMany({
        data: [DeliveryJobStatus.ASSIGNED, DeliveryJobStatus.EN_ROUTE].map((s) => ({
          orderId: randomUUID(),
          fulfillmentId: randomUUID(),
          pharmacyId: randomUUID(),
          branchId: randomUUID(),
          assignedDriverId: profile.id,
          status: s,
        })),
      });

      const view = await status.byUserId(userId);
      expect(view.capacity).toMatchObject({
        activeJobCount: 2,
        limit: 3,
        hasCapacity: true,
        limitIsOverride: true,
      });
      expect(view.dispatchableByDeliveryState).toBe(true);
    });

    it('reports the whole operational state in one read', async () => {
      const { userId } = await onlineDriver();
      const at = new Date(Date.now() - 5_000);
      await location.execute({ userId, lat: 9.031, lng: 38.741, recordedAt: at });

      const view = await status.byUserId(userId);
      expect(view).toMatchObject({
        userId,
        availability: DriverAvailability.ONLINE,
        onShift: true,
        vehicleType: VehicleType.Motorcycle,
        plateNumber: 'AA-12345',
        serviceArea: { lat: 9.03, lng: 38.74, radiusMeters: 5_000 },
      });
      expect(view.lastLocation?.recordedAt).toEqual(at);
      expect(view.shiftStartedAt).not.toBeNull();
    });

    it('refuses a status read for a driver with no profile', async () => {
      expect(await codeOf(() => status.byUserId(randomUUID()))).toBe(ErrorCode.NOT_FOUND);
    });
  });
});
