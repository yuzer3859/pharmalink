import { randomUUID } from 'crypto';
import { AcceptJobOfferCommand } from '../../src/modules/delivery/application/commands/accept-job-offer.command';
import {
  DispatchDeliveryJobCommand,
  DispatchOutcome,
} from '../../src/modules/delivery/application/commands/dispatch-delivery-job.command';
import { AdvanceDeliveryJobCommand } from '../../src/modules/delivery/application/commands/advance-delivery-job.command';
import { CreateDriverProfileCommand } from '../../src/modules/delivery/application/commands/create-driver-profile.command';
import { ManageDriverShiftCommand } from '../../src/modules/delivery/application/commands/manage-driver-shift.command';
import { SetDriverAvailabilityCommand } from '../../src/modules/delivery/application/commands/set-driver-availability.command';
import { UpdateDriverLocationCommand } from '../../src/modules/delivery/application/commands/update-driver-location.command';
import {
  DispatchRecoverySweeper,
  DISPATCH_RECOVERY_CRON,
} from '../../src/modules/delivery/infrastructure/scheduling/dispatch-recovery.sweeper';
import {
  OfferExpirySweeper,
  OFFER_EXPIRY_CRON,
} from '../../src/modules/delivery/infrastructure/scheduling/offer-expiry.sweeper';
import {
  StaleAssignmentSweeper,
  STALE_ASSIGNMENT_CRON,
} from '../../src/modules/delivery/infrastructure/scheduling/stale-assignment.sweeper';
import {
  DeliveryJobStatus,
  DriverAvailability,
  JobOfferStatus,
} from '../../src/modules/delivery/domain/enums';
import { VehicleType } from '../../src/modules/delivery/domain/value-objects/vehicle.vo';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { uniquePhone } from '../support/fixtures';
import { SchedulerRegistry } from '@nestjs/schedule';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

/**
 * Operational recovery against real PostgreSQL (§2, §3, §4, §5 of the Work 14 brief; §6.5 and
 * §11.5 of the design).
 *
 * Everything here needs a real database and could not be claimed without one. `FOR UPDATE SKIP
 * LOCKED` has no meaning in a fake; neither does a partial unique index, nor two connections
 * racing the same row. The point of the suite is the properties the workers promise when more
 * than one of them is running and when the process that started a flow never finished it.
 *
 * ## How "a process died" and "a minute passed" are staged
 *
 * Time is moved, never waited for. Rows are backdated with raw SQL rather than through Prisma,
 * because `updatedAt` is `@updatedAt` and Prisma overwrites it on any ordinary update — a test
 * that "backdated" a job through the ORM would silently be testing nothing.
 *
 * A crash is staged by producing exactly the state a crash leaves behind and then letting a fresh
 * worker loose on it. That is a stronger test than killing a process would be: it pins down what
 * the recoverable state actually *is*, so a future change that leaves a different residue fails
 * here rather than in production.
 */
