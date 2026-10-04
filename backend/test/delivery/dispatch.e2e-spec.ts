import { randomUUID } from 'crypto';
import { AcceptJobOfferCommand } from '../../src/modules/delivery/application/commands/accept-job-offer.command';
import { DeclineJobOfferCommand } from '../../src/modules/delivery/application/commands/decline-job-offer.command';
import {
  DispatchDeliveryJobCommand,
  DispatchOutcome,
} from '../../src/modules/delivery/application/commands/dispatch-delivery-job.command';
import { ReassignDeliveryJobCommand } from '../../src/modules/delivery/application/commands/reassign-delivery-job.command';
import { CreateDriverProfileCommand } from '../../src/modules/delivery/application/commands/create-driver-profile.command';
import { ManageDriverShiftCommand } from '../../src/modules/delivery/application/commands/manage-driver-shift.command';
import { SetDriverAvailabilityCommand } from '../../src/modules/delivery/application/commands/set-driver-availability.command';
import { UpdateDriverLocationCommand } from '../../src/modules/delivery/application/commands/update-driver-location.command';
import { JobOffer } from '../../src/modules/delivery/domain/entities/job-offer.entity';
import {
  DeliveryJobStatus,
  DriverAvailability,
  JobOfferStatus,
} from '../../src/modules/delivery/domain/enums';
import { DeliveryEventType } from '../../src/modules/delivery/domain/events';
import {
  IJobOfferRepository,
  JOB_OFFER_REPOSITORY,
} from '../../src/modules/delivery/domain/repositories/job-offer.repository';
import { VehicleType } from '../../src/modules/delivery/domain/value-objects/vehicle.vo';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { uniquePhone } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

/**
 * Dispatch, offers, accept/decline and reassignment against real PostgreSQL
 * (§3.2 F-JOB-03..05, §6, §11.2, §11.5, BRULE-19, BRULE-28).
 *
 * Real `AppModule`, real commands, the real `IdentityPortAdapter` reading Module 01's own tables,
 * the real Prisma repositories, real `Serializable` transactions, the real outbox and the real
 * hash-chained audit trail.
 *
 * The claims that can only be made here, against a real database:
 *
 *  1. **One live offer per job**, guaranteed by the partial unique index rather than by the
 *     application's own check — so two dispatchers racing cannot both offer the same job.
 *  2. **One winner per accept**, guaranteed by the two compare-and-sets inside one Serializable
 *     transaction — so two accepts cannot both assign.
 *  3. **The concurrent-job limit holds at acceptance**, counted from the jobs themselves.
 *  4. **Verification is read live**, so a revocation between offer and accept is refused.
 */
