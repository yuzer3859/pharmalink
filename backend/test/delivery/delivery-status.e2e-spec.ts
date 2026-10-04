import request from 'supertest';
import { randomUUID } from 'crypto';
import { AcceptJobOfferCommand } from '../../src/modules/delivery/application/commands/accept-job-offer.command';
import { AccrueDriverEarningCommand } from '../../src/modules/delivery/application/commands/accrue-driver-earning.command';
import { AdvanceDeliveryJobCommand } from '../../src/modules/delivery/application/commands/advance-delivery-job.command';
import { CancelDeliveryJobCommand } from '../../src/modules/delivery/application/commands/cancel-delivery-job.command';
import { CreateDriverProfileCommand } from '../../src/modules/delivery/application/commands/create-driver-profile.command';
import { DispatchDeliveryJobCommand } from '../../src/modules/delivery/application/commands/dispatch-delivery-job.command';
import { ManageDriverShiftCommand } from '../../src/modules/delivery/application/commands/manage-driver-shift.command';
import { ReassignDeliveryJobCommand } from '../../src/modules/delivery/application/commands/reassign-delivery-job.command';
import { SetDriverAvailabilityCommand } from '../../src/modules/delivery/application/commands/set-driver-availability.command';
import { UpdateDriverLocationCommand } from '../../src/modules/delivery/application/commands/update-driver-location.command';
import { GetDeliveryJobStatusQuery } from '../../src/modules/delivery/application/queries/get-delivery-job-status.query';
import { DeliveryJobStatus, DriverAvailability } from '../../src/modules/delivery/domain/enums';
import { DeliveryEventType } from '../../src/modules/delivery/domain/events';
import { DeliveryStatusPolicy } from '../../src/modules/delivery/domain/services/delivery-status-policy';
import { VehicleType } from '../../src/modules/delivery/domain/value-objects/vehicle.vo';
import { orderCancelledEvent } from '../../src/modules/orders/domain/events';
import { OutboxService } from '../../src/shared/outbox/outbox.service';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { auth, body, createUserWithRole, errorOf, uniquePhone } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

/**
 * The delivery status workflow against real PostgreSQL
 * (§3.3 F-STS-01/F-STS-03, §11.4, BR-DEL-07).
 *
 * Real `AppModule`, real commands and routes, the real Prisma repositories, real `Serializable`
 * transactions, the real outbox, the real hash-chained audit trail and the real
 * `delivery_status_history`.
 *
 * The claims that can only be made here:
 *
 *  1. **The compare-and-set is the database's**, so two simultaneous posts cannot both advance a
 *     job — and a released driver cannot advance one at all, because the driver is in the `WHERE`
 *     clause and not merely in an application check.
 *  2. **A duplicate writes nothing** — no history row, no audit entry, no outbox event — which is
 *     what stops a retried `/picked-up` from advancing Module 06's order twice.
 *  3. **The physical timestamps are real**, stamped by the transition that causes them, with a
 *     chronology the database holds.
 *  4. **The event contract Module 06 is designed to consume** is written to the real outbox.
 */
