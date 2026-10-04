import request from 'supertest';
import { randomUUID } from 'crypto';
import { AcceptJobOfferCommand } from '../../src/modules/delivery/application/commands/accept-job-offer.command';
import { AccrueDriverEarningCommand } from '../../src/modules/delivery/application/commands/accrue-driver-earning.command';
import { AdvanceDeliveryJobCommand } from '../../src/modules/delivery/application/commands/advance-delivery-job.command';
import { CreateDeliveryJobCommand } from '../../src/modules/delivery/application/commands/create-delivery-job.command';
import { CreateDriverProfileCommand } from '../../src/modules/delivery/application/commands/create-driver-profile.command';
import { DispatchDeliveryJobCommand } from '../../src/modules/delivery/application/commands/dispatch-delivery-job.command';
import { ManageDriverShiftCommand } from '../../src/modules/delivery/application/commands/manage-driver-shift.command';
import { RecordCodCollectionCommand } from '../../src/modules/delivery/application/commands/record-cod-collection.command';
import { SetDriverAvailabilityCommand } from '../../src/modules/delivery/application/commands/set-driver-availability.command';
import {
  COD_REQUIRE_COLLECTION_FOR_COMPLETION_CONFIG_KEY,
  COD_REQUIRE_EXACT_AMOUNT_CONFIG_KEY,
} from '../../src/modules/delivery/application/services/cod-settings';
import {
  CodCollectionMethod,
  DeliveryJobStatus,
  DriverAvailability,
} from '../../src/modules/delivery/domain/enums';
import { DeliveryEventType } from '../../src/modules/delivery/domain/events';
import { VehicleType } from '../../src/modules/delivery/domain/value-objects/vehicle.vo';
import { AppConfigService } from '../../src/shared/config/app-config.service';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { auth, body, createUserWithRole, errorOf, uniquePhone } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

const COD_AMOUNT = 24_500;

/**
 * COD collection recording against real PostgreSQL (§3.5 F-COD-01, BR-DEL-10).
 *
 * Real `AppModule`, real routes, real guards, the real RBAC catalogue, the real Prisma repository,
 * real `Serializable` transactions, the real hash-chained audit trail and the real outbox.
 *
 * The claims that can only be made here:
 *
 *  1. **Idempotency is the database's.** `cod_collections.jobId` carries a unique index, so a
 *     handset retrying at a doorstep is settled by Postgres rather than by anything in memory —
 *     which is what makes it still work with two API nodes behind a load balancer.
 *  2. **Concurrent submissions converge on one collection**, and on one `CodCollected` event.
 *     Telling Module 07 twice that it is owed the same cash is the failure this prevents.
 *  3. **Module 07 is untouched.** No ledger entry, no payment, no wallet, no settlement — checked
 *     against the real Module 07 tables rather than asserted in prose.
 *  4. **The expected amount is the order's**, read back out of Postgres, and no request can move it.
 *  5. **No route can reconcile anything**, and the recorded row stays `COLLECTED` with its
 *     remittance and reconciliation columns null.
 */