describe('Delivery dispatch (e2e)', () => {
  let ctx: TestContext;
  let dispatch: DispatchDeliveryJobCommand;
  let accept: AcceptJobOfferCommand;
  let decline: DeclineJobOfferCommand;
  let reassign: ReassignDeliveryJobCommand;
  let createProfile: CreateDriverProfileCommand;
  let shift: ManageDriverShiftCommand;
  let availability: SetDriverAvailabilityCommand;
  let location: UpdateDriverLocationCommand;
  let offers: IJobOfferRepository;

  /** The pharmacy pickup every job in this suite collects from. */
  const PICKUP = { lat: 9.03, lng: 38.74 };

  beforeAll(async () => {
    ctx = await createTestApp();
    dispatch = ctx.app.get(DispatchDeliveryJobCommand);
    accept = ctx.app.get(AcceptJobOfferCommand);
    decline = ctx.app.get(DeclineJobOfferCommand);
    reassign = ctx.app.get(ReassignDeliveryJobCommand);
    createProfile = ctx.app.get(CreateDriverProfileCommand);
    shift = ctx.app.get(ManageDriverShiftCommand);
    availability = ctx.app.get(SetDriverAvailabilityCommand);
    location = ctx.app.get(UpdateDriverLocationCommand);
    offers = ctx.app.get<IJobOfferRepository>(JOB_OFFER_REPOSITORY);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  // -------------------------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------------------------

  /** A delivery job sitting at CREATED, ready to be dispatched. */
  async function seedJob(
    overrides: { pickup?: { lat: number; lng: number } | null } = {},
  ): Promise<{ jobId: string; orderId: string }> {
    const pickup = overrides.pickup === undefined ? PICKUP : overrides.pickup;
    const order = await ctx.prisma.order.create({
      data: {
        orderNumber: `ORD-${randomUUID()}`,
        customerUserId: randomUUID(),
        status: 'PAID',
        subtotal: 20_000,
        grandTotal: 20_000,
        currency: 'ETB',
        idempotencyKey: `checkout-${randomUUID()}`,
      },
    });
    const job = await ctx.prisma.deliveryJob.create({
      data: {
        orderId: order.id,
        fulfillmentId: randomUUID(),
        pharmacyId: randomUUID(),
        branchId: randomUUID(),
        pickupLat: pickup?.lat ?? null,
        pickupLng: pickup?.lng ?? null,
        status: DeliveryJobStatus.CREATED,
      },
    });
    return { jobId: job.id, orderId: order.id };
  }

  interface DriverSeed {
    /**
     * Applied **after** the driver is brought online.
     *
     * A driver cannot be seeded unverified-and-online through the normal path at all: the
     * driver-profile work's `SetDriverAvailabilityCommand` refuses to put an unverified driver
     * online in the first place. So the only reachable way for dispatch to meet an ineligible
     * driver is a revocation *after* they came online — which is exactly the state this models,
     * and exactly why dispatch re-checks rather than trusting that they got online somehow.
     */
    documents?: 'APPROVED' | 'PENDING' | 'REJECTED';
    /** Where the driver currently is. Defaults to the pickup. */
    at?: { lat: number; lng: number } | null;
    serviceArea?: { lat: number; lng: number; radiusMeters: number } | null;
    maxConcurrent?: number;
    /** Leave them OFFLINE / off shift. */
    online?: boolean;
  }

  interface Driver {
    userId: string;
    profileId: string;
  }

  async function seedDriver(options: DriverSeed = {}): Promise<Driver> {
    const user = await ctx.prisma.user.create({
      data: { primaryRole: 'DRIVER', status: 'ACTIVE', phone: uniquePhone() },
    });
    await ctx.prisma.verificationRequest.create({
      data: {
        userId: user.id,
        type: 'DRIVER_DOCS',
        status: 'APPROVED',
        reviewedAt: new Date(),
      },
    });

    const { profile } = await createProfile.execute({
      userId: user.id,
      vehicleType: VehicleType.Motorcycle,
      plateNumber: `AA-${Math.floor(Math.random() * 99_999)}`,
      serviceArea: options.serviceArea ?? null,
      maxConcurrent: options.maxConcurrent ?? null,
    });

    if (options.online !== false) {
      await shift.start({ userId: user.id });
      await availability.execute({
        userId: user.id,
        availability: DriverAvailability.ONLINE,
      });
    }

    const at = options.at === undefined ? PICKUP : options.at;
    if (at) {
      await location.execute({ userId: user.id, lat: at.lat, lng: at.lng });
    }

    // Revoked last — see `DriverSeed.documents`.
    if (options.documents && options.documents !== 'APPROVED') {
      await ctx.prisma.verificationRequest.updateMany({
        where: { userId: user.id, type: 'DRIVER_DOCS' },
        data: { status: options.documents },
      });
    }

    return { userId: user.id, profileId: profile.id };
  }

  /**
   * Forces an offer past its deadline without waiting the real 30 seconds.
   *
   * Both timestamps move back, not just `expiresAt`: a genuinely expired offer was *made* before
   * its deadline, and writing a row whose deadline precedes its own creation would be testing
   * against a state the aggregate rightly refuses to load.
   */
  async function expireOffer(offerId: string): Promise<void> {
    const past = Date.now() - 60_000;
    await ctx.prisma.jobOffer.update({
      where: { id: offerId },
      data: { offeredAt: new Date(past), expiresAt: new Date(past + 30_000) },
    });
  }

  async function codeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
    try {
      await fn();
    } catch (err) {
      return (err as { code?: string }).code;
    }
    return undefined;
  }

  async function jobStatus(jobId: string): Promise<DeliveryJobStatus> {
    const row = await ctx.prisma.deliveryJob.findUniqueOrThrow({ where: { id: jobId } });
    return row.status;
  }

  // -------------------------------------------------------------------------------------------
  // 1. Eligible-driver selection
  // -------------------------------------------------------------------------------------------

  describe('candidate selection', () => {
    it('offers the job to an eligible driver and moves it to OFFERED', async () => {
      const { jobId } = await seedJob();
      const driver = await seedDriver();

      const result = await dispatch.execute({ jobId });

      expect(result.outcome).toBe(DispatchOutcome.Offered);
      expect(result.offer).toMatchObject({
        jobId,
        driverId: driver.profileId,
        status: JobOfferStatus.OFFERED,
        round: 1,
      });
      expect(result.offer!.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(await jobStatus(jobId)).toBe(DeliveryJobStatus.OFFERED);
    });

    it('excludes an online driver who is no longer verified (BRULE-09)', async () => {
      // Module 08 holds no copy of the verification answer, so this is caught the instant Module
      // 01 changes — there is no flag to go stale and no synchronisation to miss.
      const { jobId } = await seedJob();
      await seedDriver({ documents: 'PENDING' });

      expect((await dispatch.execute({ jobId })).outcome).toBe(DispatchOutcome.NoCandidate);
    });

    it('excludes a driver whose verification is revoked between passes', async () => {
      const { jobId } = await seedJob();
      const driver = await seedDriver();
      await ctx.prisma.verificationRequest.updateMany({
        where: { userId: driver.userId },
        data: { status: 'REJECTED' },
      });

      expect((await dispatch.execute({ jobId })).outcome).toBe(DispatchOutcome.NoCandidate);
    });

    it('excludes an offline driver', async () => {
      const { jobId } = await seedJob();
      await seedDriver({ online: false });

      expect((await dispatch.execute({ jobId })).outcome).toBe(DispatchOutcome.NoCandidate);
    });

    it('excludes a driver whose service area does not cover the pickup', async () => {
      const { jobId } = await seedJob();
      // Bahir Dar, ~480km from the Addis pickup.
      await seedDriver({ serviceArea: { lat: 11.6, lng: 37.39, radiusMeters: 5_000 } });

      expect((await dispatch.execute({ jobId })).outcome).toBe(DispatchOutcome.NoCandidate);
    });

    it('includes a driver whose service area does cover the pickup', async () => {
      const { jobId } = await seedJob();
      const driver = await seedDriver({
        serviceArea: { lat: PICKUP.lat, lng: PICKUP.lng, radiusMeters: 10_000 },
      });

      expect((await dispatch.execute({ jobId })).offer?.driverId).toBe(driver.profileId);
    });

    it('excludes a driver already at the concurrent-job limit (BRULE-28)', async () => {
      const { jobId } = await seedJob();
      const driver = await seedDriver();
      // The platform default is 1, so one active job fills them.
      const other = await seedJob();
      await ctx.prisma.deliveryJob.update({
        where: { id: other.jobId },
        data: { status: DeliveryJobStatus.ASSIGNED, assignedDriverId: driver.profileId },
      });

      expect((await dispatch.execute({ jobId })).outcome).toBe(DispatchOutcome.NoCandidate);
    });

    it('includes a driver whose raised limit leaves room', async () => {
      const { jobId } = await seedJob();
      const driver = await seedDriver({ maxConcurrent: 3 });
      const other = await seedJob();
      await ctx.prisma.deliveryJob.update({
        where: { id: other.jobId },
        data: { status: DeliveryJobStatus.ASSIGNED, assignedDriverId: driver.profileId },
      });

      expect((await dispatch.execute({ jobId })).offer?.driverId).toBe(driver.profileId);
    });

    it('prefers the nearer of two eligible drivers', async () => {
      const { jobId } = await seedJob();
      await seedDriver({ at: { lat: 9.2, lng: 38.95 } });
      const near = await seedDriver({ at: PICKUP });

      expect((await dispatch.execute({ jobId })).offer?.driverId).toBe(near.profileId);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 2. No eligible driver
  // -------------------------------------------------------------------------------------------

  describe('no eligible driver', () => {
    it('leaves the job dispatchable rather than failing it', async () => {
      const { jobId } = await seedJob();

      const result = await dispatch.execute({ jobId });

      expect(result.outcome).toBe(DispatchOutcome.NoCandidate);
      expect(result.offer).toBeNull();
      // Still CREATED — not FAILED, not CANCELLED. A human or a later pass can still place it.
      expect(await jobStatus(jobId)).toBe(DeliveryJobStatus.CREATED);
      expect(await ctx.prisma.jobOffer.count({ where: { jobId } })).toBe(0);
    });

    it('records the exhaustion so an operator can find the job', async () => {
      const { jobId } = await seedJob();
      await dispatch.execute({ jobId });

      const entries = await ctx.prisma.auditLog.findMany({
        where: { resourceType: 'DeliveryJob', resourceId: jobId },
      });
      expect(entries.map((e) => e.action)).toContain('DELIVERY_JOB_NO_DRIVER_AVAILABLE');
    });

    it('places the job as soon as a driver comes online', async () => {
      const { jobId } = await seedJob();
      expect((await dispatch.execute({ jobId })).outcome).toBe(DispatchOutcome.NoCandidate);

      await seedDriver();

      expect((await dispatch.execute({ jobId })).outcome).toBe(DispatchOutcome.Offered);
      expect(await jobStatus(jobId)).toBe(DeliveryJobStatus.OFFERED);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 3. One live offer per job — the database's guarantee
  // -------------------------------------------------------------------------------------------

  describe('one live offer per job', () => {
    it('does not re-offer a job whose offer is still live', async () => {
      const { jobId } = await seedJob();
      await seedDriver();
      await seedDriver();

      const first = await dispatch.execute({ jobId });
      const second = await dispatch.execute({ jobId });

      expect(second.outcome).toBe(DispatchOutcome.AlreadyOffered);
      expect(second.offer?.id).toBe(first.offer?.id);
      expect(await ctx.prisma.jobOffer.count({ where: { jobId } })).toBe(1);
    });

    it('converges on one offer when several dispatchers race', async () => {
      const { jobId } = await seedJob();
      await seedDriver();
      await seedDriver();
      await seedDriver();

      const results = await Promise.all([
        dispatch.execute({ jobId }),
        dispatch.execute({ jobId }),
        dispatch.execute({ jobId }),
      ]);

      const live = await ctx.prisma.jobOffer.count({
        where: { jobId, status: JobOfferStatus.OFFERED },
      });
      expect(live).toBe(1);
      expect(new Set(results.map((r) => r.offer?.id)).size).toBe(1);
    });

    it('refuses a second live offer at the database level, whatever the application does', async () => {
      // The guarantee is the partial unique index's, not the command's. A direct insert that
      // bypasses every check must still fail.
      const { jobId } = await seedJob();
      const driverA = await seedDriver();
      const driverB = await seedDriver();
      await dispatch.execute({ jobId });

      const code = await codeOf(() =>
        ctx.prisma.jobOffer.create({
          data: {
            jobId,
            driverId: driverB.profileId,
            status: JobOfferStatus.OFFERED,
            expiresAt: new Date(Date.now() + 60_000),
            round: 99,
          },
        }),
      );
      expect(code).toBe('P2002');
      expect(driverA.profileId).not.toBe(driverB.profileId);
    });

    it('allows an answered offer to coexist with a new live one', async () => {
      // Which is what makes reassignment possible: the previous driver's ACCEPTED row survives.
      const { jobId } = await seedJob();
      // Both drivers sit at the pickup, so they tie on score and the ranking breaks the tie on
      // driver id — which is a random UUID. The offer's owner is therefore resolved from the
      // offer rather than assumed, or this test would pass or fail on the toss of a uuid.
      const drivers = [await seedDriver(), await seedDriver()];

      const offered = await dispatch.execute({ jobId });
      const owner = drivers.find((d) => d.profileId === offered.offer!.driverId)!;
      await decline.execute({ userId: owner.userId, jobId });

      const rows = await ctx.prisma.jobOffer.findMany({ where: { jobId } });
      expect(rows).toHaveLength(2);
      expect(rows.filter((r) => r.status === JobOfferStatus.OFFERED)).toHaveLength(1);
      expect(rows.find((r) => r.id === offered.offer!.id)?.status).toBe(
        JobOfferStatus.DECLINED,
      );
    });
  });

  // -------------------------------------------------------------------------------------------
  // 4. Accept
  // -------------------------------------------------------------------------------------------

  describe('accept', () => {
    it('assigns the job to the driver who was offered it', async () => {
      const { jobId } = await seedJob();
      const driver = await seedDriver();
      const offered = await dispatch.execute({ jobId });

      const result = await accept.execute({ userId: driver.userId, jobId });

      expect(result.job).toMatchObject({
        status: DeliveryJobStatus.ASSIGNED,
        assignedDriverId: driver.profileId,
      });
      expect(result.offer).toMatchObject({
        id: offered.offer!.id,
        status: JobOfferStatus.ACCEPTED,
      });
      expect(result.offer.respondedAt).not.toBeNull();
    });

    it('records the transition in the status history with the driver’s position', async () => {
      const { jobId } = await seedJob();
      const driver = await seedDriver();
      await dispatch.execute({ jobId });
      await accept.execute({ userId: driver.userId, jobId });

      const history = await ctx.prisma.deliveryStatusHistory.findMany({
        where: { jobId },
        orderBy: { createdAt: 'asc' },
      });
      expect(history.map((h) => `${h.fromStatus}->${h.toStatus}`)).toEqual([
        'CREATED->OFFERED',
        'OFFERED->ASSIGNED',
      ]);
      const assigned = history[1];
      expect(assigned.actorType).toBe('DRIVER');
      expect(assigned.actorId).toBe(driver.profileId);
      expect(assigned.lat).toBeCloseTo(PICKUP.lat, 6);
    });

    it('emits JobAssigned through the real outbox', async () => {
      const { jobId, orderId } = await seedJob();
      const driver = await seedDriver();
      await dispatch.execute({ jobId });
      await accept.execute({ userId: driver.userId, jobId });

      const events = await ctx.prisma.outbox.findMany({
        where: { aggregateId: jobId },
        orderBy: { createdAt: 'asc' },
      });
      const types = events.map((e) => e.eventType);
      expect(types).toContain(DeliveryEventType.JobOffered);
      expect(types).toContain(DeliveryEventType.JobAssigned);

      const assigned = events.find((e) => e.eventType === DeliveryEventType.JobAssigned);
      expect((assigned!.payload as { payload: Record<string, unknown> }).payload).toMatchObject({
        jobId,
        orderId,
        driverId: driver.profileId,
      });
    });

    it('refuses a driver who was not offered the job', async () => {
      const { jobId } = await seedJob();
      await seedDriver();
      const outsider = await seedDriver({ at: { lat: 9.5, lng: 39.0 } });
      await dispatch.execute({ jobId });

      // NOT_FOUND, not FORBIDDEN — job ids must not be probeable for who is being dispatched what.
      expect(await codeOf(() => accept.execute({ userId: outsider.userId, jobId }))).toBe(
        ErrorCode.NOT_FOUND,
      );
      expect(await jobStatus(jobId)).toBe(DeliveryJobStatus.OFFERED);
    });

    it('refuses an expired offer even while its row still says OFFERED', async () => {
      // The stored deadline is authoritative; no sweeper has to have run.
      const { jobId } = await seedJob();
      const driver = await seedDriver();
      const offered = await dispatch.execute({ jobId });
      await expireOffer(offered.offer!.id);

      expect(await codeOf(() => accept.execute({ userId: driver.userId, jobId }))).toBe(
        ErrorCode.OFFER_EXPIRED,
      );
      expect(await jobStatus(jobId)).toBe(DeliveryJobStatus.OFFERED);
      expect(
        (await ctx.prisma.deliveryJob.findUniqueOrThrow({ where: { id: jobId } }))
          .assignedDriverId,
      ).toBeNull();
    });

    it('refuses an already accepted offer', async () => {
      const { jobId } = await seedJob();
      const driver = await seedDriver({ maxConcurrent: 5 });
      await dispatch.execute({ jobId });
      await accept.execute({ userId: driver.userId, jobId });

      expect(await codeOf(() => accept.execute({ userId: driver.userId, jobId }))).toBe(
        ErrorCode.NOT_FOUND,
      );
    });

    it('refuses a driver who went offline during the TTL', async () => {
      const { jobId } = await seedJob();
      const driver = await seedDriver();
      await dispatch.execute({ jobId });
      await availability.execute({
        userId: driver.userId,
        availability: DriverAvailability.OFFLINE,
      });

      expect(await codeOf(() => accept.execute({ userId: driver.userId, jobId }))).toBe(
        ErrorCode.CONFLICT,
      );
      expect(await jobStatus(jobId)).toBe(DeliveryJobStatus.OFFERED);
    });

    it('refuses a driver whose verification was revoked during the TTL', async () => {
      const { jobId } = await seedJob();
      const driver = await seedDriver();
      await dispatch.execute({ jobId });
      await ctx.prisma.verificationRequest.updateMany({
        where: { userId: driver.userId },
        data: { status: 'REJECTED' },
      });

      expect(await codeOf(() => accept.execute({ userId: driver.userId, jobId }))).toBe(
        ErrorCode.DRIVER_NOT_VERIFIED,
      );
      expect(await jobStatus(jobId)).toBe(DeliveryJobStatus.OFFERED);
    });

    it('enforces the concurrent-job limit at accept time, not at offer time', async () => {
      // The gap between an offer and its acceptance is exactly long enough for the driver to
      // have taken something else. An offer-time-only check would let them exceed by one.
      const { jobId } = await seedJob();
      const driver = await seedDriver();
      await dispatch.execute({ jobId });

      const other = await seedJob();
      await ctx.prisma.deliveryJob.update({
        where: { id: other.jobId },
        data: { status: DeliveryJobStatus.ASSIGNED, assignedDriverId: driver.profileId },
      });

      expect(await codeOf(() => accept.execute({ userId: driver.userId, jobId }))).toBe(
        ErrorCode.CONCURRENT_LIMIT_REACHED,
      );
      expect(await jobStatus(jobId)).toBe(DeliveryJobStatus.OFFERED);
      // And the offer is untouched, so the driver could still finish their other job and take it.
      const offer = await offers.findPendingForJob(jobId);
      expect(offer).not.toBeNull();
    });

    it('resolves concurrent accepts of the same offer to exactly one winner', async () => {
      const { jobId } = await seedJob();
      const driver = await seedDriver({ maxConcurrent: 5 });
      await dispatch.execute({ jobId });

      const results = await Promise.allSettled([
        accept.execute({ userId: driver.userId, jobId }),
        accept.execute({ userId: driver.userId, jobId }),
        accept.execute({ userId: driver.userId, jobId }),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await jobStatus(jobId)).toBe(DeliveryJobStatus.ASSIGNED);
      expect(
        await ctx.prisma.jobOffer.count({ where: { jobId, status: JobOfferStatus.ACCEPTED } }),
      ).toBe(1);
    });

    it('resolves two drivers racing the same job to exactly one assignment', async () => {
      // Reachable via a reassignment window: driver A holds an accepted offer, the job is
      // reassigned to B, and both try to take it.
      const { jobId } = await seedJob();
      const a = await seedDriver({ maxConcurrent: 5 });
      const b = await seedDriver({ maxConcurrent: 5, at: { lat: 9.04, lng: 38.75 } });

      await dispatch.execute({ jobId });
      const firstOffer = await offers.findPendingForJob(jobId);
      const firstUser = firstOffer!.driverId === a.profileId ? a : b;
      const secondUser = firstOffer!.driverId === a.profileId ? b : a;

      const results = await Promise.allSettled([
        accept.execute({ userId: firstUser.userId, jobId }),
        accept.execute({ userId: secondUser.userId, jobId }),
      ]);

      // The second driver has no offer at all, so they are refused regardless of timing.
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const job = await ctx.prisma.deliveryJob.findUniqueOrThrow({ where: { id: jobId } });
      expect(job.status).toBe(DeliveryJobStatus.ASSIGNED);
      expect(job.assignedDriverId).toBe(firstOffer!.driverId);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 5. Decline
  // -------------------------------------------------------------------------------------------

  describe('decline', () => {
    it('records the refusal with its reason and offers the next candidate', async () => {
      const { jobId } = await seedJob();
      const first = await seedDriver({ at: PICKUP });
      const second = await seedDriver({ at: { lat: 9.06, lng: 38.78 } });

      const offered = await dispatch.execute({ jobId });
      expect(offered.offer!.driverId).toBe(first.profileId);

      const result = await decline.execute({
        userId: first.userId,
        jobId,
        reason: 'Finishing another run',
      });

      expect(result.offer).toMatchObject({
        status: JobOfferStatus.DECLINED,
        reason: 'Finishing another run',
      });
      expect(result.redispatch).toBe(DispatchOutcome.Offered);

      const live = await offers.findPendingForJob(jobId);
      expect(live?.driverId).toBe(second.profileId);
      expect(live?.round).toBe(2);
    });

    it('leaves the job OFFERED throughout — a decline is a round, not a transition', async () => {
      const { jobId } = await seedJob();
      const first = await seedDriver();
      await seedDriver({ at: { lat: 9.06, lng: 38.78 } });
      await dispatch.execute({ jobId });

      await decline.execute({ userId: first.userId, jobId });

      expect(await jobStatus(jobId)).toBe(DeliveryJobStatus.OFFERED);
      // One transition only: CREATED -> OFFERED. No sawtooth in the history.
      const history = await ctx.prisma.deliveryStatusHistory.findMany({ where: { jobId } });
      expect(history).toHaveLength(1);
    });

    it('does not offer the job back to the driver who declined it', async () => {
      const { jobId } = await seedJob();
      const only = await seedDriver();
      await dispatch.execute({ jobId });

      const result = await decline.execute({ userId: only.userId, jobId });

      // The only driver declined, so the job has nobody left — but it is not stuck or failed.
      expect(result.redispatch).toBe(DispatchOutcome.NoCandidate);
      expect(await ctx.prisma.jobOffer.count({ where: { jobId } })).toBe(1);
      expect(await jobStatus(jobId)).toBe(DeliveryJobStatus.OFFERED);
    });

    it('walks down the candidate list across several declines', async () => {
      const { jobId } = await seedJob();
      const drivers = [
        await seedDriver({ at: PICKUP }),
        await seedDriver({ at: { lat: 9.05, lng: 38.76 } }),
        await seedDriver({ at: { lat: 9.08, lng: 38.79 } }),
      ];

      await dispatch.execute({ jobId });
      const offeredTo: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const live = await offers.findPendingForJob(jobId);
        expect(live).not.toBeNull();
        offeredTo.push(live!.driverId);
        const owner = drivers.find((d) => d.profileId === live!.driverId)!;
        await decline.execute({ userId: owner.userId, jobId });
      }

      // Each driver saw it exactly once, nearest first.
      expect(new Set(offeredTo).size).toBe(3);
      expect(offeredTo[0]).toBe(drivers[0].profileId);
      expect(await offers.findPendingForJob(jobId)).toBeNull();
    });

    it('refuses a driver who was not offered the job', async () => {
      const { jobId } = await seedJob();
      await seedDriver();
      const outsider = await seedDriver({ at: { lat: 9.5, lng: 39.0 } });
      await dispatch.execute({ jobId });

      expect(await codeOf(() => decline.execute({ userId: outsider.userId, jobId }))).toBe(
        ErrorCode.NOT_FOUND,
      );
    });

    it('refuses to decline an expired offer', async () => {
      const { jobId } = await seedJob();
      const driver = await seedDriver();
      const offered = await dispatch.execute({ jobId });
      await expireOffer(offered.offer!.id);

      expect(await codeOf(() => decline.execute({ userId: driver.userId, jobId }))).toBe(
        ErrorCode.OFFER_EXPIRED,
      );
    });
  });

  // -------------------------------------------------------------------------------------------
  // 6. Expiry → next candidate
  // -------------------------------------------------------------------------------------------

  describe('expiry', () => {
    it('retires an expired offer and offers the next candidate', async () => {
      const { jobId } = await seedJob();
      const first = await seedDriver({ at: PICKUP });
      const second = await seedDriver({ at: { lat: 9.06, lng: 38.78 } });

      const offered = await dispatch.execute({ jobId });
      expect(offered.offer!.driverId).toBe(first.profileId);
      await expireOffer(offered.offer!.id);

      const next = await dispatch.execute({ jobId });

      expect(next.outcome).toBe(DispatchOutcome.Offered);
      expect(next.offer?.driverId).toBe(second.profileId);
      expect(next.offer?.round).toBe(2);

      const retired = await ctx.prisma.jobOffer.findUniqueOrThrow({
        where: { id: offered.offer!.id },
      });
      expect(retired.status).toBe(JobOfferStatus.EXPIRED);
      expect(retired.reason).toBe('TTL_EXPIRED');
      // The driver never responded, so there is no response time to record.
      expect(retired.respondedAt).toBeNull();
    });

    it('re-checks eligibility rather than trusting the previous pass', async () => {
      // The stale-candidate case, and the reason a shortlist is never stored: between the first
      // offer and the second, the next-best driver went offline.
      const { jobId } = await seedJob();
      const first = await seedDriver({ at: PICKUP });
      const second = await seedDriver({ at: { lat: 9.06, lng: 38.78 } });
      const third = await seedDriver({ at: { lat: 9.09, lng: 38.81 } });

      const offered = await dispatch.execute({ jobId });
      expect(offered.offer!.driverId).toBe(first.profileId);

      await expireOffer(offered.offer!.id);
      await availability.execute({
        userId: second.userId,
        availability: DriverAvailability.OFFLINE,
      });

      const next = await dispatch.execute({ jobId });
      expect(next.offer?.driverId).toBe(third.profileId);
    });

    it('is surfaced by the repository’s expiry query', async () => {
      const { jobId } = await seedJob();
      await seedDriver();
      const offered = await dispatch.execute({ jobId });
      await expireOffer(offered.offer!.id);

      const expired = await offers.listExpired(new Date(), 10);
      expect(expired.map((o) => o.id)).toEqual([offered.offer!.id]);
      // Still pending in the row — the deadline, not the status, is what makes it unacceptable.
      expect(expired[0].status).toBe(JobOfferStatus.OFFERED);
      expect(JobOffer.rehydrate(expired[0]).isExpiredAt(new Date())).toBe(true);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 7. Reassignment (BRULE-19)
  // -------------------------------------------------------------------------------------------

  describe('reassignment', () => {
    async function assignedJob(): Promise<{
      jobId: string;
      first: Driver;
      second: Driver;
    }> {
      const { jobId } = await seedJob();
      const first = await seedDriver({ at: PICKUP });
      const second = await seedDriver({ at: { lat: 9.06, lng: 38.78 } });
      await dispatch.execute({ jobId });
      await accept.execute({ userId: first.userId, jobId });
      return { jobId, first, second };
    }

    it('releases the driver and offers the job to another', async () => {
      const { jobId, first, second } = await assignedJob();

      const result = await reassign.execute({ jobId, reason: 'Driver went offline' });

      expect(result.previousDriverId).toBe(first.profileId);
      expect(result.redispatch).toBe(DispatchOutcome.Offered);
      expect(await jobStatus(jobId)).toBe(DeliveryJobStatus.OFFERED);

      const live = await offers.findPendingForJob(jobId);
      expect(live?.driverId).toBe(second.profileId);
    });

    it('frees the previous driver’s concurrent-job slot', async () => {
      const { jobId, first } = await assignedJob();
      // At the default limit of 1, the first driver is full while assigned.
      expect(
        await ctx.prisma.deliveryJob.count({
          where: { assignedDriverId: first.profileId, status: DeliveryJobStatus.ASSIGNED },
        }),
      ).toBe(1);

      await reassign.execute({ jobId, reason: 'Driver went offline' });

      // Released by the counting rules alone — REASSIGNING is not an active status, and nothing
      // decrements a counter.
      expect(
        await ctx.prisma.deliveryJob.count({
          where: { assignedDriverId: first.profileId },
        }),
      ).toBe(0);
    });

    it('preserves the previous driver’s accepted offer and the transition trail', async () => {
      const { jobId, first } = await assignedJob();
      await reassign.execute({ jobId, reason: 'Driver went offline' });

      const rows = await ctx.prisma.jobOffer.findMany({
        where: { jobId },
        orderBy: { round: 'asc' },
      });
      expect(rows[0]).toMatchObject({
        driverId: first.profileId,
        status: JobOfferStatus.ACCEPTED,
      });

      const history = await ctx.prisma.deliveryStatusHistory.findMany({
        where: { jobId },
        orderBy: { createdAt: 'asc' },
      });
      expect(history.map((h) => `${h.fromStatus}->${h.toStatus}`)).toEqual([
        'CREATED->OFFERED',
        'OFFERED->ASSIGNED',
        'ASSIGNED->REASSIGNING',
        'REASSIGNING->OFFERED',
      ]);
      expect(history[2].reason).toContain(first.profileId);
    });

    it('never offers the job back to the driver it was taken from', async () => {
      const { jobId, first } = await assignedJob();
      await reassign.execute({ jobId, reason: 'Driver went offline' });

      const live = await offers.findPendingForJob(jobId);
      expect(live?.driverId).not.toBe(first.profileId);
    });

    it('reassigns from ARRIVED_PICKUP', async () => {
      const { jobId, second } = await assignedJob();
      await ctx.prisma.deliveryJob.update({
        where: { id: jobId },
        data: { status: DeliveryJobStatus.ARRIVED_PICKUP },
      });

      const result = await reassign.execute({ jobId, reason: 'Driver unreachable' });

      expect(result.redispatch).toBe(DispatchOutcome.Offered);
      expect((await offers.findPendingForJob(jobId))?.driverId).toBe(second.profileId);
    });

    it('refuses reassignment after pickup', async () => {
      // The medicines are in a bag on a motorbike. A second driver cannot take over without a
      // physical handover the design does not define.
      const { jobId, first } = await assignedJob();
      await ctx.prisma.deliveryJob.update({
        where: { id: jobId },
        data: { status: DeliveryJobStatus.PICKED_UP, pickedUpAt: new Date() },
      });

      expect(await codeOf(() => reassign.execute({ jobId, reason: 'Too late' }))).toBe(
        ErrorCode.INVALID_DELIVERY_STATE_TRANSITION,
      );
      const job = await ctx.prisma.deliveryJob.findUniqueOrThrow({ where: { id: jobId } });
      expect(job.status).toBe(DeliveryJobStatus.PICKED_UP);
      expect(job.assignedDriverId).toBe(first.profileId);
    });

    it('refuses reassignment of a delivered job', async () => {
      const { jobId } = await assignedJob();
      await ctx.prisma.deliveryJob.update({
        where: { id: jobId },
        data: {
          status: DeliveryJobStatus.DELIVERED,
          pickedUpAt: new Date(Date.now() - 60_000),
          deliveredAt: new Date(),
        },
      });

      expect(await codeOf(() => reassign.execute({ jobId, reason: 'No' }))).toBe(
        ErrorCode.INVALID_DELIVERY_STATE_TRANSITION,
      );
    });

    it('leaves the job in REASSIGNING when nobody else is available', async () => {
      const { jobId } = await seedJob();
      const only = await seedDriver();
      await dispatch.execute({ jobId });
      await accept.execute({ userId: only.userId, jobId });

      const result = await reassign.execute({ jobId, reason: 'Driver went offline' });

      expect(result.redispatch).toBe(DispatchOutcome.NoCandidate);
      // Recoverable, not stuck: REASSIGNING is dispatchable, so a later pass can still place it.
      expect(await jobStatus(jobId)).toBe(DeliveryJobStatus.REASSIGNING);

      const replacement = await seedDriver({ at: { lat: 9.05, lng: 38.77 } });
      expect((await dispatch.execute({ jobId })).outcome).toBe(DispatchOutcome.Offered);
      expect((await offers.findPendingForJob(jobId))?.driverId).toBe(replacement.profileId);
    });

    it('audits the reassignment with the driver it was taken from', async () => {
      const { jobId, first } = await assignedJob();
      await reassign.execute({ jobId, reason: 'Driver went offline' });

      const entries = await ctx.prisma.auditLog.findMany({
        where: { resourceType: 'DeliveryJob', resourceId: jobId },
      });
      const entry = entries.find((e) => e.action === 'DELIVERY_JOB_REASSIGNING');
      expect(entry).toBeDefined();
      expect(entry!.context).toMatchObject({
        previousDriverId: first.profileId,
        reason: 'Driver went offline',
      });
    });
  });

  // -------------------------------------------------------------------------------------------
  // 8. Dispatchability and persistence
  // -------------------------------------------------------------------------------------------

  describe('dispatchability', () => {
    it('refuses to dispatch an assigned job', async () => {
      const { jobId } = await seedJob();
      const driver = await seedDriver();
      await dispatch.execute({ jobId });
      await accept.execute({ userId: driver.userId, jobId });

      expect(await codeOf(() => dispatch.execute({ jobId }))).toBe(
        ErrorCode.INVALID_DELIVERY_STATE_TRANSITION,
      );
    });

    it('refuses to dispatch a cancelled job', async () => {
      const { jobId } = await seedJob();
      await ctx.prisma.deliveryJob.update({
        where: { id: jobId },
        data: { status: DeliveryJobStatus.CANCELLED },
      });

      expect(await codeOf(() => dispatch.execute({ jobId }))).toBe(
        ErrorCode.INVALID_DELIVERY_STATE_TRANSITION,
      );
    });

    it('refuses to dispatch an unknown job', async () => {
      expect(await codeOf(() => dispatch.execute({ jobId: randomUUID() }))).toBe(
        ErrorCode.NOT_FOUND,
      );
    });

    it('round-trips an offer through the repository and rehydrates it', async () => {
      const { jobId } = await seedJob();
      const driver = await seedDriver();
      const offered = await dispatch.execute({ jobId });

      const byId = await offers.findById(offered.offer!.id);
      const pending = await offers.findPendingForJob(jobId);
      expect(byId).toEqual(pending);

      const rehydrated = JobOffer.rehydrate(byId!);
      expect(rehydrated.driverId).toBe(driver.profileId);
      expect(rehydrated.isLiveAt(new Date())).toBe(true);
      expect(rehydrated.round).toBe(1);
      // And it can still be driven forward.
      expect(rehydrated.decline('no thanks').status).toBe(JobOfferStatus.DECLINED);
    });

    it('records the offer in the audit trail with the ranking inputs', async () => {
      const { jobId } = await seedJob();
      const driver = await seedDriver();
      await dispatch.execute({ jobId });

      const entries = await ctx.prisma.auditLog.findMany({
        where: { resourceType: 'DeliveryJob', resourceId: jobId },
      });
      const offered = entries.find((e) => e.action === 'DELIVERY_JOB_OFFERED');
      expect(offered).toBeDefined();
      expect(offered!.context).toMatchObject({
        driverId: driver.profileId,
        round: 1,
        rank: 1,
        activeJobCount: 0,
        concurrentLimit: 1,
      });
    });

    it('dispatches a job whose pickup coordinate is unknown', async () => {
      // The job-creation work degrades to a null pickup when the branch is soft-deleted; dispatch
      // must still place the job rather than leaving it unoffered forever.
      const { jobId } = await seedJob({ pickup: null });
      const driver = await seedDriver();

      const result = await dispatch.execute({ jobId });

      expect(result.outcome).toBe(DispatchOutcome.Offered);
      expect(result.offer?.driverId).toBe(driver.profileId);
      expect(result.offer).toBeDefined();
    });
  });
});