describe('Delivery status workflow (e2e)', () => {
  let ctx: TestContext;
  let dispatch: DispatchDeliveryJobCommand;
  let accept: AcceptJobOfferCommand;
  let advance: AdvanceDeliveryJobCommand;
  let accrue: AccrueDriverEarningCommand;
  let cancel: CancelDeliveryJobCommand;
  let reassign: ReassignDeliveryJobCommand;
  let jobStatus: GetDeliveryJobStatusQuery;
  let createProfile: CreateDriverProfileCommand;
  let shift: ManageDriverShiftCommand;
  let availability: SetDriverAvailabilityCommand;
  let location: UpdateDriverLocationCommand;
  let outbox: OutboxService;

  const PICKUP = { lat: 9.03, lng: 38.74 };

  beforeAll(async () => {
    ctx = await createTestApp();
    dispatch = ctx.app.get(DispatchDeliveryJobCommand);
    accept = ctx.app.get(AcceptJobOfferCommand);
    advance = ctx.app.get(AdvanceDeliveryJobCommand);
    accrue = ctx.app.get(AccrueDriverEarningCommand);
    cancel = ctx.app.get(CancelDeliveryJobCommand);
    reassign = ctx.app.get(ReassignDeliveryJobCommand);
    jobStatus = ctx.app.get(GetDeliveryJobStatusQuery);
    createProfile = ctx.app.get(CreateDriverProfileCommand);
    shift = ctx.app.get(ManageDriverShiftCommand);
    availability = ctx.app.get(SetDriverAvailabilityCommand);
    location = ctx.app.get(UpdateDriverLocationCommand);
    outbox = ctx.app.get(OutboxService);
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

  interface Driver {
    userId: string;
    profileId: string;
    accessToken?: string;
  }

  async function seedJob(): Promise<{ jobId: string; orderId: string; fulfillmentId: string }> {
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
    const fulfillmentId = randomUUID();
    const job = await ctx.prisma.deliveryJob.create({
      data: {
        orderId: order.id,
        fulfillmentId,
        pharmacyId: randomUUID(),
        branchId: randomUUID(),
        pickupLat: PICKUP.lat,
        pickupLng: PICKUP.lng,
        status: DeliveryJobStatus.CREATED,
      },
    });
    return { jobId: job.id, orderId: order.id, fulfillmentId };
  }

  async function seedDriver(
    options: { at?: { lat: number; lng: number }; withToken?: boolean } = {},
  ): Promise<Driver> {
    let userId: string;
    let accessToken: string | undefined;

    if (options.withToken) {
      const user = await createUserWithRole(ctx, 'DRIVER');
      await ctx.prisma.user.update({
        where: { id: user.userId },
        data: { primaryRole: 'DRIVER' },
      });
      userId = user.userId;
      accessToken = user.accessToken;
    } else {
      const user = await ctx.prisma.user.create({
        data: { primaryRole: 'DRIVER', status: 'ACTIVE', phone: uniquePhone() },
      });
      userId = user.id;
    }

    await ctx.prisma.verificationRequest.create({
      data: { userId, type: 'DRIVER_DOCS', status: 'APPROVED', reviewedAt: new Date() },
    });
    const { profile } = await createProfile.execute({
      userId,
      vehicleType: VehicleType.Motorcycle,
      plateNumber: `AA-${Math.floor(Math.random() * 99_999)}`,
      maxConcurrent: 5,
    });
    await shift.start({ userId });
    await availability.execute({ userId, availability: DriverAvailability.ONLINE });
    await location.execute({
      userId,
      lat: options.at?.lat ?? PICKUP.lat,
      lng: options.at?.lng ?? PICKUP.lng,
    });
    return { userId, profileId: profile.id, accessToken };
  }

  /** A job assigned to a driver, i.e. sitting at `ASSIGNED`. */
  async function assignedJob(driverOptions: Parameters<typeof seedDriver>[0] = {}) {
    const seeded = await seedJob();
    const driver = await seedDriver(driverOptions);
    await dispatch.execute({ jobId: seeded.jobId });
    await accept.execute({ userId: driver.userId, jobId: seeded.jobId });
    return { ...seeded, driver };
  }

  /** Drives a job forward through the driver path. */
  async function drive(driver: Driver, jobId: string, ...steps: DeliveryJobStatus[]) {
    for (const to of steps) {
      await advance.byDriver({
        userId: driver.userId,
        jobId,
        to,
        reason: to === DeliveryJobStatus.FAILED ? 'Recipient absent' : null,
      });
    }
  }

  async function codeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
    try {
      await fn();
    } catch (err) {
      return (err as { code?: string }).code;
    }
    return undefined;
  }

  async function statusOf(jobId: string): Promise<DeliveryJobStatus> {
    return (await ctx.prisma.deliveryJob.findUniqueOrThrow({ where: { id: jobId } })).status;
  }

  const FORWARD = [
    DeliveryJobStatus.ARRIVED_PICKUP,
    DeliveryJobStatus.PICKED_UP,
    DeliveryJobStatus.EN_ROUTE,
    DeliveryJobStatus.ARRIVED_DROPOFF,
    DeliveryJobStatus.DELIVERED,
  ];

  // -------------------------------------------------------------------------------------------
  // 1. The lifecycle
  // -------------------------------------------------------------------------------------------

  describe('lifecycle', () => {
    it('drives a job from ASSIGNED to COMPLETED', async () => {
      const { jobId, driver } = await assignedJob();
      await drive(driver, jobId, ...FORWARD);
      // BR-DEL-10: the platform cannot close its books on a delivery whose driver earning has not
      // been accrued. Done explicitly so this test keeps asserting the transition, not the handler.
      await accrue.execute({ jobId });
      await advance.bySystem({ jobId, to: DeliveryJobStatus.COMPLETED });

      expect(await statusOf(jobId)).toBe(DeliveryJobStatus.COMPLETED);
    });

    it('records the transitions in order, with their actors', async () => {
      const { jobId, driver } = await assignedJob();
      await drive(driver, jobId, ...FORWARD);
      await accrue.execute({ jobId });
      await advance.bySystem({ jobId, to: DeliveryJobStatus.COMPLETED });

      const history = await ctx.prisma.deliveryStatusHistory.findMany({
        where: { jobId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      expect(history.map((h) => `${h.fromStatus}->${h.toStatus}`)).toEqual([
        'CREATED->OFFERED',
        'OFFERED->ASSIGNED',
        'ASSIGNED->ARRIVED_PICKUP',
        'ARRIVED_PICKUP->PICKED_UP',
        'PICKED_UP->EN_ROUTE',
        'EN_ROUTE->ARRIVED_DROPOFF',
        'ARRIVED_DROPOFF->DELIVERED',
        'DELIVERED->COMPLETED',
      ]);
      expect(history[2].actorType).toBe('DRIVER');
      expect(history[2].actorId).toBe(driver.profileId);
      // The platform's own transition, not the driver's.
      expect(history[7].actorType).toBe('SYSTEM');
    });

    it('refuses a driver who tries to complete their own job', async () => {
      const { jobId, driver } = await assignedJob();
      await drive(driver, jobId, ...FORWARD);

      expect(
        await codeOf(() =>
          advance.byDriver({ userId: driver.userId, jobId, to: DeliveryJobStatus.COMPLETED }),
        ),
      ).toBe(ErrorCode.VALIDATION_ERROR);
      expect(await statusOf(jobId)).toBe(DeliveryJobStatus.DELIVERED);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 2. Timestamps
  // -------------------------------------------------------------------------------------------

  describe('physical timestamps', () => {
    it('stamps pickedUpAt and deliveredAt on the transitions that cause them', async () => {
      const { jobId, driver } = await assignedJob();

      await drive(driver, jobId, DeliveryJobStatus.ARRIVED_PICKUP);
      let row = await ctx.prisma.deliveryJob.findUniqueOrThrow({ where: { id: jobId } });
      expect(row.pickedUpAt).toBeNull();

      await drive(driver, jobId, DeliveryJobStatus.PICKED_UP);
      row = await ctx.prisma.deliveryJob.findUniqueOrThrow({ where: { id: jobId } });
      expect(row.pickedUpAt).toBeInstanceOf(Date);
      expect(row.deliveredAt).toBeNull();

      await drive(
        driver,
        jobId,
        DeliveryJobStatus.EN_ROUTE,
        DeliveryJobStatus.ARRIVED_DROPOFF,
        DeliveryJobStatus.DELIVERED,
      );
      row = await ctx.prisma.deliveryJob.findUniqueOrThrow({ where: { id: jobId } });
      expect(row.deliveredAt!.getTime()).toBeGreaterThanOrEqual(row.pickedUpAt!.getTime());
    });

    it('derives the intermediate timestamps from the history', async () => {
      const { jobId, driver } = await assignedJob();
      await drive(driver, jobId, ...FORWARD);

      const view = await jobStatus.execute({ jobId });
      expect(view.timeline.assignedAt).toBeInstanceOf(Date);
      expect(view.timeline.arrivedPickupAt).toBeInstanceOf(Date);
      expect(view.timeline.enRouteAt).toBeInstanceOf(Date);
      expect(view.timeline.arrivedDropoffAt).toBeInstanceOf(Date);
      expect(view.timeline.completedAt).toBeNull();
      expect(view.timeline.failedAt).toBeNull();

      // The timeline is monotonic, which is what makes it a timeline.
      const ordered = [
        view.timeline.assignedAt!,
        view.timeline.arrivedPickupAt!,
        view.timeline.pickedUpAt!,
        view.timeline.enRouteAt!,
        view.timeline.arrivedDropoffAt!,
        view.timeline.deliveredAt!,
      ].map((d) => d.getTime());
      expect([...ordered].sort((a, b) => a - b)).toEqual(ordered);
    });

    it('refuses to persist an impossible chronology', async () => {
      // A pickup time in the future makes the delivery precede it. The aggregate refuses on
      // rehydration, so the row is never written.
      const { jobId, driver } = await assignedJob();
      await drive(driver, jobId, DeliveryJobStatus.ARRIVED_PICKUP, DeliveryJobStatus.PICKED_UP);
      await ctx.prisma.deliveryJob.update({
        where: { id: jobId },
        data: { pickedUpAt: new Date(Date.now() + 86_400_000) },
      });
      await drive(driver, jobId, DeliveryJobStatus.EN_ROUTE, DeliveryJobStatus.ARRIVED_DROPOFF)
        .catch(() => undefined);

      expect(
        await codeOf(() =>
          advance.byDriver({ userId: driver.userId, jobId, to: DeliveryJobStatus.DELIVERED }),
        ),
      ).toBe(ErrorCode.VALIDATION_ERROR);
      const row = await ctx.prisma.deliveryJob.findUniqueOrThrow({ where: { id: jobId } });
      expect(row.deliveredAt).toBeNull();
    });
  });

  // -------------------------------------------------------------------------------------------
  // 3. Ownership
  // -------------------------------------------------------------------------------------------

  describe('ownership', () => {
    it('refuses a driver who is not carrying the job', async () => {
      const { jobId } = await assignedJob();
      const outsider = await seedDriver({ at: { lat: 9.4, lng: 39.1 } });

      expect(
        await codeOf(() =>
          advance.byDriver({
            userId: outsider.userId,
            jobId,
            to: DeliveryJobStatus.ARRIVED_PICKUP,
          }),
        ),
      ).toBe(ErrorCode.NOT_FOUND);
      expect(await statusOf(jobId)).toBe(DeliveryJobStatus.ASSIGNED);
    });

    it('refuses a driver released by a reassignment', async () => {
      const { jobId, driver } = await assignedJob();
      await seedDriver({ at: { lat: 9.05, lng: 38.76 } });
      await reassign.execute({ jobId, reason: 'Driver unreachable' });

      expect(
        await codeOf(() =>
          advance.byDriver({
            userId: driver.userId,
            jobId,
            to: DeliveryJobStatus.ARRIVED_PICKUP,
          }),
        ),
      ).toBe(ErrorCode.NOT_FOUND);
    });

    it('refuses a driver whose verification is revoked mid-delivery', async () => {
      const { jobId, driver } = await assignedJob();
      await ctx.prisma.verificationRequest.updateMany({
        where: { userId: driver.userId },
        data: { status: 'REJECTED' },
      });

      expect(
        await codeOf(() =>
          advance.byDriver({
            userId: driver.userId,
            jobId,
            to: DeliveryJobStatus.ARRIVED_PICKUP,
          }),
        ),
      ).toBe(ErrorCode.DRIVER_NOT_VERIFIED);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 4. Idempotency
  // -------------------------------------------------------------------------------------------

  describe('idempotency', () => {
    it('treats a repeat as a successful no-op that writes nothing', async () => {
      const { jobId, driver } = await assignedJob();
      await drive(driver, jobId, DeliveryJobStatus.ARRIVED_PICKUP, DeliveryJobStatus.PICKED_UP);

      const before = {
        history: await ctx.prisma.deliveryStatusHistory.count({ where: { jobId } }),
        audit: await ctx.prisma.auditLog.count({ where: { resourceId: jobId } }),
        outbox: await ctx.prisma.outbox.count({ where: { aggregateId: jobId } }),
        row: await ctx.prisma.deliveryJob.findUniqueOrThrow({ where: { id: jobId } }),
      };

      const retry = await advance.byDriver({
        userId: driver.userId,
        jobId,
        to: DeliveryJobStatus.PICKED_UP,
      });

      expect(retry.changed).toBe(false);
      expect(await ctx.prisma.deliveryStatusHistory.count({ where: { jobId } })).toBe(
        before.history,
      );
      expect(await ctx.prisma.auditLog.count({ where: { resourceId: jobId } })).toBe(
        before.audit,
      );
      expect(await ctx.prisma.outbox.count({ where: { aggregateId: jobId } })).toBe(
        before.outbox,
      );
      // And the physical timestamp is not restamped.
      const after = await ctx.prisma.deliveryJob.findUniqueOrThrow({ where: { id: jobId } });
      expect(after.pickedUpAt).toEqual(before.row.pickedUpAt);
    });

    it('refuses a stale request rather than moving the job backwards', async () => {
      const { jobId, driver } = await assignedJob();
      await drive(
        driver,
        jobId,
        DeliveryJobStatus.ARRIVED_PICKUP,
        DeliveryJobStatus.PICKED_UP,
        DeliveryJobStatus.EN_ROUTE,
      );

      expect(
        await codeOf(() =>
          advance.byDriver({ userId: driver.userId, jobId, to: DeliveryJobStatus.PICKED_UP }),
        ),
      ).toBe(ErrorCode.INVALID_DELIVERY_STATE_TRANSITION);
      expect(await statusOf(jobId)).toBe(DeliveryJobStatus.EN_ROUTE);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 5. Concurrency, against the real database
  // -------------------------------------------------------------------------------------------

  describe('concurrency', () => {
    it('lets only one of several simultaneous identical posts write', async () => {
      const { jobId, driver } = await assignedJob();
      await drive(driver, jobId, DeliveryJobStatus.ARRIVED_PICKUP);

      const results = await Promise.all([
        advance.byDriver({ userId: driver.userId, jobId, to: DeliveryJobStatus.PICKED_UP }),
        advance.byDriver({ userId: driver.userId, jobId, to: DeliveryJobStatus.PICKED_UP }),
        advance.byDriver({ userId: driver.userId, jobId, to: DeliveryJobStatus.PICKED_UP }),
      ]);

      expect(results.filter((r) => r.changed)).toHaveLength(1);
      expect(await statusOf(jobId)).toBe(DeliveryJobStatus.PICKED_UP);
      // Exactly one history row and one event for the transition, however many requests arrived.
      const rows = await ctx.prisma.deliveryStatusHistory.findMany({
        where: { jobId, toStatus: DeliveryJobStatus.PICKED_UP },
      });
      expect(rows).toHaveLength(1);
      const events = await ctx.prisma.outbox.findMany({
        where: { aggregateId: jobId, eventType: DeliveryEventType.OrderPickedUp },
      });
      expect(events).toHaveLength(1);
    });

    /**
     * Two *different* legal transitions posted at once.
     *
     * This test previously asserted that exactly one of them wins and the other is refused. That
     * premise was wrong, and the implementation was right. `FAILED` is legal from `PICKED_UP`
     * **and** from `EN_ROUTE` (`DeliveryStatusPolicy`'s table), so when the `EN_ROUTE` writer
     * commits first and the `FAILED` writer's `Serializable` transaction aborts on the read-write
     * dependency, `runWithDeliveryRetry` re-reads the job, finds it in `EN_ROUTE`, and finds
     * `FAILED` perfectly legal from there. It commits — correctly. A driver whose customer is
     * absent must be able to fail a delivery that has just gone en route; forcing "one winner"
     * would mean refusing them, which is a worse platform, not a safer one.
     *
     * So the real contract is not "one writer wins". It is:
     *
     *  - **`PICKED_UP` is left exactly once.** However many writers raced, the job departs that
     *    state by one edge, recorded once.
     *  - **Every transition that happened was legal**, in the order it happened. The job walks a
     *    legal path; it never teleports.
     *  - **The job ends somewhere reachable**, in a state the state machine admits.
     *
     * Those are asserted below, and they are strictly *stronger* than the old assertion: the chain
     * walk checks every edge the job actually took, which the previous version never looked at.
     */
    it('resolves two different simultaneous transitions along one legal chain', async () => {
      const { jobId, driver } = await assignedJob();
      await drive(driver, jobId, DeliveryJobStatus.ARRIVED_PICKUP, DeliveryJobStatus.PICKED_UP);

      const results = await Promise.allSettled([
        advance.byDriver({ userId: driver.userId, jobId, to: DeliveryJobStatus.EN_ROUTE }),
        advance.byDriver({ userId: driver.userId, jobId, to: DeliveryJobStatus.FAILED, reason: 'Absent' }),
      ]);

      // Whatever the interleaving, at least one writer must have got through: two legal posts
      // against a live job cannot both be refused.
      const changed = results.filter((r) => r.status === 'fulfilled' && r.value.changed);
      expect(changed.length).toBeGreaterThanOrEqual(1);

      // `PICKED_UP` is departed once and once only — the invariant a lost compare-and-set and a
      // serialization retry both have to preserve, and the one a double-write would break.
      expect(
        await ctx.prisma.deliveryStatusHistory.count({
          where: { jobId, fromStatus: DeliveryJobStatus.PICKED_UP },
        }),
      ).toBe(1);

      // Every recorded transition from PICKED_UP onwards was legal, in sequence. This is what
      // rules out the failure the old assertion was reaching for: a write that landed on a status
      // its author never read.
      const trail = await ctx.prisma.deliveryStatusHistory.findMany({
        where: { jobId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      let walked: DeliveryJobStatus = DeliveryJobStatus.CREATED;
      for (const row of trail) {
        expect(row.fromStatus).toBe(walked);
        expect(
          DeliveryStatusPolicy.isLegalTransition(
            row.fromStatus as DeliveryJobStatus,
            row.toStatus as DeliveryJobStatus,
          ),
        ).toBe(true);
        walked = row.toStatus as DeliveryJobStatus;
      }

      // ...and the job's own column agrees with the end of that trail.
      expect(await statusOf(jobId)).toBe(walked);
      expect([DeliveryJobStatus.EN_ROUTE, DeliveryJobStatus.FAILED]).toContain(walked);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 6. Events
  // -------------------------------------------------------------------------------------------

  describe('order synchronization', () => {
    it('emits the three catalogued events Module 06 consumes, each exactly once', async () => {
      const { jobId, orderId, fulfillmentId, driver } = await assignedJob();
      await drive(driver, jobId, ...FORWARD);
      // Retries after each, to prove they add nothing.
      await drive(driver, jobId, DeliveryJobStatus.DELIVERED);

      const events = await ctx.prisma.outbox.findMany({
        where: { aggregateId: jobId },
        orderBy: { createdAt: 'asc' },
      });
      const types = events.map((e) => e.eventType);
      expect(types.filter((t) => t === DeliveryEventType.OrderPickedUp)).toHaveLength(1);
      expect(types.filter((t) => t === DeliveryEventType.EnRoute)).toHaveLength(1);
      expect(types.filter((t) => t === DeliveryEventType.OrderDelivered)).toHaveLength(1);

      const delivered = events.find((e) => e.eventType === DeliveryEventType.OrderDelivered)!;
      const payload = (delivered.payload as { payload: Record<string, unknown> }).payload;
      expect(payload).toMatchObject({
        jobId,
        orderId,
        fulfillmentId,
        driverId: driver.profileId,
        status: DeliveryJobStatus.DELIVERED,
      });
      // No location, no proof of delivery.
      expect(Object.keys(payload).sort()).toEqual([
        'driverId',
        'fulfillmentId',
        'jobId',
        'orderId',
        'status',
      ]);
    });

    it('emits nothing for the two arrival steps or for completion', async () => {
      const { jobId, driver } = await assignedJob();
      await drive(driver, jobId, DeliveryJobStatus.ARRIVED_PICKUP);
      expect(
        await ctx.prisma.outbox.count({
          where: { aggregateId: jobId, eventType: { startsWith: 'delivery.order' } },
        }),
      ).toBe(0);

      await drive(driver, jobId, ...FORWARD.slice(1));
      // The earning is accrued before the baseline is taken. `EarningAccrued` is filed under the
      // *earning's* aggregate id, not the job's, so it does not disturb this count — which is
      // itself the point: completion still emits nothing about the delivery job.
      await accrue.execute({ jobId });
      const before = await ctx.prisma.outbox.count({ where: { aggregateId: jobId } });
      await advance.bySystem({ jobId, to: DeliveryJobStatus.COMPLETED });
      expect(await ctx.prisma.outbox.count({ where: { aggregateId: jobId } })).toBe(before);
    });

    it('emits DeliveryFailed with its reason', async () => {
      const { jobId, driver } = await assignedJob();
      await drive(driver, jobId, DeliveryJobStatus.ARRIVED_PICKUP, DeliveryJobStatus.PICKED_UP);
      await advance.byDriver({
        userId: driver.userId,
        jobId,
        to: DeliveryJobStatus.FAILED,
        reason: 'Recipient absent after three attempts',
      });

      const event = await ctx.prisma.outbox.findFirstOrThrow({
        where: { aggregateId: jobId, eventType: DeliveryEventType.DeliveryFailed },
      });
      expect((event.payload as { payload: Record<string, unknown> }).payload).toMatchObject({
        reason: 'Recipient absent after three attempts',
        status: DeliveryJobStatus.FAILED,
      });
    });

    it('keeps the Module 06 event contract loadable and distinct from Orders’ own names', async () => {
      // Module 06 publishes `order.*`; Module 08's status events are namespaced `delivery.*`, so
      // `OrderDelivered` (delivery) and the `OrderDelivered` Module 06 will publish cannot collide.
      expect(DeliveryEventType.OrderPickedUp).toBe('delivery.order.picked_up');
      expect(DeliveryEventType.OrderDelivered).toBe('delivery.order.delivered');
      expect(DeliveryEventType.OrderPickedUp.startsWith('delivery.')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 7. The pickup boundary
  // -------------------------------------------------------------------------------------------

  describe('pickup boundary', () => {
    it('cancels a job that has not been picked up', async () => {
      const { jobId } = await assignedJob();
      const cancelled = await cancel.execute({ jobId, reason: 'Customer cancelled' });
      expect(cancelled.status).toBe(DeliveryJobStatus.CANCELLED);
    });

    it('refuses cancellation once the driver has the medicines', async () => {
      const { jobId, driver } = await assignedJob();
      await drive(driver, jobId, DeliveryJobStatus.ARRIVED_PICKUP, DeliveryJobStatus.PICKED_UP);

      expect(await codeOf(() => cancel.execute({ jobId, reason: 'Too late' }))).toBe(
        ErrorCode.INVALID_DELIVERY_STATE_TRANSITION,
      );
      expect(await statusOf(jobId)).toBe(DeliveryJobStatus.PICKED_UP);
    });

    it('refuses reassignment once the driver has the medicines', async () => {
      const { jobId, driver } = await assignedJob();
      await seedDriver({ at: { lat: 9.05, lng: 38.76 } });
      await drive(driver, jobId, DeliveryJobStatus.ARRIVED_PICKUP, DeliveryJobStatus.PICKED_UP);

      expect(await codeOf(() => reassign.execute({ jobId, reason: 'Too late' }))).toBe(
        ErrorCode.INVALID_DELIVERY_STATE_TRANSITION,
      );
      const row = await ctx.prisma.deliveryJob.findUniqueOrThrow({ where: { id: jobId } });
      expect(row.status).toBe(DeliveryJobStatus.PICKED_UP);
      expect(row.assignedDriverId).toBe(driver.profileId);
    });

    it('keeps the driver attached through a failed delivery', async () => {
      const { jobId, driver } = await assignedJob();
      await drive(driver, jobId, DeliveryJobStatus.ARRIVED_PICKUP, DeliveryJobStatus.PICKED_UP);
      await advance.byDriver({
        userId: driver.userId,
        jobId,
        to: DeliveryJobStatus.FAILED,
        reason: 'Recipient absent',
      });

      const row = await ctx.prisma.deliveryJob.findUniqueOrThrow({ where: { id: jobId } });
      expect(row.status).toBe(DeliveryJobStatus.FAILED);
      // The trail of who was carrying it when it failed is exactly what a dispute needs.
      expect(row.assignedDriverId).toBe(driver.profileId);
    });

    it('cancels every job of an order and reports the one it cannot', async () => {
      const first = await assignedJob();
      // A second job on the same order, as a split order would produce.
      const secondJob = await ctx.prisma.deliveryJob.create({
        data: {
          orderId: first.orderId,
          fulfillmentId: randomUUID(),
          pharmacyId: randomUUID(),
          branchId: randomUUID(),
          status: DeliveryJobStatus.CREATED,
        },
      });
      await drive(
        first.driver,
        first.jobId,
        DeliveryJobStatus.ARRIVED_PICKUP,
        DeliveryJobStatus.PICKED_UP,
      );

      const result = await cancel.forOrder({
        orderId: first.orderId,
        reason: 'Customer cancelled',
      });

      // One driver already collecting must not stop the other job from being cancelled.
      expect(result.cancelled.map((j) => j.id)).toEqual([secondJob.id]);
      expect(result.refused).toEqual([
        { jobId: first.jobId, status: DeliveryJobStatus.PICKED_UP },
      ]);
    });

    it('cancels jobs when Module 06 publishes order.cancelled through the real outbox', async () => {
      const { jobId, orderId } = await assignedJob();

      await outbox.write(orderCancelledEvent({ orderId, reason: 'Customer changed their mind' }));
      await ctx.drainOutbox();

      expect(await statusOf(jobId)).toBe(DeliveryJobStatus.CANCELLED);
      const history = await ctx.prisma.deliveryStatusHistory.findFirstOrThrow({
        where: { jobId, toStatus: DeliveryJobStatus.CANCELLED },
      });
      expect(history.reason).toContain('Customer changed their mind');
      expect(history.actorType).toBe('SYSTEM');
    });

    it('is unharmed by a redelivered order.cancelled', async () => {
      const { jobId, orderId } = await assignedJob();
      await outbox.write(orderCancelledEvent({ orderId, reason: 'Cancelled' }));
      await ctx.drainOutbox();
      await outbox.write(orderCancelledEvent({ orderId, reason: 'Cancelled' }));
      await ctx.drainOutbox();

      expect(await statusOf(jobId)).toBe(DeliveryJobStatus.CANCELLED);
      expect(
        await ctx.prisma.deliveryStatusHistory.count({
          where: { jobId, toStatus: DeliveryJobStatus.CANCELLED },
        }),
      ).toBe(1);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 8. HTTP
  // -------------------------------------------------------------------------------------------

  describe('HTTP', () => {
    it('drives the whole lifecycle through the six routes', async () => {
      const { jobId, driver } = await assignedJob({ withToken: true });
      const token = driver.accessToken!;

      for (const path of ['arrived-pickup', 'picked-up', 'en-route', 'arrived-dropoff', 'deliver']) {
        const res = await request(ctx.server)
          .post(`/delivery/jobs/${jobId}/${path}`)
          .set(...auth(token))
          .send({})
          .expect(201);
        expect(body(res).changed).toBe(true);
      }

      expect(await statusOf(jobId)).toBe(DeliveryJobStatus.DELIVERED);
    });

    it('returns changed:false for a duplicate post', async () => {
      const { jobId, driver } = await assignedJob({ withToken: true });
      const token = driver.accessToken!;
      await request(ctx.server)
        .post(`/delivery/jobs/${jobId}/arrived-pickup`)
        .set(...auth(token))
        .send({})
        .expect(201);

      const res = await request(ctx.server)
        .post(`/delivery/jobs/${jobId}/arrived-pickup`)
        .set(...auth(token))
        .send({})
        .expect(201);

      expect(body(res)).toMatchObject({
        status: DeliveryJobStatus.ARRIVED_PICKUP,
        changed: false,
      });
    });

    it('answers 409 for a backward post', async () => {
      const { jobId, driver } = await assignedJob({ withToken: true });
      const token = driver.accessToken!;
      await drive(driver, jobId, DeliveryJobStatus.ARRIVED_PICKUP, DeliveryJobStatus.PICKED_UP);

      const res = await request(ctx.server)
        .post(`/delivery/jobs/${jobId}/arrived-pickup`)
        .set(...auth(token))
        .send({})
        .expect(409);

      expect(errorOf(res).code).toBe(ErrorCode.INVALID_DELIVERY_STATE_TRANSITION);
    });

    it('answers 404 for a job the caller is not carrying', async () => {
      const { jobId } = await assignedJob();
      const outsider = await seedDriver({ at: { lat: 9.4, lng: 39.1 }, withToken: true });

      const res = await request(ctx.server)
        .post(`/delivery/jobs/${jobId}/arrived-pickup`)
        .set(...auth(outsider.accessToken!))
        .send({})
        .expect(404);

      expect(errorOf(res).code).toBe(ErrorCode.NOT_FOUND);
    });

    it('refuses an unauthenticated caller', async () => {
      const { jobId } = await assignedJob();
      await request(ctx.server).post(`/delivery/jobs/${jobId}/picked-up`).send({}).expect(401);
    });

    it('refuses a CUSTOMER, who holds no delivery permission', async () => {
      const { jobId } = await assignedJob();
      const customer = await createUserWithRole(ctx, 'CUSTOMER');

      const res = await request(ctx.server)
        .post(`/delivery/jobs/${jobId}/picked-up`)
        .set(...auth(customer.accessToken))
        .send({})
        .expect(403);

      expect(errorOf(res).code).toBe(ErrorCode.FORBIDDEN);
      expect(await statusOf(jobId)).toBe(DeliveryJobStatus.ASSIGNED);
    });

    it('requires a reason on /fail', async () => {
      const { jobId, driver } = await assignedJob({ withToken: true });
      await drive(driver, jobId, DeliveryJobStatus.ARRIVED_PICKUP, DeliveryJobStatus.PICKED_UP);

      await request(ctx.server)
        .post(`/delivery/jobs/${jobId}/fail`)
        .set(...auth(driver.accessToken!))
        .send({})
        .expect(400);

      await request(ctx.server)
        .post(`/delivery/jobs/${jobId}/fail`)
        .set(...auth(driver.accessToken!))
        .send({ reason: 'Recipient absent' })
        .expect(201);

      expect(await statusOf(jobId)).toBe(DeliveryJobStatus.FAILED);
    });

    it('rejects proof-of-delivery fields on /deliver rather than discarding them', async () => {
      // `forbidNonWhitelisted`: telling a client its signature was recorded when PoD does not
      // exist would be worse than refusing the request.
      const { jobId, driver } = await assignedJob({ withToken: true });
      await drive(driver, jobId, ...FORWARD.slice(0, 4));

      await request(ctx.server)
        .post(`/delivery/jobs/${jobId}/deliver`)
        .set(...auth(driver.accessToken!))
        .send({ podType: 'SIGNATURE', recipientName: 'Abebe' })
        .expect(400);
    });

    it('records the position posted with a transition', async () => {
      const { jobId, driver } = await assignedJob({ withToken: true });

      await request(ctx.server)
        .post(`/delivery/jobs/${jobId}/arrived-pickup`)
        .set(...auth(driver.accessToken!))
        .send({ lat: 9.031, lng: 38.741 })
        .expect(201);

      const entry = await ctx.prisma.deliveryStatusHistory.findFirstOrThrow({
        where: { jobId, toStatus: DeliveryJobStatus.ARRIVED_PICKUP },
      });
      expect(entry.lat).toBeCloseTo(9.031, 6);
      expect(entry.lng).toBeCloseTo(38.741, 6);
    });

    it('serves the status read with its timeline, scoped to the carrying driver', async () => {
      const { jobId, driver } = await assignedJob({ withToken: true });
      await drive(driver, jobId, DeliveryJobStatus.ARRIVED_PICKUP, DeliveryJobStatus.PICKED_UP);

      const res = await request(ctx.server)
        .get(`/delivery/jobs/${jobId}/status`)
        .set(...auth(driver.accessToken!))
        .expect(200);

      const data = body(res);
      expect(data.status).toBe(DeliveryJobStatus.PICKED_UP);
      expect((data.history as unknown[]).length).toBeGreaterThanOrEqual(4);
      expect((data.timeline as Record<string, unknown>).pickedUpAt).toEqual(expect.any(String));
      expect((data.timeline as Record<string, unknown>).deliveredAt).toBeNull();
      // No location anywhere in the payload — that belongs to the tracking work.
      expect(JSON.stringify(data)).not.toContain('lastLocation');
    });

    it('answers 404 on the status read for another driver’s job', async () => {
      const { jobId } = await assignedJob();
      const outsider = await seedDriver({ at: { lat: 9.4, lng: 39.1 }, withToken: true });

      await request(ctx.server)
        .get(`/delivery/jobs/${jobId}/status`)
        .set(...auth(outsider.accessToken!))
        .expect(404);
    });
  });
});