describe('COD collection (e2e)', () => {
  let ctx: TestContext;
  let createJob: CreateDeliveryJobCommand;
  let dispatch: DispatchDeliveryJobCommand;
  let accept: AcceptJobOfferCommand;
  let advance: AdvanceDeliveryJobCommand;
  let accrue: AccrueDriverEarningCommand;
  let recordCod: RecordCodCollectionCommand;
  let createProfile: CreateDriverProfileCommand;
  let shift: ManageDriverShiftCommand;
  let availability: SetDriverAvailabilityCommand;
  let config: AppConfigService;

  /**
   * COD rules overridden for one test, on the real config port.
   *
   * Both `delivery.cod*` keys ship `false` and the environment this suite boots sets neither, so
   * the operator-enabled paths would otherwise be untestable without a second application. The
   * override goes through `AppConfigService.get` — the same call `resolveCodSettings` makes — so
   * what runs is the production lookup with a different answer, never a different code path.
   */
  const overrides = new Map<string, unknown>();

  beforeAll(async () => {
    ctx = await createTestApp();
    createJob = ctx.app.get(CreateDeliveryJobCommand);
    dispatch = ctx.app.get(DispatchDeliveryJobCommand);
    accept = ctx.app.get(AcceptJobOfferCommand);
    advance = ctx.app.get(AdvanceDeliveryJobCommand);
    accrue = ctx.app.get(AccrueDriverEarningCommand);
    recordCod = ctx.app.get(RecordCodCollectionCommand);
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

  async function seedFulfillment(options: { isCod?: boolean; grandTotal?: number } = {}) {
    const isCod = options.isCod ?? true;
    const grandTotal = options.grandTotal ?? COD_AMOUNT;
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
    const order = await ctx.prisma.order.create({
      data: {
        orderNumber: `ORD-${randomUUID()}`,
        customerUserId: randomUUID(),
        status: 'PAID',
        subtotal: grandTotal,
        grandTotal,
        currency: 'ETB',
        isCod,
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
        quantity: 1,
        unitPrice: grandTotal,
        lineTotal: grandTotal,
      },
    });
    return { fulfillmentId: fulfillment.id, orderId: order.id };
  }

  /** A driver at the customer's door, ready to take the money. */
  async function atTheDoor(
    options: { isCod?: boolean; grandTotal?: number } = {},
  ): Promise<Scenario> {
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

  function submit(scenario: Scenario, payload: Record<string, unknown>) {
    return request(ctx.server)
      .post(`/delivery/jobs/${scenario.jobId}/cod-collection`)
      .set(...auth(scenario.driver.accessToken))
      .send(payload);
  }

  function readCod(scenario: Scenario, token = scenario.driver.accessToken) {
    return request(ctx.server)
      .get(`/delivery/jobs/${scenario.jobId}/cod-collection`)
      .set(...auth(token));
  }

  function codEvents(jobId: string) {
    return ctx.prisma.outbox
      .findMany({ where: { eventType: DeliveryEventType.CodCollected } })
      .then((rows) =>
        rows
          .map((row) => row.payload as unknown as { payload: Record<string, unknown> })
          .filter((envelope) => envelope.payload?.jobId === jobId),
      );
  }

  // -------------------------------------------------------------------------------------------
  // Recording
  // -------------------------------------------------------------------------------------------

  it('records an exact cash collection against the order’s own total', async () => {
    const scenario = await atTheDoor();

    const res = await submit(scenario, {
      collectedAmount: COD_AMOUNT,
      method: CodCollectionMethod.CASH,
    });

    expect(res.status).toBe(201);
    const row = await ctx.prisma.codCollection.findUniqueOrThrow({
      where: { jobId: scenario.jobId },
    });
    expect(row).toMatchObject({
      orderId: scenario.orderId,
      fulfillmentId: scenario.fulfillmentId,
      driverId: scenario.driver.profileId,
      expectedAmount: COD_AMOUNT,
      collectedAmount: COD_AMOUNT,
      currency: 'ETB',
      method: 'CASH',
      status: 'COLLECTED',
      providerReference: null,
    });
  });

  it('takes the expected amount from the delivery job, whatever the client sends', async () => {
    const scenario = await atTheDoor({ grandTotal: 31_000 });

    const res = await submit(scenario, {
      collectedAmount: 31_000,
      method: CodCollectionMethod.CASH,
      expectedAmount: 1,
    });

    // `forbidNonWhitelisted` refuses the field outright rather than ignoring it.
    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe(ErrorCode.VALIDATION_ERROR);

    const accepted = await submit(scenario, {
      collectedAmount: 31_000,
      method: CodCollectionMethod.CASH,
    });
    expect(body(accepted).expectedAmount).toBe(31_000);
  });

  it('refuses a collection for a delivery that is not cash on delivery', async () => {
    const scenario = await atTheDoor({ isCod: false });

    const res = await submit(scenario, {
      collectedAmount: COD_AMOUNT,
      method: CodCollectionMethod.CASH,
    });

    expect(res.status).toBe(409);
    expect(await ctx.prisma.codCollection.count()).toBe(0);
  });

  it('refuses a collection before the driver has reached the door', async () => {
    const driver = await seedDriver();
    const seed = await seedFulfillment();
    const { job } = await createJob.execute({ fulfillmentId: seed.fulfillmentId });
    await dispatch.execute({ jobId: job.id, actorUserId: null });
    await accept.execute({ userId: driver.userId, jobId: job.id });
    await advance.byDriver({
      userId: driver.userId,
      jobId: job.id,
      to: DeliveryJobStatus.ARRIVED_PICKUP,
    });

    const res = await request(ctx.server)
      .post(`/delivery/jobs/${job.id}/cod-collection`)
      .set(...auth(driver.accessToken))
      .send({ collectedAmount: COD_AMOUNT, method: CodCollectionMethod.CASH });

    expect(res.status).toBe(409);
    expect(await ctx.prisma.codCollection.count()).toBe(0);
  });

  it('refuses a collection once the delivery has been posted', async () => {
    const scenario = await atTheDoor();
    await advance.byDriver({
      userId: scenario.driver.userId,
      jobId: scenario.jobId,
      to: DeliveryJobStatus.DELIVERED,
    });

    const res = await submit(scenario, {
      collectedAmount: COD_AMOUNT,
      method: CodCollectionMethod.CASH,
    });

    expect(res.status).toBe(409);
  });

  // -------------------------------------------------------------------------------------------
  // Amounts
  // -------------------------------------------------------------------------------------------

  it('records an underpayment with the shortfall visible, and refuses to call it reconcilable', async () => {
    const scenario = await atTheDoor();

    const payload = body(
      await submit(scenario, {
        collectedAmount: COD_AMOUNT - 500,
        method: CodCollectionMethod.CASH,
      }).expect(201),
    );

    expect(payload).toMatchObject({
      expectedAmount: COD_AMOUNT,
      collectedAmount: COD_AMOUNT - 500,
      variance: -500,
      hasDiscrepancy: true,
      isReconcilable: false,
      status: 'COLLECTED',
    });
  });

  it('records an overpayment the same way', async () => {
    const scenario = await atTheDoor();

    const payload = body(
      await submit(scenario, {
        collectedAmount: COD_AMOUNT + 250,
        method: CodCollectionMethod.CASH,
      }).expect(201),
    );

    expect(payload.variance).toBe(250);
    expect(payload.isReconcilable).toBe(false);
  });

  it('refuses a discrepancy outright when the operator requires exact payment', async () => {
    overrides.set(COD_REQUIRE_EXACT_AMOUNT_CONFIG_KEY, true);
    const scenario = await atTheDoor();

    const res = await submit(scenario, {
      collectedAmount: COD_AMOUNT - 500,
      method: CodCollectionMethod.CASH,
    });

    expect(res.status).toBe(422);
    expect(errorOf(res).code).toBe(ErrorCode.BUSINESS_RULE_VIOLATION);
    expect(await ctx.prisma.codCollection.count()).toBe(0);
    expect(await codEvents(scenario.jobId)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------------------------
  // Methods
  // -------------------------------------------------------------------------------------------

  it('records an electronic collection with its opaque reference', async () => {
    const scenario = await atTheDoor();

    const payload = body(
      await submit(scenario, {
        collectedAmount: COD_AMOUNT,
        method: CodCollectionMethod.ELECTRONIC,
        providerReference: 'TXN-99881',
      }).expect(201),
    );

    expect(payload.method).toBe('ELECTRONIC');
    expect(payload.providerReference).toBe('TXN-99881');
    // Just as unverified as cash: nothing in this module talks to a provider.
    expect(payload.status).toBe('COLLECTED');
  });

  it('refuses a provider reference on a cash collection', async () => {
    const scenario = await atTheDoor();

    const res = await submit(scenario, {
      collectedAmount: COD_AMOUNT,
      method: CodCollectionMethod.CASH,
      providerReference: 'TXN-1',
    });

    expect(res.status).toBe(400);
  });

  it('refuses a provider-specific method', async () => {
    const scenario = await atTheDoor();

    const res = await submit(scenario, { collectedAmount: COD_AMOUNT, method: 'TELEBIRR' });

    expect(res.status).toBe(400);
  });

  it('stores no provider payload, callback or secret anywhere on the row', async () => {
    const scenario = await atTheDoor();
    await submit(scenario, {
      collectedAmount: COD_AMOUNT,
      method: CodCollectionMethod.ELECTRONIC,
      providerReference: 'TXN-99881',
    }).expect(201);

    const row = await ctx.prisma.codCollection.findUniqueOrThrow({
      where: { jobId: scenario.jobId },
    });
    const serialized = JSON.stringify(row).toLowerCase();
    for (const forbidden of ['pan', 'cvv', 'secret', 'callback', 'signature', 'payload']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  // -------------------------------------------------------------------------------------------
  // Idempotency and concurrency
  // -------------------------------------------------------------------------------------------

  it('creates one collection however many times the handset retries', async () => {
    const scenario = await atTheDoor();
    const payload = { collectedAmount: COD_AMOUNT, method: CodCollectionMethod.CASH };

    const first = body(await submit(scenario, payload).expect(201));
    const second = body(await submit(scenario, payload).expect(201));

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    expect(await ctx.prisma.codCollection.count({ where: { jobId: scenario.jobId } })).toBe(1);
  });

  it('emits CodCollected exactly once, with one audit entry', async () => {
    const scenario = await atTheDoor();
    const payload = { collectedAmount: COD_AMOUNT, method: CodCollectionMethod.CASH };

    await submit(scenario, payload).expect(201);
    await submit(scenario, payload).expect(201);

    expect(await codEvents(scenario.jobId)).toHaveLength(1);
    expect(
      await ctx.prisma.auditLog.count({ where: { action: 'DELIVERY_COD_COLLECTED' } }),
    ).toBe(1);
  });

  it('refuses a resubmission that restates the amount, leaving the record intact', async () => {
    const scenario = await atTheDoor();
    await submit(scenario, {
      collectedAmount: COD_AMOUNT,
      method: CodCollectionMethod.CASH,
    }).expect(201);

    const res = await submit(scenario, {
      collectedAmount: COD_AMOUNT - 1_000,
      method: CodCollectionMethod.CASH,
    });

    expect(res.status).toBe(409);
    const row = await ctx.prisma.codCollection.findUniqueOrThrow({
      where: { jobId: scenario.jobId },
    });
    expect(row.collectedAmount).toBe(COD_AMOUNT);
  });

  it('resolves concurrent submissions to exactly one collection and one event', async () => {
    const scenario = await atTheDoor();

    const results = await Promise.all([
      recordCod.execute({
        userId: scenario.driver.userId,
        jobId: scenario.jobId,
        collectedAmount: COD_AMOUNT,
        method: CodCollectionMethod.CASH,
      }),
      recordCod.execute({
        userId: scenario.driver.userId,
        jobId: scenario.jobId,
        collectedAmount: COD_AMOUNT,
        method: CodCollectionMethod.CASH,
      }),
      recordCod.execute({
        userId: scenario.driver.userId,
        jobId: scenario.jobId,
        collectedAmount: COD_AMOUNT,
        method: CodCollectionMethod.CASH,
      }),
    ]);

    expect(new Set(results.map((r) => r.collection.id)).size).toBe(1);
    expect(await ctx.prisma.codCollection.count({ where: { jobId: scenario.jobId } })).toBe(1);
    expect(await codEvents(scenario.jobId)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------------------------
  // The Module 07 boundary
  // -------------------------------------------------------------------------------------------

  it('moves no money: no ledger entry, no payment, no wallet, no settlement', async () => {
    const scenario = await atTheDoor();

    await submit(scenario, {
      collectedAmount: COD_AMOUNT,
      method: CodCollectionMethod.CASH,
    }).expect(201);

    expect(await ctx.prisma.ledgerEntry.count()).toBe(0);
    expect(await ctx.prisma.ledgerTransaction.count()).toBe(0);
    expect(await ctx.prisma.payment.count()).toBe(0);
    expect(await ctx.prisma.settlement.count()).toBe(0);
  });

  it('leaves the collection unremitted and unreconciled — a driver declaration, nothing more', async () => {
    const scenario = await atTheDoor();
    await submit(scenario, {
      collectedAmount: COD_AMOUNT,
      method: CodCollectionMethod.CASH,
    }).expect(201);

    const row = await ctx.prisma.codCollection.findUniqueOrThrow({
      where: { jobId: scenario.jobId },
    });
    expect(row.status).toBe('COLLECTED');
    expect(row.remittedAt).toBeNull();
    expect(row.reconciledAt).toBeNull();
    expect(row.settlementRef).toBeNull();
  });

  it('hands off both amounts, and nothing sensitive', async () => {
    const scenario = await atTheDoor();
    const created = body(
      await submit(scenario, {
        collectedAmount: COD_AMOUNT - 500,
        method: CodCollectionMethod.ELECTRONIC,
        providerReference: 'TXN-42',
      }).expect(201),
    );

    const [event] = await codEvents(scenario.jobId);
    expect(event.payload).toMatchObject({
      collectionId: created.id,
      jobId: scenario.jobId,
      orderId: scenario.orderId,
      fulfillmentId: scenario.fulfillmentId,
      driverId: scenario.driver.profileId,
      expectedAmount: COD_AMOUNT,
      collectedAmount: COD_AMOUNT - 500,
      currency: 'ETB',
      method: 'ELECTRONIC',
      providerReference: 'TXN-42',
    });

    const serialized = JSON.stringify(event.payload).toLowerCase();
    for (const forbidden of ['pan', 'cvv', 'secret', 'callback', 'signature', 'telebirr']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('does not touch the order — a collection is not a pharmacy settlement', async () => {
    const scenario = await atTheDoor();
    const before = await ctx.prisma.order.findUniqueOrThrow({ where: { id: scenario.orderId } });

    await submit(scenario, {
      collectedAmount: COD_AMOUNT,
      method: CodCollectionMethod.CASH,
    }).expect(201);

    const after = await ctx.prisma.order.findUniqueOrThrow({ where: { id: scenario.orderId } });
    expect(after).toEqual(before);
  });

  // -------------------------------------------------------------------------------------------
  // The delivery workflow
  // -------------------------------------------------------------------------------------------

  it('changes no delivery status of its own', async () => {
    const scenario = await atTheDoor();
    const historyBefore = await ctx.prisma.deliveryStatusHistory.count({
      where: { jobId: scenario.jobId },
    });

    await submit(scenario, {
      collectedAmount: COD_AMOUNT,
      method: CodCollectionMethod.CASH,
    }).expect(201);

    const job = await ctx.prisma.deliveryJob.findUniqueOrThrow({ where: { id: scenario.jobId } });
    expect(job.status).toBe('ARRIVED_DROPOFF');
    expect(
      await ctx.prisma.deliveryStatusHistory.count({ where: { jobId: scenario.jobId } }),
    ).toBe(historyBefore);
  });

  it('supports the expected sequence: arrive, collect, deliver', async () => {
    const scenario = await atTheDoor();

    await submit(scenario, {
      collectedAmount: COD_AMOUNT,
      method: CodCollectionMethod.CASH,
    }).expect(201);
    await advance.byDriver({
      userId: scenario.driver.userId,
      jobId: scenario.jobId,
      to: DeliveryJobStatus.DELIVERED,
    });

    const job = await ctx.prisma.deliveryJob.findUniqueOrThrow({ where: { id: scenario.jobId } });
    expect(job.deliveredAt).not.toBeNull();
  });

  /** §16: a physical handover must never be blocked by a money rule. */
  it('never blocks DELIVERED on COD, even with the completion rule switched on', async () => {
    overrides.set(COD_REQUIRE_COLLECTION_FOR_COMPLETION_CONFIG_KEY, true);
    const scenario = await atTheDoor();

    const result = await advance.byDriver({
      userId: scenario.driver.userId,
      jobId: scenario.jobId,
      to: DeliveryJobStatus.DELIVERED,
    });

    expect(result.changed).toBe(true);
    expect(await ctx.prisma.codCollection.count()).toBe(0);
  });

  it('refuses COMPLETED without a collection when the rule is switched on', async () => {
    overrides.set(COD_REQUIRE_COLLECTION_FOR_COMPLETION_CONFIG_KEY, true);
    const scenario = await atTheDoor();
    await advance.byDriver({
      userId: scenario.driver.userId,
      jobId: scenario.jobId,
      to: DeliveryJobStatus.DELIVERED,
    });
    await accrue.execute({ jobId: scenario.jobId });

    await expect(
      advance.bySystem({ jobId: scenario.jobId, to: DeliveryJobStatus.COMPLETED }),
    ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });

    const job = await ctx.prisma.deliveryJob.findUniqueOrThrow({ where: { id: scenario.jobId } });
    expect(job.status).toBe('DELIVERED');
    expect(job.deliveredAt).not.toBeNull();
  });

  it('completes once the collection exists', async () => {
    overrides.set(COD_REQUIRE_COLLECTION_FOR_COMPLETION_CONFIG_KEY, true);
    const scenario = await atTheDoor();
    await submit(scenario, {
      collectedAmount: COD_AMOUNT,
      method: CodCollectionMethod.CASH,
    }).expect(201);
    await advance.byDriver({
      userId: scenario.driver.userId,
      jobId: scenario.jobId,
      to: DeliveryJobStatus.DELIVERED,
    });
    await accrue.execute({ jobId: scenario.jobId });

    const result = await advance.bySystem({
      jobId: scenario.jobId,
      to: DeliveryJobStatus.COMPLETED,
    });

    expect(result.job.status).toBe(DeliveryJobStatus.COMPLETED);
  });

  it('completes without a collection under the shipped default', async () => {
    const scenario = await atTheDoor();
    await advance.byDriver({
      userId: scenario.driver.userId,
      jobId: scenario.jobId,
      to: DeliveryJobStatus.DELIVERED,
    });
    await accrue.execute({ jobId: scenario.jobId });

    const result = await advance.bySystem({
      jobId: scenario.jobId,
      to: DeliveryJobStatus.COMPLETED,
    });

    expect(result.job.status).toBe(DeliveryJobStatus.COMPLETED);
  });

  // -------------------------------------------------------------------------------------------
  // HTTP authorization and the read
  // -------------------------------------------------------------------------------------------

  it('refuses an anonymous submission', async () => {
    const scenario = await atTheDoor();

    const res = await request(ctx.server)
      .post(`/delivery/jobs/${scenario.jobId}/cod-collection`)
      .send({ collectedAmount: COD_AMOUNT, method: CodCollectionMethod.CASH });

    expect(res.status).toBe(401);
  });

  it('refuses a customer, who holds no delivery:update:own', async () => {
    const scenario = await atTheDoor();
    const customer = await createUserWithRole(ctx, 'CUSTOMER');

    const res = await request(ctx.server)
      .post(`/delivery/jobs/${scenario.jobId}/cod-collection`)
      .set(...auth(customer.accessToken))
      .send({ collectedAmount: COD_AMOUNT, method: CodCollectionMethod.CASH });

    expect(res.status).toBe(403);
  });

  it('answers 404 when another driver submits for a delivery that is not theirs', async () => {
    const scenario = await atTheDoor();
    await retire(scenario);
    const stranger = await seedDriver();

    const res = await request(ctx.server)
      .post(`/delivery/jobs/${scenario.jobId}/cod-collection`)
      .set(...auth(stranger.accessToken))
      .send({ collectedAmount: COD_AMOUNT, method: CodCollectionMethod.CASH });

    expect(res.status).toBe(404);
    expect(errorOf(res).code).toBe(ErrorCode.NOT_FOUND);
  });

  it('returns the recorded collection to its own driver', async () => {
    const scenario = await atTheDoor();
    await submit(scenario, {
      collectedAmount: COD_AMOUNT,
      method: CodCollectionMethod.CASH,
    }).expect(201);

    const payload = body(await readCod(scenario).expect(200));

    expect(payload).toMatchObject({
      jobId: scenario.jobId,
      expectedAmount: COD_AMOUNT,
      collectedAmount: COD_AMOUNT,
      variance: 0,
      hasDiscrepancy: false,
      isReconcilable: true,
      status: 'COLLECTED',
    });
  });

  it('answers 404 on the read for another driver’s delivery', async () => {
    const scenario = await atTheDoor();
    await submit(scenario, {
      collectedAmount: COD_AMOUNT,
      method: CodCollectionMethod.CASH,
    }).expect(201);
    await retire(scenario);
    const stranger = await seedDriver();

    expect((await readCod(scenario, stranger.accessToken)).status).toBe(404);
  });

  it('answers 404 identically for a delivery with nothing recorded', async () => {
    const scenario = await atTheDoor();

    expect((await readCod(scenario)).status).toBe(404);
  });

  /** §17: no endpoint may reconcile, remit, or restate a collection. */
  it('exposes no route that can remit, reconcile or alter a collection', async () => {
    const scenario = await atTheDoor();
    await submit(scenario, {
      collectedAmount: COD_AMOUNT,
      method: CodCollectionMethod.CASH,
    }).expect(201);
    const before = await ctx.prisma.codCollection.findUniqueOrThrow({
      where: { jobId: scenario.jobId },
    });
    const token = scenario.driver.accessToken;
    const base = `/delivery/jobs/${scenario.jobId}/cod-collection`;

    // Built inline and awaited one at a time: supertest closes the ephemeral server it opens once
    // a request completes, so pre-built requests against one server would refuse.
    const attempts = [
      await request(ctx.server).patch(base).set(...auth(token)).send({ collectedAmount: 1 }),
      await request(ctx.server).put(base).set(...auth(token)).send({ collectedAmount: 1 }),
      await request(ctx.server).delete(base).set(...auth(token)),
      await request(ctx.server)
        .post(`${base}/reconcile`)
        .set(...auth(token))
        .send({}),
      await request(ctx.server)
        .post(`${base}/remit`)
        .set(...auth(token))
        .send({}),
    ];

    for (const res of attempts) {
      expect(res.status).toBeGreaterThanOrEqual(400);
    }

    const after = await ctx.prisma.codCollection.findUniqueOrThrow({ where: { id: before.id } });
    expect(after).toEqual(before);
  });
});