describe('Delivery operational recovery (e2e)', () => {
  let ctx: TestContext;
  let dispatch: DispatchDeliveryJobCommand;
  let accept: AcceptJobOfferCommand;
  let advance: AdvanceDeliveryJobCommand;
  let createProfile: CreateDriverProfileCommand;
  let shift: ManageDriverShiftCommand;
  let availability: SetDriverAvailabilityCommand;
  let location: UpdateDriverLocationCommand;
  let offerSweeper: OfferExpirySweeper;
  let recoverySweeper: DispatchRecoverySweeper;
  let staleSweeper: StaleAssignmentSweeper;

  const PICKUP = { lat: 9.03, lng: 38.74 };

  beforeAll(async () => {
    ctx = await createTestApp();
    dispatch = ctx.app.get(DispatchDeliveryJobCommand);
    accept = ctx.app.get(AcceptJobOfferCommand);
    advance = ctx.app.get(AdvanceDeliveryJobCommand);
    createProfile = ctx.app.get(CreateDriverProfileCommand);
    shift = ctx.app.get(ManageDriverShiftCommand);
    availability = ctx.app.get(SetDriverAvailabilityCommand);
    location = ctx.app.get(UpdateDriverLocationCommand);
    offerSweeper = ctx.app.get(OfferExpirySweeper);
    recoverySweeper = ctx.app.get(DispatchRecoverySweeper);
    staleSweeper = ctx.app.get(StaleAssignmentSweeper);
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

  async function seedJob(): Promise<{ jobId: string; orderId: string }> {
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
        pickupLat: PICKUP.lat,
        pickupLng: PICKUP.lng,
        status: DeliveryJobStatus.CREATED,
      },
    });
    return { jobId: job.id, orderId: order.id };
  }

  interface Driver {
    userId: string;
    profileId: string;
  }

  async function seedDriver(options: { online?: boolean } = {}): Promise<Driver> {
    const user = await ctx.prisma.user.create({
      data: { primaryRole: 'DRIVER', status: 'ACTIVE', phone: uniquePhone() },
    });
    await ctx.prisma.verificationRequest.create({
      data: { userId: user.id, type: 'DRIVER_DOCS', status: 'APPROVED', reviewedAt: new Date() },
    });
    const { profile } = await createProfile.execute({
      userId: user.id,
      vehicleType: VehicleType.Motorcycle,
      plateNumber: `AA-${Math.floor(Math.random() * 99_999)}`,
      serviceArea: null,
      maxConcurrent: null,
    });
    if (options.online !== false) {
      await shift.start({ userId: user.id });
      await availability.execute({ userId: user.id, availability: DriverAvailability.ONLINE });
      await location.execute({ userId: user.id, lat: PICKUP.lat, lng: PICKUP.lng });
    }
    return { userId: user.id, profileId: profile.id };
  }

  /** Pushes an offer's whole window into the past, deadline included. */
  async function expireOffer(offerId: string): Promise<void> {
    const past = Date.now() - 120_000;
    await ctx.prisma.jobOffer.update({
      where: { id: offerId },
      data: { offeredAt: new Date(past), expiresAt: new Date(past + 30_000) },
    });
  }

  /**
   * Ages a job past the recovery quiet period.
   *
   * Raw SQL, deliberately: `updatedAt` carries `@updatedAt`, so any Prisma update would stamp it
   * with `now()` and quietly undo exactly the thing being staged.
   */
  async function ageJob(jobId: string, seconds: number): Promise<void> {
    await ctx.prisma.$executeRaw`
      UPDATE "delivery_jobs"
      SET "updatedAt" = NOW() - (${seconds} * INTERVAL '1 second')
      WHERE "id" = ${jobId}
    `;
  }

  async function jobStatus(jobId: string): Promise<DeliveryJobStatus> {
    const row = await ctx.prisma.deliveryJob.findUniqueOrThrow({ where: { id: jobId } });
    return row.status;
  }

  async function liveOffers(jobId: string) {
    return ctx.prisma.jobOffer.findMany({
      where: { jobId, status: JobOfferStatus.OFFERED },
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

  // -------------------------------------------------------------------------------------------
  // 1. Expired offers — with no worker running, then with one
  // -------------------------------------------------------------------------------------------

  describe('expired offers', () => {
    it('leaves an expired offer pending while no worker runs, and the job recoverable', async () => {
      const { jobId } = await seedJob();
      await seedDriver();
      const offered = await dispatch.execute({ jobId });
      await expireOffer(offered.offer!.id);

      // Nothing has run. The deadline has passed but the row still says OFFERED — which is the
      // honest state, and precisely why a sweeper is needed: the platform's own record of who was
      // asked is not self-clearing.
      const stored = await ctx.prisma.jobOffer.findUniqueOrThrow({
        where: { id: offered.offer!.id },
      });
      expect(stored.status).toBe(JobOfferStatus.OFFERED);
      expect(stored.expiresAt.getTime()).toBeLessThan(Date.now());
      expect(await jobStatus(jobId)).toBe(DeliveryJobStatus.OFFERED);
    });

    it('expires it and re-dispatches when the worker resumes', async () => {
      const { jobId } = await seedJob();
      const first = await seedDriver();
      const offered = await dispatch.execute({ jobId });
      expect(offered.offer!.driverId).toBe(first.profileId);
      await expireOffer(offered.offer!.id);

      // A second driver exists, so the next round has somebody to go to.
      const second = await seedDriver();

      const swept = await offerSweeper.run();
      expect(swept).toBe(1);

      const retired = await ctx.prisma.jobOffer.findUniqueOrThrow({
        where: { id: offered.offer!.id },
      });
      expect(retired.status).toBe(JobOfferStatus.EXPIRED);
      // An expiry is the absence of an answer — no driver responded, so nothing is stamped.
      expect(retired.respondedAt).toBeNull();

      // §6.4's "offer next candidate", and never back to the driver who already let it lapse.
      const live = await liveOffers(jobId);
      expect(live).toHaveLength(1);
      expect(live[0].driverId).toBe(second.profileId);
      expect(live[0].round).toBe(2);
    });

    it('expires the offer even when no replacement driver exists', async () => {
      const { jobId } = await seedJob();
      await seedDriver();
      const offered = await dispatch.execute({ jobId });
      await expireOffer(offered.offer!.id);

      // The only driver has already been offered this job, so the re-dispatch finds nobody. The
      // expiry must still stand: this is the case the lazy path in dispatch cannot reach, because
      // it returns `NoCandidate` before opening a transaction.
      expect(await offerSweeper.run()).toBe(1);

      const retired = await ctx.prisma.jobOffer.findUniqueOrThrow({
        where: { id: offered.offer!.id },
      });
      expect(retired.status).toBe(JobOfferStatus.EXPIRED);
      expect(await liveOffers(jobId)).toHaveLength(0);
      // Still dispatchable. Not failed, not stranded.
      expect(await jobStatus(jobId)).toBe(DeliveryJobStatus.OFFERED);
    });

    it('converges when two workers sweep the same expired offer at once', async () => {
      const { jobId } = await seedJob();
      await seedDriver();
      const offered = await dispatch.execute({ jobId });
      await expireOffer(offered.offer!.id);
      await seedDriver();

      // Two application instances, same tick.
      const [a, b] = await Promise.all([offerSweeper.run(), offerSweeper.run()]);

      // Exactly one of them did the work — `FOR UPDATE SKIP LOCKED` plus the compare-and-set.
      expect(a + b).toBe(1);

      // And exactly one expiry was recorded, however many workers looked.
      const expired = await ctx.prisma.jobOffer.findMany({
        where: { jobId, status: JobOfferStatus.EXPIRED },
      });
      expect(expired).toHaveLength(1);
      // The invariant that matters most: never two live offers for one job.
      expect((await liveOffers(jobId)).length).toBeLessThanOrEqual(1);
    });

    it('is idempotent — a second sweep over settled work does nothing', async () => {
      const { jobId } = await seedJob();
      await seedDriver();
      const offered = await dispatch.execute({ jobId });
      await expireOffer(offered.offer!.id);

      expect(await offerSweeper.run()).toBe(1);
      expect(await offerSweeper.run()).toBe(0);
      expect(await offerSweeper.run()).toBe(0);

      expect(
        await ctx.prisma.jobOffer.count({ where: { jobId, status: JobOfferStatus.EXPIRED } }),
      ).toBe(1);
    });

    it('never expires an offer that is still within its deadline', async () => {
      const { jobId } = await seedJob();
      await seedDriver();
      const offered = await dispatch.execute({ jobId });

      expect(await offerSweeper.run()).toBe(0);
      const stored = await ctx.prisma.jobOffer.findUniqueOrThrow({
        where: { id: offered.offer!.id },
      });
      expect(stored.status).toBe(JobOfferStatus.OFFERED);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 2. No driver available, and the driver who turns up later
  // -------------------------------------------------------------------------------------------

  describe('no eligible driver', () => {
    it('does not fail or strand the job, and records why', async () => {
      const { jobId } = await seedJob();

      const result = await dispatch.execute({ jobId });

      expect(result.outcome).toBe(DispatchOutcome.NoCandidate);
      expect(result.offer).toBeNull();
      // No new terminal state was invented, and the job is exactly where it can be retried from.
      expect(await jobStatus(jobId)).toBe(DeliveryJobStatus.CREATED);

      const audit = await ctx.prisma.auditLog.findFirst({
        where: { resourceId: jobId, action: 'DELIVERY_JOB_NO_DRIVER_AVAILABLE' },
      });
      expect(audit).not.toBeNull();
    });

    it('places the job once a driver comes online, without anybody re-triggering dispatch', async () => {
      const { jobId } = await seedJob();
      expect((await dispatch.execute({ jobId })).outcome).toBe(DispatchOutcome.NoCandidate);
      await ageJob(jobId, 120);

      // Nobody is online: the worker finds the job, asks, and is told no. Nothing changes, and
      // crucially nothing is consumed — the job must still be a candidate next time.
      expect(await recoverySweeper.run()).toBe(0);
      expect(await jobStatus(jobId)).toBe(DeliveryJobStatus.CREATED);

      // A driver signs on.
      const driver = await seedDriver();
      await ageJob(jobId, 120);

      expect(await recoverySweeper.run()).toBe(1);
      expect(await jobStatus(jobId)).toBe(DeliveryJobStatus.OFFERED);
      const live = await liveOffers(jobId);
      expect(live).toHaveLength(1);
      expect(live[0].driverId).toBe(driver.profileId);
    });

    it('leaves a job alone until it has been quiet long enough', async () => {
      const { jobId } = await seedJob();
      await dispatch.execute({ jobId });
      await seedDriver();

      // Freshly touched: dispatch may still be mid-flight, so recovery must not interfere.
      expect(await recoverySweeper.run()).toBe(0);
      expect(await jobStatus(jobId)).toBe(DeliveryJobStatus.CREATED);

      await ageJob(jobId, 120);
      expect(await recoverySweeper.run()).toBe(1);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 3. Reassignment interrupted mid-flight
  // -------------------------------------------------------------------------------------------

  describe('reassignment recovery', () => {
    /**
     * Stages precisely what a process dying between `ReassignDeliveryJobCommand`'s two
     * transactions leaves behind: the release committed, the re-dispatch never ran.
     */
    async function strandInReassigning(jobId: string): Promise<void> {
      await ctx.prisma.deliveryJob.update({
        where: { id: jobId },
        data: { status: DeliveryJobStatus.REASSIGNING, assignedDriverId: null },
      });
    }

    it('recovers a job left in REASSIGNING by a crashed process', async () => {
      const { jobId } = await seedJob();
      const first = await seedDriver();
      const offered = await dispatch.execute({ jobId });
      await accept.execute({ userId: first.userId, jobId });
      expect(await jobStatus(jobId)).toBe(DeliveryJobStatus.ASSIGNED);

      await strandInReassigning(jobId);
      await ctx.prisma.jobOffer.updateMany({
        where: { id: offered.offer!.id },
        data: { status: JobOfferStatus.EXPIRED },
      });

      const replacement = await seedDriver();
      await ageJob(jobId, 120);

      expect(await recoverySweeper.run()).toBe(1);

      expect(await jobStatus(jobId)).toBe(DeliveryJobStatus.OFFERED);
      const live = await liveOffers(jobId);
      expect(live).toHaveLength(1);
      expect(live[0].driverId).toBe(replacement.profileId);
    });

    it('creates at most one offer when two recovery workers race the same job', async () => {
      const { jobId } = await seedJob();
      await strandInReassigning(jobId);
      await seedDriver();
      await seedDriver();
      await ageJob(jobId, 120);

      const [a, b] = await Promise.all([recoverySweeper.run(), recoverySweeper.run()]);

      // One of them placed it; the other either skipped the locked row or was handed the winner's
      // offer as `AlreadyOffered`. Either way the database holds one live offer.
      expect(a + b).toBeGreaterThanOrEqual(1);
      expect(await liveOffers(jobId)).toHaveLength(1);
      expect(await jobStatus(jobId)).toBe(DeliveryJobStatus.OFFERED);
    });

    it('keeps a REASSIGNING job recoverable when nobody is available yet', async () => {
      const { jobId } = await seedJob();
      await strandInReassigning(jobId);
      await ageJob(jobId, 120);

      expect(await recoverySweeper.run()).toBe(0);
      // Still REASSIGNING — the durable "this needs a driver" state, not a failure.
      expect(await jobStatus(jobId)).toBe(DeliveryJobStatus.REASSIGNING);

      await seedDriver();
      await ageJob(jobId, 120);
      expect(await recoverySweeper.run()).toBe(1);
      expect(await jobStatus(jobId)).toBe(DeliveryJobStatus.OFFERED);
    });

    it('does not touch a job that already has a live offer', async () => {
      const { jobId } = await seedJob();
      await seedDriver();
      const offered = await dispatch.execute({ jobId });
      await ageJob(jobId, 120);

      // A driver is in the middle of deciding. Recovery must leave the question standing.
      expect(await recoverySweeper.run()).toBe(0);
      const live = await liveOffers(jobId);
      expect(live).toHaveLength(1);
      expect(live[0].id).toBe(offered.offer!.id);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 4. Drivers who stop being available
  // -------------------------------------------------------------------------------------------

  describe('driver unavailability', () => {
    it('refuses an accept from a driver whose verification was revoked after the offer', async () => {
      const { jobId } = await seedJob();
      const driver = await seedDriver();
      await dispatch.execute({ jobId });

      await ctx.prisma.verificationRequest.updateMany({
        where: { userId: driver.userId, type: 'DRIVER_DOCS' },
        data: { status: 'REJECTED' },
      });

      expect(await codeOf(() => accept.execute({ userId: driver.userId, jobId }))).toBe(
        ErrorCode.DRIVER_NOT_VERIFIED,
      );
      expect(await jobStatus(jobId)).toBe(DeliveryJobStatus.OFFERED);
    });

    it('refuses an accept from a driver who went offline after the offer', async () => {
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

    it('reassigns a pre-pickup job whose driver stopped working', async () => {
      const { jobId } = await seedJob();
      const driver = await seedDriver();
      await dispatch.execute({ jobId });
      await accept.execute({ userId: driver.userId, jobId });
      expect(await jobStatus(jobId)).toBe(DeliveryJobStatus.ASSIGNED);

      // They end their shift and go home with the job still on their handset.
      await shift.end({ userId: driver.userId });
      const replacement = await seedDriver();
      await ageJob(jobId, 600);

      expect(await staleSweeper.run()).toBe(1);

      // Released from the first driver and offered to the second.
      const job = await ctx.prisma.deliveryJob.findUniqueOrThrow({ where: { id: jobId } });
      expect(job.status).toBe(DeliveryJobStatus.OFFERED);
      const live = await liveOffers(jobId);
      expect(live).toHaveLength(1);
      expect(live[0].driverId).toBe(replacement.profileId);
      expect(live[0].driverId).not.toBe(driver.profileId);

      // The trail says who lost it and why — §13's question, answerable.
      const history = await ctx.prisma.deliveryStatusHistory.findFirst({
        where: { jobId, toStatus: DeliveryJobStatus.REASSIGNING },
      });
      expect(history?.reason).toContain(driver.profileId);
    });

    it('leaves a job with a working driver alone', async () => {
      const { jobId } = await seedJob();
      const driver = await seedDriver();
      await dispatch.execute({ jobId });
      await accept.execute({ userId: driver.userId, jobId });
      await ageJob(jobId, 600);

      // Still online and on shift: nothing to recover.
      expect(await staleSweeper.run()).toBe(0);
      expect(await jobStatus(jobId)).toBe(DeliveryJobStatus.ASSIGNED);
    });

    it('never reassigns after pickup, however long the driver has been offline', async () => {
      const { jobId } = await seedJob();
      const driver = await seedDriver();
      await dispatch.execute({ jobId });
      await accept.execute({ userId: driver.userId, jobId });
      await advance.byDriver({
        userId: driver.userId,
        jobId,
        to: DeliveryJobStatus.ARRIVED_PICKUP,
      });
      await advance.byDriver({ userId: driver.userId, jobId, to: DeliveryJobStatus.PICKED_UP });

      await shift.end({ userId: driver.userId });
      await seedDriver();
      await ageJob(jobId, 86_000);

      // The medicines are in a bag on a motorbike. No worker may take this job away.
      expect(await staleSweeper.run()).toBe(0);
      const job = await ctx.prisma.deliveryJob.findUniqueOrThrow({ where: { id: jobId } });
      expect(job.status).toBe(DeliveryJobStatus.PICKED_UP);
      expect(job.assignedDriverId).toBe(driver.profileId);
    });

    it('releases a job once and only once when two workers race it', async () => {
      const { jobId } = await seedJob();
      const driver = await seedDriver();
      await dispatch.execute({ jobId });
      await accept.execute({ userId: driver.userId, jobId });
      await shift.end({ userId: driver.userId });
      await seedDriver();
      await ageJob(jobId, 600);

      const [a, b] = await Promise.all([staleSweeper.run(), staleSweeper.run()]);

      expect(a + b).toBe(1);
      expect(
        await ctx.prisma.deliveryStatusHistory.count({
          where: { jobId, toStatus: DeliveryJobStatus.REASSIGNING },
        }),
      ).toBe(1);
      expect((await liveOffers(jobId)).length).toBeLessThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 5. Scheduling itself
  // -------------------------------------------------------------------------------------------

  describe('scheduling', () => {
    it('registers each recovery worker exactly once', () => {
      // `PharmacyInventoryModule` and `DeliveryModule` both call `ScheduleModule.forRoot()`. Nest
      // dedupes dynamic modules with identical metadata, so the explorer runs once and each
      // `@Cron` is registered once — but "should dedupe" is a claim about framework internals, and
      // a doubled registration would silently double every tick's work on every instance. So it is
      // asserted rather than assumed.
      const registry = ctx.app.get(SchedulerRegistry);
      const handlers = [...registry.getCronJobs().keys()];

      for (const worker of [
        OFFER_EXPIRY_CRON,
        DISPATCH_RECOVERY_CRON,
        STALE_ASSIGNMENT_CRON,
      ]) {
        expect(handlers.filter((name) => name === worker)).toHaveLength(1);
      }
    });
  });

  // -------------------------------------------------------------------------------------------
  // 6. Restart safety, stated as a property rather than a scenario
  // -------------------------------------------------------------------------------------------

  describe('restart safety', () => {
    it('recovers work created before any worker existed, from persisted state alone', async () => {
      // Three jobs in the three states a stopped process can leave behind, all aged past the
      // quiet period — as they would be after an outage of any length.
      const stranded = await seedJob();
      const reassigning = await seedJob();
      const offeredPastTtl = await seedJob();

      await seedDriver();
      const lapsed = await dispatch.execute({ jobId: offeredPastTtl.jobId });
      await expireOffer(lapsed.offer!.id);

      await ctx.prisma.deliveryJob.update({
        where: { id: reassigning.jobId },
        data: { status: DeliveryJobStatus.REASSIGNING, assignedDriverId: null },
      });

      await seedDriver();
      await seedDriver();
      for (const id of [stranded.jobId, reassigning.jobId, offeredPastTtl.jobId]) {
        await ageJob(id, 300);
      }

      // Fresh workers, no in-memory state carried from anywhere. Everything they need is in the
      // two tables.
      await offerSweeper.run();
      await recoverySweeper.run();

      expect(await jobStatus(stranded.jobId)).toBe(DeliveryJobStatus.OFFERED);
      expect(await jobStatus(reassigning.jobId)).toBe(DeliveryJobStatus.OFFERED);
      expect(
        await ctx.prisma.jobOffer.count({
          where: { id: lapsed.offer!.id, status: JobOfferStatus.EXPIRED },
        }),
      ).toBe(1);

      // The invariant across all of it: never two live offers for one job.
      for (const id of [stranded.jobId, reassigning.jobId, offeredPastTtl.jobId]) {
        expect((await liveOffers(id)).length).toBeLessThanOrEqual(1);
      }
    });

    it('produces no duplicate offers when every worker runs repeatedly over stale work', async () => {
      const { jobId } = await seedJob();
      await seedDriver();
      const offered = await dispatch.execute({ jobId });
      await expireOffer(offered.offer!.id);
      await seedDriver();
      await ageJob(jobId, 300);

      for (let i = 0; i < 3; i += 1) {
        await offerSweeper.run();
        await recoverySweeper.run();
        await staleSweeper.run();
        await ageJob(jobId, 300);
      }

      expect((await liveOffers(jobId)).length).toBeLessThanOrEqual(1);
      // Rounds are strictly increasing and never duplicated — `(jobId, round)` is unique, and a
      // worker that re-offered the same round would have collided rather than stacked.
      const all = await ctx.prisma.jobOffer.findMany({ where: { jobId } });
      expect(new Set(all.map((o) => o.round)).size).toBe(all.length);
    });
  });
});
