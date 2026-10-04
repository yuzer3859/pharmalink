import request from 'supertest';
import { randomUUID } from 'crypto';
import { AcceptJobOfferCommand } from '../../src/modules/delivery/application/commands/accept-job-offer.command';
import { AccrueDriverEarningCommand } from '../../src/modules/delivery/application/commands/accrue-driver-earning.command';
import { AdvanceDeliveryJobCommand } from '../../src/modules/delivery/application/commands/advance-delivery-job.command';
import { CreateDeliveryJobCommand } from '../../src/modules/delivery/application/commands/create-delivery-job.command';
import { CreateDriverProfileCommand } from '../../src/modules/delivery/application/commands/create-driver-profile.command';
import { DispatchDeliveryJobCommand } from '../../src/modules/delivery/application/commands/dispatch-delivery-job.command';
import { ManageDriverShiftCommand } from '../../src/modules/delivery/application/commands/manage-driver-shift.command';
import { SetDriverAvailabilityCommand } from '../../src/modules/delivery/application/commands/set-driver-availability.command';
import {
  EARNING_BASE_CONFIG_KEY,
  EARNING_FEE_SHARE_PERCENT_CONFIG_KEY,
  EARNING_MAXIMUM_CONFIG_KEY,
  EARNING_MINIMUM_CONFIG_KEY,
  EARNING_PER_KM_CONFIG_KEY,
  EARNING_ROUND_TO_CONFIG_KEY,
  EARNING_VERSION_CONFIG_KEY,
} from '../../src/modules/delivery/application/services/driver-earning-settings';
import {
  DeliveryJobStatus,
  DriverAvailability,
} from '../../src/modules/delivery/domain/enums';
import { DeliveryEventType } from '../../src/modules/delivery/domain/events';
import { VehicleType } from '../../src/modules/delivery/domain/value-objects/vehicle.vo';
import { AppConfigService } from '../../src/shared/config/app-config.service';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { auth, body, createUserWithRole, errorOf, uniquePhone } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

/**
 * Driver earnings accrual against real PostgreSQL (§3.5 F-ERN-01/F-ERN-02, BR-DEL-10).
 *
 * Real `AppModule`, real routes, real guards, the real RBAC catalogue, the real Prisma repository,
 * real `Serializable` transactions, the real hash-chained audit trail and the real outbox.
 *
 * The claims that can only be made here:
 *
 *  1. **Idempotency is the database's.** `driver_earnings.jobId` carries a unique index, so a
 *     redelivered completion event is settled by Postgres rather than by anything in memory —
 *     which is what makes it still work with two API nodes behind a load balancer.
 *  2. **Concurrent accruals converge on one earning.** Not one per node, and not one per event
 *     delivery: one per delivery, because the platform must never record that it owes a driver
 *     twice for the same journey.
 *  3. **`COMPLETED` is gated on the accrual**, and a failed accrual leaves the job exactly
 *     `DELIVERED` — no history row, no audit entry, no event. A bookkeeping failure cannot retract
 *     a physical delivery.
 *  4. **Module 07 is untouched.** No ledger entry, no wallet movement, no settlement row — checked
 *     against the real Module 07 tables, not asserted in prose.
 *  5. **The read is scoped by the token.** Another driver's earnings answer `404`, and no route
 *     anywhere accepts a write.
 */
