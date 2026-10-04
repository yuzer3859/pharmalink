import { randomUUID } from 'crypto';
import { CreateDeliveryJobCommand } from '../../src/modules/delivery/application/commands/create-delivery-job.command';
import { DeliveryJob } from '../../src/modules/delivery/domain/entities/delivery-job.entity';
import { DeliveryJobStatus } from '../../src/modules/delivery/domain/enums';
import {
  DELIVERY_JOB_REPOSITORY,
  IDeliveryJobRepository,
} from '../../src/modules/delivery/domain/repositories/delivery-job.repository';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { uniquePhone } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

/**
 * Delivery job creation against real PostgreSQL (§3.2 F-JOB-01, BR-DEL-01, BRULE-27).
 *
 * Real `AppModule`, real `CreateDeliveryJobCommand`, real cross-module read adapters over Modules
 * 03/04/06, the real Prisma repository, real `Serializable` transactions, the real outbox and the
 * real audit trail. The Module 06/04/03 rows are seeded directly, because Module 08 reads them and
 * does not create them — and because Slice-1 checkout is COD-only, so driving a fulfillment all
 * the way to `READY` through HTTP would exercise Module 06 rather than this work.
 *
 * The claim under test is that **a fulfillment has exactly one delivery job, whatever happens** —
 * a redelivered `order.ready` event, a retry, or three concurrent creators. Two drivers sent to
 * the same pharmacy for the same medicines is the failure this whole design exists to prevent.
 */
