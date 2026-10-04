import request from 'supertest';
import { randomUUID } from 'crypto';
import { CreateDeliveryJobCommand } from '../../src/modules/delivery/application/commands/create-delivery-job.command';
import {
  FEE_BASE_CONFIG_KEY,
  FEE_MAXIMUM_CONFIG_KEY,
  FEE_MINIMUM_CONFIG_KEY,
  FEE_PER_KM_CONFIG_KEY,
  FEE_PRICING_VERSION_CONFIG_KEY,
  FEE_ROUND_TO_CONFIG_KEY,
  FEE_ZONES_CONFIG_KEY,
} from '../../src/modules/delivery/application/services/delivery-fee-settings';
import { AppConfigService } from '../../src/shared/config/app-config.service';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { auth, body, createUserWithRole, errorOf, uniquePhone } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

/**
 * Delivery fee calculation and `GET /delivery/quote` against real PostgreSQL (§3.5 F-FEE-01,
 * BR-DEL-09, §9.2).
 *
 * Real `AppModule`, real routes, real guards, the real RBAC catalogue, the real cross-module read
 * adapters over Modules 02 and 04, and the real `IRoutingPort` binding.
 *
 * The claims that can only be made here:
 *
 *  1. **The quote is authorized, and the refusal leaks nothing.** Another customer's address
 *     answers `404`, identically to an address that does not exist, so the route cannot be used to
 *     discover whose addresses are whose.
 *  2. **No client-supplied number reaches the price.** An extra `deliveryFee` or `distanceMeters`
 *     query parameter is rejected by the real `ValidationPipe`, not merely ignored.
 *  3. **The rate card really is configuration.** The same request answers differently after a
 *     config change and identically before one, through the real `IConfigPort` lookup.
 *  4. **The job's fee snapshot is a copy of what Module 06 charged**, read back out of Postgres
 *     rather than from an in-memory object — and `delivery_jobs.deliveryFee` is what a driver
 *     earnings work will later read.
 *  5. **A quote writes nothing.** No order, no job, no row of any kind.
 */