describe('Driver earnings (e2e)', () => {
  let ctx: TestContext;
  let createJob: CreateDeliveryJobCommand;
  let dispatch: DispatchDeliveryJobCommand;
  let accept: AcceptJobOfferCommand;
  let advance: AdvanceDeliveryJobCommand;
  let accrue: AccrueDriverEarningCommand;
  let createProfile: CreateDriverProfileCommand;
  let shift: ManageDriverShiftCommand;
  let availability: SetDriverAvailabilityCommand;
  let config: AppConfigService;

  /**
   * Earning-agreement values overridden for one test, on the real config port.
   *
   * Every `delivery.earning*` key ships defaulted to zero and the environment this suite boots sets
   * none of them, so a paid delivery would otherwise be untestable without a second application.
   * The override goes through `AppConfigService.get` — the same call `resolveDriverEarningSettings`
   * makes — so what runs is the production lookup with a different answer, never a different code
   * path.
   */
  const overrides = new Map<string, unknown>();

  beforeAll(async () => {
    ctx = await createTestApp();
    createJob = ctx.app.get(CreateDeliveryJobCommand);
    dispatch = ctx.app.get(DispatchDeliveryJobCommand);
    accept = ctx.app.get(AcceptJobOfferCommand);
    advance = ctx.app.get(AdvanceDeliveryJobCommand);
    accrue = ctx.app.get(AccrueDriverEarningCommand);
    createProfile = ctx.app.get(CreateDriverProfileCommand);
    shift = ctx.app.get(ManageDriverShiftCommand);
    availability = ctx.app.get(SetDriverAvailabilityCommand);
    config = ctx.app.get(AppConfigService);

    const real = config.get.bind(config);
    jest
      .spyOn(config, 'get')
      .mockImplementation(<T>(key: string): T | undefined =>
        overrides.has(key) ? (overrides.get(key) as T) : real<T>(key),
      );
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    overrides.clear();
    await ctx.reset();
  });

  // -------------------------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------------------------

  interface Scenario {
    jobId: string;
    orderId: string;
    fulfillmentId: string;
    driver: { userId: string; profileId: string; accessToken: string };
  }

  async function seedDriver(): Promise<Scenario['driver']> {
    const user = await createUserWithRole(ctx, 'DRIVER');
    await ctx.prisma.user.update({
      where: { id: user.userId },
      data: { primaryRole: 'DRIVER' },
    });
    await ctx.prisma.verificationRequest.create({
      data: {
        userId: user.userId,
        type: 'DRIVER_DOCS',
        status: 'APPROVED',
        reviewedAt: new Date(),
      },
    });
    const { profile } = await createProfile.execute({
      userId: user.userId,
      vehicleType: VehicleType.Motorcycle,
      plateNumber: 'AA-12345',
      serviceArea: { lat: 9.03, lng: 38.74, radiusMeters: 20_000 },
    });
    await shift.start({ userId: user.userId });
    await availability.execute({ userId: user.userId, availability: DriverAvailability.ONLINE });
    return { userId: user.userId, profileId: profile.id, accessToken: user.accessToken };
  }

  /** A ready fulfillment with the frozen fee and distance Work 09 records. */
  async function seedFulfillment(options: { deliveryFee?: number } = {}) {
    const owner = await ctx.prisma.user.create({
      data: { primaryRole: 'PHARMACY_OWNER', status: 'ACTIVE', phone: uniquePhone() },
    });
    const organization = await ctx.prisma.organization.create({
      data: {
        type: 'PHARMACY',
        name: `Org ${randomUUID()}`,
        status: 'ACTIVE',
        ownerUserId: owner.id,
      },
    });
    const pharmacy = await ctx.prisma.pharmacy.create({
      data: { organizationId: organization.id, displayName: 'Bole Pharmacy' },
    });
    const branch = await ctx.prisma.branch.create({
      data: {
        pharmacyId: pharmacy.id,
        name: 'Bole Branch',
        addressLine: 'Africa Ave',
        city: 'Addis Ababa',
        lat: 9.03,
        lng: 38.74,
      },
    });
    const product = await ctx.prisma.product.create({
      data: { type: 'MEDICINE', nameEn: 'Amoxicillin 500mg', genericName: 'Amoxicillin' },
    });
    const deliveryFee = options.deliveryFee ?? 4_000;
    const order = await ctx.prisma.order.create({
      data: {
        orderNumber: `ORD-${randomUUID()}`,
        customerUserId: randomUUID(),
        status: 'PAID',
        subtotal: 20_000,
        deliveryFee,
        grandTotal: 20_000 + deliveryFee,
        currency: 'ETB',
        idempotencyKey: `checkout-${randomUUID()}`,
        addressSnapshot: {
          line1: 'Kazanchis, Bldg 4',
          city: 'Addis Ababa',
          lat: 8.98,
          lng: 38.79,
        },
      },
    });
    const fulfillment = await ctx.prisma.fulfillment.create({
      data: {
        orderId: order.id,
        pharmacyId: pharmacy.id,
        branchId: branch.id,
        status: 'READY',
      },
    });
    await ctx.prisma.orderLine.create({
      data: {
        orderId: order.id,
        fulfillmentId: fulfillment.id,
        catalogProductId: product.id,
        productSnapshot: { name: 'Amoxicillin 500mg' },
        quantity: 2,
        unitPrice: 10_000,
        lineTotal: 20_000,
      },
    });
    return { fulfillmentId: fulfillment.id, orderId: order.id, branchId: branch.id };
  }

  /** A driver standing at the customer's door, ready to post `DELIVERED`. */
  async function delivered(options: { deliveryFee?: number } = {}): Promise<Scenario> {
    const driver = await seedDriver();
    const seed = await seedFulfillment(options);
    const { job } = await createJob.execute({ fulfillmentId: seed.fulfillmentId });
    await dispatch.execute({ jobId: job.id, actorUserId: null });
    await accept.execute({ userId: driver.userId, jobId: job.id });

    for (const to of [
      DeliveryJobStatus.ARRIVED_PICKUP,
      DeliveryJobStatus.PICKED_UP,
      DeliveryJobStatus.EN_ROUTE,
      DeliveryJobStatus.ARRIVED_DROPOFF,
      DeliveryJobStatus.DELIVERED,
    ]) {
      await advance.byDriver({ userId: driver.userId, jobId: job.id, to });
    }

    return {
      jobId: job.id,
      orderId: seed.orderId,
      fulfillmentId: seed.fulfillmentId,
      driver,
    };
  }

  /** Releases a driver so a second scenario's dispatch does not offer the job to the first. */
  async function retire(scenario: Scenario): Promise<void> {
    await shift.end({ userId: scenario.driver.userId });
  }

  function statusOf(jobId: string) {
    return ctx.prisma.deliveryJob
      .findUniqueOrThrow({ where: { id: jobId } })
      .then((job) => job.status);
  }

  /**
   * The `EarningAccrued` envelopes written for one job.
   *
   * `outbox.payload` holds the whole `DomainEvent`, so the business payload is one level in — the
   * same shape `delivery-job.e2e-spec.ts` writes when it drives the relay by hand.
   */
  function earningAccruedEvents(jobId: string) {
    return ctx.prisma.outbox
      .findMany({ where: { eventType: DeliveryEventType.EarningAccrued } })
      .then((rows) =>
        rows
          .map((row) => row.payload as unknown as { payload: Record<string, unknown> })
          .filter((envelope) => envelope.payload?.jobId === jobId),
      );
  }

  // -------------------------------------------------------------------------------------------
  // Accrual
  // -------------------------------------------------------------------------------------------

  it('accrues an earning for a delivered job, with every reference resolved', async () => {
    overrides.set(EARNING_BASE_CONFIG_KEY, 2_000).set(EARNING_PER_KM_CONFIG_KEY, 800);
    const scenario = await delivered();

    const { earning, created } = await accrue.execute({ jobId: scenario.jobId });

    expect(created).toBe(true);
    const row = await ctx.prisma.driverEarning.findUniqueOrThrow({ where: { id: earning.id } });
    expect(row).toMatchObject({
      jobId: scenario.jobId,
      orderId: scenario.orderId,
      fulfillmentId: scenario.fulfillmentId,
      driverId: scenario.driver.profileId,
      status: 'ACCRUED',
      currency: 'ETB',
      calculationVersion: 'v1',
    });
    expect(row.total).toBeGreaterThan(0);
  });

  it('computes from the job’s frozen distance and fee, not from anything re-derived', async () => {
    overrides
      .set(EARNING_PER_KM_CONFIG_KEY, 1_000)
      .set(EARNING_FEE_SHARE_PERCENT_CONFIG_KEY, 0.5);
    const scenario = await delivered({ deliveryFee: 6_000 });

    const { earning } = await accrue.execute({ jobId: scenario.jobId });

    const job = await ctx.prisma.deliveryJob.findUniqueOrThrow({ where: { id: scenario.jobId } });
    expect(earning.distanceMeters).toBe(job.distanceMeters);
    expect(earning.distanceComponent).toBe(
      Math.round((1_000 * (job.distanceMeters as number)) / 1000),
    );
    expect(earning.feeShare).toBe(3_000);
    expect(earning.total).toBe(earning.distanceComponent + 3_000);
  });

  it('accrues nothing under the agreement the platform actually ships', async () => {
    const scenario = await delivered({ deliveryFee: 9_999 });

    const { earning } = await accrue.execute({ jobId: scenario.jobId });

    // Zero, and specifically *not* the customer's delivery fee: who funds a driver is unresolved.
    expect(earning.total).toBe(0);
    expect(earning.feeShare).toBe(0);
  });

  it('applies the configured floor, cap and rounding step', async () => {
    overrides
      .set(EARNING_PER_KM_CONFIG_KEY, 1_000)
      .set(EARNING_MINIMUM_CONFIG_KEY, 9_000)
      .set(EARNING_MAXIMUM_CONFIG_KEY, 9_000)
      .set(EARNING_ROUND_TO_CONFIG_KEY, 100);
    const scenario = await delivered();

    expect((await accrue.execute({ jobId: scenario.jobId })).earning.total).toBe(9_000);
  });

  it('stamps the agreement version, so an old amount stays explainable', async () => {
    overrides.set(EARNING_VERSION_CONFIG_KEY, 'driver-terms-2026-q1');
    const scenario = await delivered();

    expect((await accrue.execute({ jobId: scenario.jobId })).earning.calculationVersion).toBe(
      'driver-terms-2026-q1',
    );
  });

  it('refuses a job that has not been delivered, writing nothing', async () => {
    const driver = await seedDriver();
    const seed = await seedFulfillment();
    const { job } = await createJob.execute({ fulfillmentId: seed.fulfillmentId });
    await dispatch.execute({ jobId: job.id, actorUserId: null });
    await accept.execute({ userId: driver.userId, jobId: job.id });

    await expect(accrue.execute({ jobId: job.id })).rejects.toMatchObject({
      code: ErrorCode.CONFLICT,
    });
    expect(await ctx.prisma.driverEarning.count()).toBe(0);
  });

  // -------------------------------------------------------------------------------------------
  // Idempotency and concurrency — the claims only PostgreSQL can settle
  // -------------------------------------------------------------------------------------------

  it('creates one earning however many times the completion is replayed', async () => {
    overrides.set(EARNING_BASE_CONFIG_KEY, 2_000);
    const scenario = await delivered();

    const first = await accrue.execute({ jobId: scenario.jobId });
    const second = await accrue.execute({ jobId: scenario.jobId });
    const third = await accrue.execute({ jobId: scenario.jobId });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(third.created).toBe(false);
    expect(second.earning.id).toBe(first.earning.id);
    expect(await ctx.prisma.driverEarning.count({ where: { jobId: scenario.jobId } })).toBe(1);
  });

  it('resolves concurrent accruals to exactly one earning', async () => {
    overrides.set(EARNING_BASE_CONFIG_KEY, 2_000);
    const scenario = await delivered();

    const results = await Promise.all([
      accrue.execute({ jobId: scenario.jobId }),
      accrue.execute({ jobId: scenario.jobId }),
      accrue.execute({ jobId: scenario.jobId }),
      accrue.execute({ jobId: scenario.jobId }),
    ]);

    expect(new Set(results.map((r) => r.earning.id)).size).toBe(1);
    expect(await ctx.prisma.driverEarning.count({ where: { jobId: scenario.jobId } })).toBe(1);
  });

  it('emits EarningAccrued exactly once, and one audit entry with it', async () => {
    const scenario = await delivered();

    await accrue.execute({ jobId: scenario.jobId });
    await accrue.execute({ jobId: scenario.jobId });

    expect(await earningAccruedEvents(scenario.jobId)).toHaveLength(1);
    expect(
      await ctx.prisma.auditLog.count({ where: { action: 'DELIVERY_EARNING_ACCRUED' } }),
    ).toBe(1);
  });

  it('does not recompute on a replay, so a rate change cannot rewrite a committed earning', async () => {
    overrides.set(EARNING_BASE_CONFIG_KEY, 2_000);
    const scenario = await delivered();
    const first = await accrue.execute({ jobId: scenario.jobId });

    overrides.set(EARNING_BASE_CONFIG_KEY, 9_000);
    const replay = await accrue.execute({ jobId: scenario.jobId });

    expect(replay.earning.total).toBe(2_000);
    const row = await ctx.prisma.driverEarning.findUniqueOrThrow({ where: { id: first.earning.id } });
    expect(row.total).toBe(2_000);
  });

  // -------------------------------------------------------------------------------------------
  // The DELIVERED → COMPLETED boundary
  // -------------------------------------------------------------------------------------------

  it('completes the delivery automatically once the earning is accrued', async () => {
    overrides.set(EARNING_BASE_CONFIG_KEY, 2_000);
    const scenario = await delivered();

    // `DeliveryCompletionHandler` subscribes to `OrderDelivered`, which reaches the in-process bus
    // through the outbox relay — so this is the full production path, driven explicitly rather
    // than waited on.
    await ctx.drainOutbox();

    expect(await statusOf(scenario.jobId)).toBe(DeliveryJobStatus.COMPLETED);
    expect(await ctx.prisma.driverEarning.count({ where: { jobId: scenario.jobId } })).toBe(1);
  });

  it('refuses to complete a delivery whose earning has not been accrued', async () => {
    // The agreement charges by distance; this job has none, so accrual refuses and the handler
    // leaves the job DELIVERED.
    overrides.set(EARNING_PER_KM_CONFIG_KEY, 500);
    const scenario = await delivered();
    await ctx.prisma.deliveryJob.update({
      where: { id: scenario.jobId },
      data: { status: 'DELIVERED', distanceMeters: null },
    });
    await ctx.prisma.driverEarning.deleteMany({ where: { jobId: scenario.jobId } });

    await expect(
      advance.bySystem({ jobId: scenario.jobId, to: DeliveryJobStatus.COMPLETED }),
    ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    expect(await statusOf(scenario.jobId)).toBe(DeliveryJobStatus.DELIVERED);
  });

  it('leaves a physically delivered order DELIVERED when accrual cannot run', async () => {
    overrides.set(EARNING_PER_KM_CONFIG_KEY, 500);
    const scenario = await delivered();
    await ctx.prisma.deliveryJob.update({
      where: { id: scenario.jobId },
      data: { status: 'DELIVERED', distanceMeters: null },
    });
    await ctx.prisma.driverEarning.deleteMany({ where: { jobId: scenario.jobId } });
    const historyBefore = await ctx.prisma.deliveryStatusHistory.count({
      where: { jobId: scenario.jobId },
    });

    await expect(accrue.execute({ jobId: scenario.jobId })).rejects.toMatchObject({
      code: ErrorCode.BUSINESS_RULE_VIOLATION,
    });

    const job = await ctx.prisma.deliveryJob.findUniqueOrThrow({ where: { id: scenario.jobId } });
    expect(job.status).toBe('DELIVERED');
    // The physical fact is intact: the delivery timestamp, the history and the driver all stand.
    expect(job.deliveredAt).not.toBeNull();
    expect(job.assignedDriverId).toBe(scenario.driver.profileId);
    expect(
      await ctx.prisma.deliveryStatusHistory.count({ where: { jobId: scenario.jobId } }),
    ).toBe(historyBefore);
  });

  it('completes on a later re-run, once the earning can be accrued', async () => {
    overrides.set(EARNING_PER_KM_CONFIG_KEY, 500);
    const scenario = await delivered();
    await ctx.prisma.deliveryJob.update({
      where: { id: scenario.jobId },
      data: { status: 'DELIVERED', distanceMeters: null },
    });
    await ctx.prisma.driverEarning.deleteMany({ where: { jobId: scenario.jobId } });
    await expect(accrue.execute({ jobId: scenario.jobId })).rejects.toBeDefined();

    // An operator drops the per-kilometre rate and re-runs.
    overrides.set(EARNING_PER_KM_CONFIG_KEY, 0).set(EARNING_BASE_CONFIG_KEY, 1_500);
    await accrue.execute({ jobId: scenario.jobId });
    await advance.bySystem({ jobId: scenario.jobId, to: DeliveryJobStatus.COMPLETED });

    expect(await statusOf(scenario.jobId)).toBe(DeliveryJobStatus.COMPLETED);
  });

  // -------------------------------------------------------------------------------------------
  // The Module 07 boundary
  // -------------------------------------------------------------------------------------------

  it('moves no money: no ledger entry, no wallet, no settlement', async () => {
    overrides.set(EARNING_BASE_CONFIG_KEY, 5_000);
    const scenario = await delivered();

    await accrue.execute({ jobId: scenario.jobId });

    expect(await ctx.prisma.ledgerEntry.count()).toBe(0);
    expect(await ctx.prisma.ledgerTransaction.count()).toBe(0);
    expect(await ctx.prisma.settlement.count()).toBe(0);
    expect(await ctx.prisma.payment.count()).toBe(0);
  });

  it('never marks an earning settled — that is Module 07’s transition', async () => {
    const scenario = await delivered();

    await accrue.execute({ jobId: scenario.jobId });

    const rows = await ctx.prisma.driverEarning.findMany({ where: { jobId: scenario.jobId } });
    expect(rows.every((row) => row.status === 'ACCRUED')).toBe(true);
  });

  it('hands off everything a settlement needs, and nothing about payout', async () => {
    overrides.set(EARNING_BASE_CONFIG_KEY, 2_500).set(EARNING_VERSION_CONFIG_KEY, 'terms-1');
    const scenario = await delivered();
    const { earning } = await accrue.execute({ jobId: scenario.jobId });

    const [event] = await earningAccruedEvents(scenario.jobId);
    expect(event.payload).toEqual({
      earningId: earning.id,
      driverId: scenario.driver.profileId,
      jobId: scenario.jobId,
      orderId: scenario.orderId,
      fulfillmentId: scenario.fulfillmentId,
      amount: 2_500,
      currency: 'ETB',
      calculationVersion: 'terms-1',
    });

    const serialized = JSON.stringify(event.payload).toLowerCase();
    for (const forbidden of ['bank', 'wallet', 'telebirr', 'payout', 'iban']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  // -------------------------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------------------------

  describe('GET /driver/earnings', () => {
    it('returns the driver’s own ledger with the page summary', async () => {
      overrides.set(EARNING_BASE_CONFIG_KEY, 2_000);
      const scenario = await delivered();
      await accrue.execute({ jobId: scenario.jobId });

      const res = await request(ctx.server)
        .get('/driver/earnings')
        .set(...auth(scenario.driver.accessToken));

      expect(res.status).toBe(200);
      const payload = body(res);
      expect(payload.total).toBe(1);
      expect(payload.pageTotal).toBe(2_000);
      expect(payload.currency).toBe('ETB');
      expect((payload.items as Array<Record<string, unknown>>)[0]).toMatchObject({
        jobId: scenario.jobId,
        orderId: scenario.orderId,
        status: 'ACCRUED',
        calculationVersion: 'v1',
      });
    });

    it('never shows one driver another driver’s earnings', async () => {
      overrides.set(EARNING_BASE_CONFIG_KEY, 2_000);
      const earner = await delivered();
      await accrue.execute({ jobId: earner.jobId });
      await retire(earner);
      const stranger = await seedDriver();

      const payload = body(
        await request(ctx.server)
          .get('/driver/earnings')
          .set(...auth(stranger.accessToken))
          .expect(200),
      );

      expect(payload.items).toEqual([]);
      expect(payload.total).toBe(0);
    });

    it('refuses an anonymous caller', async () => {
      expect((await request(ctx.server).get('/driver/earnings')).status).toBe(401);
    });

    it('refuses a customer, who holds no delivery:read:own', async () => {
      const customer = await createUserWithRole(ctx, 'CUSTOMER');

      const res = await request(ctx.server)
        .get('/driver/earnings')
        .set(...auth(customer.accessToken));

      expect(res.status).toBe(403);
    });

    it('rejects a paging parameter outside its bounds', async () => {
      const scenario = await delivered();

      const res = await request(ctx.server)
        .get('/driver/earnings')
        .query({ limit: 5_000 })
        .set(...auth(scenario.driver.accessToken));

      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe(ErrorCode.VALIDATION_ERROR);
    });

    it('rejects an unexpected query parameter rather than ignoring it', async () => {
      const scenario = await delivered();

      const res = await request(ctx.server)
        .get('/driver/earnings')
        .query({ driverId: 'somebody-else' })
        .set(...auth(scenario.driver.accessToken));

      expect(res.status).toBe(400);
    });
  });

  describe('GET /delivery/jobs/:id/earning', () => {
    it('returns the earning for the driver’s own delivery', async () => {
      overrides.set(EARNING_BASE_CONFIG_KEY, 2_000);
      const scenario = await delivered();
      await accrue.execute({ jobId: scenario.jobId });

      const payload = body(
        await request(ctx.server)
          .get(`/delivery/jobs/${scenario.jobId}/earning`)
          .set(...auth(scenario.driver.accessToken))
          .expect(200),
      );

      expect(payload).toMatchObject({
        jobId: scenario.jobId,
        total: 2_000,
        currency: 'ETB',
        status: 'ACCRUED',
      });
    });

    it('answers 404 for another driver’s delivery — never 403', async () => {
      const earner = await delivered();
      await accrue.execute({ jobId: earner.jobId });
      await retire(earner);
      const stranger = await seedDriver();

      const res = await request(ctx.server)
        .get(`/delivery/jobs/${earner.jobId}/earning`)
        .set(...auth(stranger.accessToken));

      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe(ErrorCode.NOT_FOUND);
    });

    it('answers 404 identically for a job that does not exist', async () => {
      const scenario = await delivered();

      const res = await request(ctx.server)
        .get(`/delivery/jobs/${randomUUID()}/earning`)
        .set(...auth(scenario.driver.accessToken));

      expect(res.status).toBe(404);
    });
  });

  describe('immutability over HTTP', () => {
    /**
     * §12 and §14 together. An accrued earning is the platform's record of money owed to a person,
     * and there is deliberately no verb anywhere that could change it — not the amount, not the
     * status, not by deletion.
     */
    it('exposes no route that can alter an earning', async () => {
      overrides.set(EARNING_BASE_CONFIG_KEY, 2_000);
      const scenario = await delivered();
      await accrue.execute({ jobId: scenario.jobId });
      const before = await ctx.prisma.driverEarning.findFirstOrThrow({
        where: { jobId: scenario.jobId },
      });
      const token = scenario.driver.accessToken;

      // Built inline and awaited one at a time: supertest closes the ephemeral server it opens
      // once a request completes, so pre-built requests against one server would refuse.
      const attempts = [
        await request(ctx.server)
          .patch(`/delivery/jobs/${scenario.jobId}/earning`)
          .set(...auth(token))
          .send({ total: 999_999 }),
        await request(ctx.server)
          .put(`/delivery/jobs/${scenario.jobId}/earning`)
          .set(...auth(token))
          .send({ total: 999_999 }),
        await request(ctx.server)
          .post(`/delivery/jobs/${scenario.jobId}/earning`)
          .set(...auth(token))
          .send({ total: 999_999 }),
        await request(ctx.server)
          .delete(`/delivery/jobs/${scenario.jobId}/earning`)
          .set(...auth(token)),
        await request(ctx.server)
          .post('/driver/earnings')
          .set(...auth(token))
          .send({ total: 999_999 }),
      ];

      for (const res of attempts) {
        expect(res.status).toBeGreaterThanOrEqual(400);
      }

      const after = await ctx.prisma.driverEarning.findUniqueOrThrow({ where: { id: before.id } });
      expect(after).toEqual(before);
    });
  });
});