describe('Delivery job creation (e2e)', () => {
  let ctx: TestContext;
  let create: CreateDeliveryJobCommand;
  let jobs: IDeliveryJobRepository;

  beforeAll(async () => {
    ctx = await createTestApp();
    create = ctx.app.get(CreateDeliveryJobCommand);
    jobs = ctx.app.get<IDeliveryJobRepository>(DELIVERY_JOB_REPOSITORY);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  // -------------------------------------------------------------------------------------------
  // Fixtures — the Module 03/04/06 rows Module 08 reads.
  // -------------------------------------------------------------------------------------------

  interface SeedOptions {
    status?: string;
    isCod?: boolean;
    grandTotal?: number;
    coldChain?: boolean;
    withAddress?: boolean;
    withBranch?: boolean;
  }

  async function seedReadyFulfillment(options: SeedOptions = {}) {
    const status = options.status ?? 'READY';
    const grandTotal = options.grandTotal ?? 24_500;

    // `organizations.ownerUserId` is a real FK within Module 01, so the owner has to exist. A
    // direct row rather than the full register/verify/login flow: nothing here exercises identity,
    // and this fixture runs once per test.
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
        subcity: 'Bole',
        city: 'Addis Ababa',
        lat: 9.03,
        lng: 38.74,
        ...(options.withBranch === false ? { deletedAt: new Date() } : {}),
      },
    });

    const product = await ctx.prisma.product.create({
      data: {
        type: 'MEDICINE',
        nameEn: 'Insulin Glargine',
        genericName: 'Insulin Glargine',
        storageRequirement: options.coldChain ? 'COLD_CHAIN' : 'AMBIENT',
      },
    });

    const order = await ctx.prisma.order.create({
      data: {
        orderNumber: `ORD-${randomUUID()}`,
        customerUserId: randomUUID(),
        status: 'PAID',
        subtotal: grandTotal,
        grandTotal,
        currency: 'ETB',
        isCod: options.isCod ?? false,
        idempotencyKey: `checkout-${randomUUID()}`,
        addressSnapshot:
          options.withAddress === false
            ? undefined
            : { line1: 'Kazanchis, Bldg 4', city: 'Addis Ababa', lat: 8.98, lng: 38.79 },
      },
    });
    const fulfillment = await ctx.prisma.fulfillment.create({
      data: {
        orderId: order.id,
        pharmacyId: pharmacy.id,
        branchId: branch.id,
        status: status as never,
      },
    });
    await ctx.prisma.orderLine.create({
      data: {
        orderId: order.id,
        fulfillmentId: fulfillment.id,
        catalogProductId: product.id,
        productSnapshot: { name: 'Insulin Glargine' },
        quantity: 2,
        unitPrice: grandTotal / 2,
        lineTotal: grandTotal,
      },
    });

    return {
      fulfillmentId: fulfillment.id,
      orderId: order.id,
      pharmacyId: pharmacy.id,
      branchId: branch.id,
      productId: product.id,
    };
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
  // Creation
  // -------------------------------------------------------------------------------------------

  it('creates a job from a READY fulfillment, with every snapshot resolved', async () => {
    const seed = await seedReadyFulfillment();

    const result = await create.execute({ fulfillmentId: seed.fulfillmentId });

    expect(result.replay).toBe(false);
    expect(result.job).toMatchObject({
      orderId: seed.orderId,
      fulfillmentId: seed.fulfillmentId,
      pharmacyId: seed.pharmacyId,
      branchId: seed.branchId,
      status: DeliveryJobStatus.CREATED,
      assignedDriverId: null,
      isColdChain: false,
      isCod: false,
      codAmount: null,
    });
    expect(result.job.pickupPoint).toMatchObject({ lat: 9.03, lng: 38.74 });
    expect(result.job.pickupAddress).toBe('Bole Branch, Africa Ave, Bole, Addis Ababa');
    expect(result.job.dropoffPoint).toMatchObject({ lat: 8.98, lng: 38.79 });
    expect(result.job.dropoffAddress).toBe('Kazanchis, Bldg 4, Addis Ababa');
    expect(result.job.items).toEqual([
      { catalogProductId: seed.productId, name: 'Insulin Glargine', quantity: 2 },
    ]);
  });

  it('round-trips through the repository and rehydrates into the aggregate', async () => {
    const seed = await seedReadyFulfillment({ isCod: true, grandTotal: 18_000, coldChain: true });
    const created = await create.execute({ fulfillmentId: seed.fulfillmentId });

    const byId = await jobs.findById(created.job.id);
    const byFulfillment = await jobs.findByFulfillmentId(seed.fulfillmentId);

    expect(byId).toEqual(created.job);
    expect(byFulfillment).toEqual(created.job);

    // The persisted row is a legal aggregate: every Work 01 invariant holds after a DB round trip.
    const rehydrated = DeliveryJob.rehydrate(byId!);
    expect(rehydrated.status).toBe(DeliveryJobStatus.CREATED);
    expect(rehydrated.toProps()).toMatchObject({
      isCod: true,
      codAmount: 18_000,
      isColdChain: true,
    });
    // And it can still be driven forward.
    expect(rehydrated.transitionTo(DeliveryJobStatus.OFFERED).status).toBe(
      DeliveryJobStatus.OFFERED,
    );
  });

  it('carries the cold-chain flag from the catalogue (BRULE-30)', async () => {
    const seed = await seedReadyFulfillment({ coldChain: true });

    const { job } = await create.execute({ fulfillmentId: seed.fulfillmentId });

    expect(job.isColdChain).toBe(true);
  });

  it('carries COD and the amount a driver must collect', async () => {
    const seed = await seedReadyFulfillment({ isCod: true, grandTotal: 31_250 });

    const { job } = await create.execute({ fulfillmentId: seed.fulfillmentId });

    expect(job).toMatchObject({ isCod: true, codAmount: 31_250 });
  });

  it('lists the job for its pharmacy, and not for another', async () => {
    const seed = await seedReadyFulfillment();
    await create.execute({ fulfillmentId: seed.fulfillmentId });

    const mine = await jobs.list({ pharmacyIds: [seed.pharmacyId], page: 1, size: 20 });
    const theirs = await jobs.list({ pharmacyIds: [randomUUID()], page: 1, size: 20 });
    const all = await jobs.list({ page: 1, size: 20 });

    expect(mine.total).toBe(1);
    expect(theirs).toMatchObject({ items: [], total: 0 });
    expect(all.total).toBe(1);
  });

  // -------------------------------------------------------------------------------------------
  // BRULE-27
  // -------------------------------------------------------------------------------------------

  it.each(['PENDING', 'ACCEPTED', 'PREPARING', 'CANCELLED'])(
    'refuses a fulfillment in %s and writes nothing',
    async (status) => {
      const seed = await seedReadyFulfillment({ status });

      expect(await codeOf(() => create.execute({ fulfillmentId: seed.fulfillmentId }))).toBe(
        ErrorCode.FULFILLMENT_NOT_DELIVERABLE,
      );
      expect(await ctx.prisma.deliveryJob.count()).toBe(0);
      expect(await ctx.prisma.outbox.count({ where: { eventType: 'delivery.job.created' } })).toBe(
        0,
      );
    },
  );

  it('refuses an unknown fulfillment', async () => {
    expect(await codeOf(() => create.execute({ fulfillmentId: randomUUID() }))).toBe(
      ErrorCode.FULFILLMENT_NOT_DELIVERABLE,
    );
  });

  // -------------------------------------------------------------------------------------------
  // Idempotency and concurrency — the claim this design exists to protect
  // -------------------------------------------------------------------------------------------

  it('replays the committed job rather than cutting a second one', async () => {
    const seed = await seedReadyFulfillment();

    const first = await create.execute({ fulfillmentId: seed.fulfillmentId });
    const second = await create.execute({ fulfillmentId: seed.fulfillmentId });

    expect(first.replay).toBe(false);
    expect(second.replay).toBe(true);
    expect(second.job).toEqual(first.job);
    expect(await ctx.prisma.deliveryJob.count()).toBe(1);
    // A replay writes no second audit entry and no second event.
    expect(await ctx.prisma.auditLog.count({ where: { action: 'DELIVERY_JOB_CREATED' } })).toBe(1);
    expect(await ctx.prisma.outbox.count({ where: { eventType: 'delivery.job.created' } })).toBe(1);
  });

  it('converges on one job when several creators run concurrently', async () => {
    const seed = await seedReadyFulfillment();

    const results = await Promise.all([
      create.execute({ fulfillmentId: seed.fulfillmentId }),
      create.execute({ fulfillmentId: seed.fulfillmentId }),
      create.execute({ fulfillmentId: seed.fulfillmentId }),
    ]);

    expect(new Set(results.map((r) => r.job.id)).size).toBe(1);
    expect(await ctx.prisma.deliveryJob.count()).toBe(1);
    expect(await ctx.prisma.outbox.count({ where: { eventType: 'delivery.job.created' } })).toBe(1);
  });

  it('refuses a second job for the same fulfillment at the database level', async () => {
    const seed = await seedReadyFulfillment();
    const { job } = await create.execute({ fulfillmentId: seed.fulfillmentId });

    // Straight past the application, to prove the index is what guarantees this rather than the
    // command's own check.
    await expect(
      ctx.prisma.deliveryJob.create({
        data: {
          orderId: job.orderId,
          fulfillmentId: job.fulfillmentId,
          pharmacyId: job.pharmacyId,
          branchId: job.branchId,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  // -------------------------------------------------------------------------------------------
  // Trail
  // -------------------------------------------------------------------------------------------

  it('records the creation and emits JobCreated atomically with the insert', async () => {
    const seed = await seedReadyFulfillment({ isCod: true, grandTotal: 12_000 });

    const { job } = await create.execute({ fulfillmentId: seed.fulfillmentId });

    const audit = await ctx.prisma.auditLog.findFirst({
      where: { action: 'DELIVERY_JOB_CREATED', resourceId: job.id },
    });
    expect(audit).not.toBeNull();
    expect(audit?.context).toMatchObject({
      fulfillmentId: seed.fulfillmentId,
      codAmount: 12_000,
      isCod: true,
    });

    const event = await ctx.prisma.outbox.findFirst({
      where: { eventType: 'delivery.job.created', aggregateId: job.id },
    });
    expect(event).not.toBeNull();
    expect(event?.aggregateType).toBe('DeliveryJob');
  });

  // -------------------------------------------------------------------------------------------
  // The event path — the same flow Module 06 actually drives
  // -------------------------------------------------------------------------------------------

  it('creates the job when order.ready is relayed from the outbox', async () => {
    const seed = await seedReadyFulfillment();
    await ctx.prisma.outbox.create({
      data: {
        aggregateType: 'Order',
        aggregateId: seed.orderId,
        eventType: 'order.ready',
        payload: {
          id: randomUUID(),
          type: 'order.ready',
          aggregateType: 'Order',
          aggregateId: seed.orderId,
          occurredAt: new Date().toISOString(),
          payload: { orderId: seed.orderId, fulfillmentId: seed.fulfillmentId },
        },
      },
    });

    await ctx.drainOutbox();

    const job = await jobs.findByFulfillmentId(seed.fulfillmentId);
    expect(job).not.toBeNull();
    expect(job).toMatchObject({ orderId: seed.orderId, status: DeliveryJobStatus.CREATED });
  });

  it('is unharmed by a redelivered order.ready', async () => {
    const seed = await seedReadyFulfillment();
    const first = await create.execute({ fulfillmentId: seed.fulfillmentId });

    for (let i = 0; i < 2; i += 1) {
      await ctx.prisma.outbox.create({
        data: {
          aggregateType: 'Order',
          aggregateId: seed.orderId,
          eventType: 'order.ready',
          payload: {
            id: randomUUID(),
            type: 'order.ready',
            aggregateType: 'Order',
            aggregateId: seed.orderId,
            occurredAt: new Date().toISOString(),
            payload: { orderId: seed.orderId, fulfillmentId: seed.fulfillmentId },
          },
        },
      });
    }
    await ctx.drainOutbox();

    expect(await ctx.prisma.deliveryJob.count()).toBe(1);
    expect((await jobs.findByFulfillmentId(seed.fulfillmentId))?.id).toBe(first.job.id);
  });

  // -------------------------------------------------------------------------------------------
  // Degradation
  // -------------------------------------------------------------------------------------------

  it('still creates a job when the pickup branch is soft-deleted', async () => {
    const seed = await seedReadyFulfillment({ withBranch: false });

    const { job } = await create.execute({ fulfillmentId: seed.fulfillmentId });

    // A missing pickup point is correctable by an operator; an uncreated job is one nobody knows
    // to look for.
    expect(job.pickupPoint).toBeNull();
    expect(job.pickupAddress).toBeNull();
    expect(job.status).toBe(DeliveryJobStatus.CREATED);
  });

  it('still creates a job when the order carries no address snapshot', async () => {
    const seed = await seedReadyFulfillment({ withAddress: false });

    const { job } = await create.execute({ fulfillmentId: seed.fulfillmentId });

    expect(job.dropoffPoint).toBeNull();
    expect(job.dropoffAddress).toBeNull();
  });
});