describe('Delivery quote and fee (e2e)', () => {
  let ctx: TestContext;
  let createJob: CreateDeliveryJobCommand;
  let config: AppConfigService;

  /**
   * Rate-card values overridden for one test, on the real config port.
   *
   * Every `delivery.fee*` key ships defaulted to zero and the environment this suite boots sets
   * none of them, so a priced delivery would otherwise be untestable without a second application.
   * The override goes through `AppConfigService.get` — the same call `resolveDeliveryFeeSettings`
   * makes — so what runs is the production lookup with a different answer, never a different code
   * path.
   */
  const overrides = new Map<string, unknown>();

  beforeAll(async () => {
    ctx = await createTestApp();
    createJob = ctx.app.get(CreateDeliveryJobCommand);
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

  /** A pharmacy branch to collect from. Bole, with real coordinates. */
  async function seedBranch(options: { lat?: number | null; lng?: number | null } = {}) {
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
        lat: options.lat === undefined ? 9.03 : options.lat,
        lng: options.lng === undefined ? 38.74 : options.lng,
      },
    });
    return { branchId: branch.id, pharmacyId: pharmacy.id };
  }

  /** A customer with one saved address, roughly 3 km from the branch above. */
  async function seedCustomer(options: { lat?: number | null; lng?: number | null } = {}) {
    const user = await createUserWithRole(ctx, 'CUSTOMER');
    const address = await ctx.prisma.address.create({
      data: {
        userId: user.userId,
        label: 'HOME',
        recipientName: 'Selam Bekele',
        recipientPhone: uniquePhone(),
        addressLine: 'Kazanchis, Bldg 4',
        city: 'Addis Ababa',
        lat: options.lat === undefined ? 9.01 : options.lat,
        lng: options.lng === undefined ? 38.76 : options.lng,
      },
    });
    return { ...user, addressId: address.id };
  }

  function quote(token: string, params: Record<string, string>) {
    return request(ctx.server).get('/delivery/quote').query(params).set(...auth(token));
  }

  // -------------------------------------------------------------------------------------------
  // The route
  // -------------------------------------------------------------------------------------------

  it('prices a delivery between a customer address and a pharmacy branch', async () => {
    overrides.set(FEE_BASE_CONFIG_KEY, 2_000).set(FEE_PER_KM_CONFIG_KEY, 1_000);
    const branch = await seedBranch();
    const customer = await seedCustomer();

    const res = await quote(customer.accessToken, {
      addressId: customer.addressId,
      branchId: branch.branchId,
    });

    expect(res.status).toBe(200);
    const payload = body(res);
    expect(payload.branchId).toBe(branch.branchId);
    expect(payload.pharmacyId).toBe(branch.pharmacyId);
    expect(payload.currency).toBe('ETB');
    expect(payload.isEstimate).toBe(true);
    expect(typeof payload.distanceMeters).toBe('number');
    // base + the routed distance at 10 birr/km, whatever the adapter measured.
    expect(payload.deliveryFee).toBe(
      2_000 + Math.round((1_000 * (payload.distanceMeters as number)) / 1000),
    );
  });

  it('reports the distance, the basis and the rate card behind the number', async () => {
    overrides.set(FEE_PRICING_VERSION_CONFIG_KEY, 'rate-card-2026-q1');
    const branch = await seedBranch();
    const customer = await seedCustomer();

    const payload = body(
      await quote(customer.accessToken, {
        addressId: customer.addressId,
        branchId: branch.branchId,
      }),
    );

    expect(payload.basis).toBe('DISTANCE');
    expect(payload.pricingVersion).toBe('rate-card-2026-q1');
    expect(payload.distanceMeters).toBeGreaterThan(0);
    expect(payload.estimatedDurationSeconds).toBeGreaterThan(0);
  });

  it('charges the matching zone flat when a zone rate card is configured', async () => {
    overrides
      .set(FEE_BASE_CONFIG_KEY, 2_000)
      .set(FEE_PER_KM_CONFIG_KEY, 1_000)
      .set(FEE_ZONES_CONFIG_KEY, 'inner:100000:2500');
    const branch = await seedBranch();
    const customer = await seedCustomer();

    const payload = body(
      await quote(customer.accessToken, {
        addressId: customer.addressId,
        branchId: branch.branchId,
      }),
    );

    expect(payload.basis).toBe('ZONE');
    expect(payload.zoneId).toBe('inner');
    expect(payload.deliveryFee).toBe(2_500);
  });

  it('falls back to the distance formula past the furthest zone', async () => {
    overrides
      .set(FEE_BASE_CONFIG_KEY, 2_000)
      .set(FEE_ZONES_CONFIG_KEY, 'inner:10:2500');
    const branch = await seedBranch();
    const customer = await seedCustomer();

    const payload = body(
      await quote(customer.accessToken, {
        addressId: customer.addressId,
        branchId: branch.branchId,
      }),
    );

    expect(payload.basis).toBe('DISTANCE');
    expect(payload.zoneId).toBeNull();
  });

  it('applies the configured floor, cap and rounding step', async () => {
    overrides
      .set(FEE_PER_KM_CONFIG_KEY, 1_000)
      .set(FEE_MINIMUM_CONFIG_KEY, 9_000)
      .set(FEE_MAXIMUM_CONFIG_KEY, 9_000)
      .set(FEE_ROUND_TO_CONFIG_KEY, 100);
    const branch = await seedBranch();
    const customer = await seedCustomer();

    const payload = body(
      await quote(customer.accessToken, {
        addressId: customer.addressId,
        branchId: branch.branchId,
      }),
    );

    expect(payload.deliveryFee).toBe(9_000);
  });

  it('charges nothing with the rate card the platform actually ships', async () => {
    const branch = await seedBranch();
    const customer = await seedCustomer();

    const payload = body(
      await quote(customer.accessToken, {
        addressId: customer.addressId,
        branchId: branch.branchId,
      }),
    );

    expect(payload.deliveryFee).toBe(0);
    expect(payload.pricingVersion).toBe('v1');
  });

  it('reflects a rate-card change on the very next request, with no cache in between', async () => {
    const branch = await seedBranch();
    const customer = await seedCustomer();
    const params = { addressId: customer.addressId, branchId: branch.branchId };

    const before = body(await quote(customer.accessToken, params));
    overrides.set(FEE_BASE_CONFIG_KEY, 3_000);
    const after = body(await quote(customer.accessToken, params));

    expect(before.deliveryFee).toBe(0);
    expect(after.deliveryFee).toBe(3_000);
  });

  it('answers identically when asked twice against an unchanged rate card', async () => {
    overrides.set(FEE_BASE_CONFIG_KEY, 2_000).set(FEE_PER_KM_CONFIG_KEY, 1_000);
    const branch = await seedBranch();
    const customer = await seedCustomer();
    const params = { addressId: customer.addressId, branchId: branch.branchId };

    const first = body(await quote(customer.accessToken, params));
    const second = body(await quote(customer.accessToken, params));

    expect(second).toEqual(first);
  });

  it('prices without a distance, rather than inventing one, when the address has no coordinates', async () => {
    overrides.set(FEE_BASE_CONFIG_KEY, 2_000).set(FEE_PER_KM_CONFIG_KEY, 1_000);
    const branch = await seedBranch();
    const customer = await seedCustomer({ lat: null, lng: null });

    const payload = body(
      await quote(customer.accessToken, {
        addressId: customer.addressId,
        branchId: branch.branchId,
      }),
    );

    expect(payload.basis).toBe('BASE');
    expect(payload.distanceMeters).toBeNull();
    expect(payload.estimatedDurationSeconds).toBeNull();
    expect(payload.deliveryFee).toBe(2_000);
  });

  // -------------------------------------------------------------------------------------------
  // Authorization and input handling
  // -------------------------------------------------------------------------------------------

  it('refuses an anonymous caller', async () => {
    const branch = await seedBranch();
    const customer = await seedCustomer();

    const res = await request(ctx.server)
      .get('/delivery/quote')
      .query({ addressId: customer.addressId, branchId: branch.branchId });

    expect(res.status).toBe(401);
  });

  it('answers 404 for another customer’s address — never 403', async () => {
    const branch = await seedBranch();
    const owner = await seedCustomer();
    const stranger = await seedCustomer();

    const res = await quote(stranger.accessToken, {
      addressId: owner.addressId,
      branchId: branch.branchId,
    });

    expect(res.status).toBe(404);
    expect(errorOf(res).code).toBe(ErrorCode.NOT_FOUND);
  });

  it('answers 404 identically for an address that does not exist at all', async () => {
    const branch = await seedBranch();
    const customer = await seedCustomer();

    const res = await quote(customer.accessToken, {
      addressId: randomUUID(),
      branchId: branch.branchId,
    });

    expect(res.status).toBe(404);
  });

  it('answers 404 for a branch that does not exist', async () => {
    const customer = await seedCustomer();

    const res = await quote(customer.accessToken, {
      addressId: customer.addressId,
      branchId: randomUUID(),
    });

    expect(res.status).toBe(404);
  });

  it('rejects a client-supplied delivery fee rather than honouring it', async () => {
    overrides.set(FEE_BASE_CONFIG_KEY, 2_000);
    const branch = await seedBranch();
    const customer = await seedCustomer();

    const res = await quote(customer.accessToken, {
      addressId: customer.addressId,
      branchId: branch.branchId,
      deliveryFee: '0',
    });

    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('rejects a client-supplied distance rather than routing around the provider', async () => {
    const branch = await seedBranch();
    const customer = await seedCustomer();

    const res = await quote(customer.accessToken, {
      addressId: customer.addressId,
      branchId: branch.branchId,
      distanceMeters: '1',
    });

    expect(res.status).toBe(400);
  });

  it('rejects a malformed identifier', async () => {
    const branch = await seedBranch();
    const customer = await seedCustomer();

    expect(
      (await quote(customer.accessToken, { addressId: 'not-a-uuid', branchId: branch.branchId }))
        .status,
    ).toBe(400);
    expect(
      (await quote(customer.accessToken, { addressId: customer.addressId, branchId: 'nope' }))
        .status,
    ).toBe(400);
  });

  it('writes nothing at all — a quote is a read', async () => {
    overrides.set(FEE_BASE_CONFIG_KEY, 2_000);
    const branch = await seedBranch();
    const customer = await seedCustomer();

    // Measured as a delta rather than against zero: registering the customer legitimately writes
    // its own identity rows and events, and what is under test is what the *quote* writes.
    const before = {
      jobs: await ctx.prisma.deliveryJob.count(),
      orders: await ctx.prisma.order.count(),
      outbox: await ctx.prisma.outbox.count(),
      audit: await ctx.prisma.auditLog.count(),
    };

    await quote(customer.accessToken, {
      addressId: customer.addressId,
      branchId: branch.branchId,
    });

    expect({
      jobs: await ctx.prisma.deliveryJob.count(),
      orders: await ctx.prisma.order.count(),
      outbox: await ctx.prisma.outbox.count(),
      audit: await ctx.prisma.auditLog.count(),
    }).toEqual(before);
    expect(before.jobs).toBe(0);
    expect(before.orders).toBe(0);
  });

  // -------------------------------------------------------------------------------------------
  // The job's fee snapshot (§12)
  // -------------------------------------------------------------------------------------------

  describe('the delivery job fee snapshot', () => {
    async function seedReadyFulfillment(deliveryFee: number) {
      const branch = await seedBranch();
      const product = await ctx.prisma.product.create({
        data: { type: 'MEDICINE', nameEn: 'Amoxicillin 500mg', genericName: 'Amoxicillin' },
      });
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
            lat: 9.01,
            lng: 38.76,
          },
        },
      });
      const fulfillment = await ctx.prisma.fulfillment.create({
        data: {
          orderId: order.id,
          pharmacyId: branch.pharmacyId,
          branchId: branch.branchId,
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
      return { fulfillmentId: fulfillment.id, orderId: order.id };
    }

    it('persists the charged fee and the routed distance on the job row', async () => {
      const seed = await seedReadyFulfillment(4_250);

      const { job } = await createJob.execute({ fulfillmentId: seed.fulfillmentId });

      const row = await ctx.prisma.deliveryJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(row.deliveryFee).toBe(4_250);
      expect(row.distanceMeters).toBeGreaterThan(0);
    });

    /**
     * The whole reason the job copies rather than recalculates. An operator raising the rate card
     * between checkout and dispatch must not change what the customer already agreed to pay.
     */
    it('copies what Module 06 charged, ignoring the rate card in force at dispatch', async () => {
      overrides.set(FEE_BASE_CONFIG_KEY, 99_000).set(FEE_PER_KM_CONFIG_KEY, 99_000);
      const seed = await seedReadyFulfillment(4_250);

      const { job } = await createJob.execute({ fulfillmentId: seed.fulfillmentId });

      const row = await ctx.prisma.deliveryJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(row.deliveryFee).toBe(4_250);
    });

    it('never changes the order’s own charged fee', async () => {
      const seed = await seedReadyFulfillment(4_250);

      await createJob.execute({ fulfillmentId: seed.fulfillmentId });

      const order = await ctx.prisma.order.findUniqueOrThrow({ where: { id: seed.orderId } });
      expect(order.deliveryFee).toBe(4_250);
      expect(order.grandTotal).toBe(24_250);
    });

    it('records both snapshots in the audit trail', async () => {
      const seed = await seedReadyFulfillment(4_250);

      const { job } = await createJob.execute({ fulfillmentId: seed.fulfillmentId });

      const entry = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { action: 'DELIVERY_JOB_CREATED', resourceId: job.id },
      });
      const context = entry.context as Record<string, unknown>;
      expect(context.deliveryFee).toBe(4_250);
      expect(typeof context.distanceMeters).toBe('number');
    });

    it('is immutable: replaying the creation event leaves the snapshot alone', async () => {
      const seed = await seedReadyFulfillment(4_250);
      const first = await createJob.execute({ fulfillmentId: seed.fulfillmentId });

      await ctx.prisma.order.update({
        where: { id: seed.orderId },
        data: { deliveryFee: 9_999 },
      });
      const replay = await createJob.execute({ fulfillmentId: seed.fulfillmentId });

      expect(replay.replay).toBe(true);
      expect(replay.job.id).toBe(first.job.id);
      const row = await ctx.prisma.deliveryJob.findUniqueOrThrow({ where: { id: first.job.id } });
      expect(row.deliveryFee).toBe(4_250);
    });
  });
});
