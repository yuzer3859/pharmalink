import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { AcceptJobOfferCommand } from '../../src/modules/delivery/application/commands/accept-job-offer.command';
import { AdvanceDeliveryJobCommand } from '../../src/modules/delivery/application/commands/advance-delivery-job.command';
import { CreateDeliveryJobCommand } from '../../src/modules/delivery/application/commands/create-delivery-job.command';
import { CreateDriverProfileCommand } from '../../src/modules/delivery/application/commands/create-driver-profile.command';
import { DispatchDeliveryJobCommand } from '../../src/modules/delivery/application/commands/dispatch-delivery-job.command';
import { ManageDriverShiftCommand } from '../../src/modules/delivery/application/commands/manage-driver-shift.command';
import { RecordCodCollectionCommand } from '../../src/modules/delivery/application/commands/record-cod-collection.command';
import { SetDriverAvailabilityCommand } from '../../src/modules/delivery/application/commands/set-driver-availability.command';
import {
  CodCollectionMethod,
  DeliveryJobStatus,
  DriverAvailability,
} from '../../src/modules/delivery/domain/enums';
import { VehicleType } from '../../src/modules/delivery/domain/value-objects/vehicle.vo';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { auth, body, createUserWithRole, errorOf, uniquePhone } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

const OVERVIEW = '/admin/analytics/overview';
const COD_EXPECTED = 24_500;
const COD_COLLECTED = 20_000;

interface Bucket {
  status: string;
  count: number;
}

interface Overview {
  generatedAt: string;
  accounts: { total: number; byStatus: Bucket[]; byPrimaryRole: Array<{ primaryRole: string; count: number }> };
  catalog: { products: { total: number; byStatus: Bucket[] } };
  providers: {
    pharmacies: { total: number; eligible: number; byTransactingStatus: Bucket[]; byLicenseStatus: Bucket[] };
    branches: { total: number; active: number; inactive: number };
    listings: { total: number; enabled: number; disabled: number; inStock: number; outOfStock: number };
  };
  orders: { orders: { total: number; byStatus: Bucket[] }; fulfillments: { total: number; byStatus: Bucket[] } };
  delivery: {
    jobs: { total: number; byStatus: Bucket[] };
    drivers: { total: number; dispatchable: number; byAvailability: Array<{ availability: string; count: number }> };
  };
  cod: Record<string, number>;
}

const USER_STATUSES = ['PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED', 'DELETED', 'PENDING_APPROVAL', 'REJECTED'];
const PRIMARY_ROLES = [
  'CUSTOMER', 'PHARMACY_OWNER', 'PHARMACY_MANAGER', 'PHARMACIST', 'CASHIER', 'INVENTORY_STAFF', 'DOCTOR', 'DRIVER',
  'HOSPITAL_ADMIN', 'DIAGNOSTIC_CENTER_ADMIN', 'LAB_STAFF', 'CUSTOMER_SUPPORT', 'FINANCE_OFFICER', 'ADMIN', 'SUPER_ADMIN',
];
const PRODUCT_STATUSES = ['DRAFT', 'PENDING_REVIEW', 'ACTIVE', 'DEPRECATED', 'DELISTED'];
const TRANSACTING = ['ACTIVE', 'SUSPENDED', 'PENDING'];
const LICENSE = ['VALID', 'EXPIRED', 'SUSPENDED'];
const ORDER_STATUSES = ['DRAFT', 'PENDING_PAYMENT', 'PAID', 'ACCEPTED', 'READY', 'DISPATCHED', 'DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED'];
const FULFILLMENT_STATUSES = ['PENDING', 'ACCEPTED', 'PREPARING', 'READY', 'DISPATCHED', 'DELIVERED', 'CANCELLED'];
const JOB_STATUSES = [
  'CREATED', 'OFFERED', 'ASSIGNED', 'ARRIVED_PICKUP', 'PICKED_UP', 'EN_ROUTE', 'ARRIVED_DROPOFF', 'DELIVERED', 'COMPLETED',
  'REASSIGNING', 'CANCELLED', 'FAILED',
];
const AVAILABILITY = ['ONLINE', 'OFFLINE', 'BUSY'];

/** The zero-filled shape every breakdown has, in the owner's enum order. */
const zeros = (values: string[]): Bucket[] => values.map((status) => ({ status, count: 0 }));
const withCounts = (values: string[], counts: Record<string, number>): Bucket[] =>
  values.map((status) => ({ status, count: counts[status] ?? 0 }));

/**
 * Module 16 Work 08 against real PostgreSQL and the real HTTP stack.
 *
 * Every figure the dashboard shows is produced first in the owning module — rows in a state,
 * a delivery walked through Module 08's own commands, cash recorded by its collection command
 * — and then compared, number for number, with what the dashboard reports. What can only be
 * shown here: that each section is its owner's count and not a recomputation, that the shape is
 * the same with data and without, and that nothing on the route can write anything.
 */
describe('Admin operational analytics (e2e)', () => {
  let ctx: TestContext;
  let createJob: CreateDeliveryJobCommand;
  let dispatch: DispatchDeliveryJobCommand;
  let accept: AcceptJobOfferCommand;
  let advance: AdvanceDeliveryJobCommand;
  let recordCod: RecordCodCollectionCommand;
  let createProfile: CreateDriverProfileCommand;
  let shift: ManageDriverShiftCommand;
  let availability: SetDriverAvailabilityCommand;

  /** `analytics:read`, `finance:report:any`, `rbac:read`, … */
  let admin: Awaited<ReturnType<typeof createUserWithRole>>;
  /** `finance:report:any` and no `analytics:read`. */
  let finance: Awaited<ReturnType<typeof createUserWithRole>>;

  beforeAll(async () => {
    ctx = await createTestApp();
    createJob = ctx.app.get(CreateDeliveryJobCommand);
    dispatch = ctx.app.get(DispatchDeliveryJobCommand);
    accept = ctx.app.get(AcceptJobOfferCommand);
    advance = ctx.app.get(AdvanceDeliveryJobCommand);
    recordCod = ctx.app.get(RecordCodCollectionCommand);
    createProfile = ctx.app.get(CreateDriverProfileCommand);
    shift = ctx.app.get(ManageDriverShiftCommand);
    availability = ctx.app.get(SetDriverAvailabilityCommand);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
    admin = await createUserWithRole(ctx, 'ADMIN');
    finance = await createUserWithRole(ctx, 'FINANCE_OFFICER');
  });

  const overview = (token: string) => request(ctx.server).get(OVERVIEW).set(...auth(token));
  const read = async (token: string) => body(await overview(token).expect(200)) as unknown as Overview;

  // -------------------------------------------------------------------------------------------
  // Fixtures — a delivery walked through Module 08's own commands (the Work 06 scenario)
  // -------------------------------------------------------------------------------------------

  /** An ACTIVE `DRIVER` user, verified, with a profile, on shift and ONLINE — dispatchable. */
  async function seedDriver() {
    const user = await createUserWithRole(ctx, 'DRIVER');
    await ctx.prisma.user.update({ where: { id: user.userId }, data: { primaryRole: 'DRIVER' } });
    await ctx.prisma.verificationRequest.create({
      data: { userId: user.userId, type: 'DRIVER_DOCS', status: 'APPROVED', reviewedAt: new Date() },
    });
    const { profile } = await createProfile.execute({
      userId: user.userId,
      vehicleType: VehicleType.Motorcycle,
      plateNumber: `AA-${Math.floor(Math.random() * 99_999)}`,
      serviceArea: { lat: 9.03, lng: 38.74, radiusMeters: 20_000 },
    });
    await shift.start({ userId: user.userId });
    await availability.execute({ userId: user.userId, availability: DriverAvailability.ONLINE });
    return { userId: user.userId, profileId: profile.id };
  }

  /**
   * One PHARMACY_OWNER user, one pharmacy (PENDING/VALID — the model's defaults), one active
   * branch, one DRAFT product, one PAID order with a READY fulfillment and one line.
   */
  async function seedFulfillment() {
    const owner = await ctx.prisma.user.create({
      data: { primaryRole: 'PHARMACY_OWNER', status: 'ACTIVE', phone: uniquePhone() },
    });
    const organization = await ctx.prisma.organization.create({
      data: { type: 'PHARMACY', name: `Org ${randomUUID()}`, status: 'ACTIVE', ownerUserId: owner.id },
    });
    const pharmacy = await ctx.prisma.pharmacy.create({
      data: { organizationId: organization.id, displayName: 'Bole Pharmacy' },
    });
    const branch = await ctx.prisma.branch.create({
      data: { pharmacyId: pharmacy.id, name: 'Bole Branch', addressLine: 'Africa Ave', city: 'Addis Ababa', lat: 9.03, lng: 38.74 },
    });
    const product = await ctx.prisma.product.create({
      data: { type: 'MEDICINE', nameEn: 'Amoxicillin 500mg', genericName: 'Amoxicillin' },
    });
    const order = await ctx.prisma.order.create({
      data: {
        orderNumber: `ORD-${randomUUID()}`,
        customerUserId: randomUUID(),
        status: 'PAID',
        subtotal: COD_EXPECTED,
        grandTotal: COD_EXPECTED,
        currency: 'ETB',
        isCod: true,
        idempotencyKey: `checkout-${randomUUID()}`,
        addressSnapshot: { line1: 'Kazanchis, Bldg 4', city: 'Addis Ababa', lat: 8.98, lng: 38.79 },
      },
    });
    const fulfillment = await ctx.prisma.fulfillment.create({
      data: { orderId: order.id, pharmacyId: pharmacy.id, branchId: branch.id, status: 'READY' },
    });
    await ctx.prisma.orderLine.create({
      data: {
        orderId: order.id,
        fulfillmentId: fulfillment.id,
        catalogProductId: product.id,
        productSnapshot: { name: 'Amoxicillin 500mg' },
        quantity: 1,
        unitPrice: COD_EXPECTED,
        lineTotal: COD_EXPECTED,
      },
    });
    return { fulfillmentId: fulfillment.id, pharmacyId: pharmacy.id, branchId: branch.id };
  }

  /**
   * A delivery at `ARRIVED_DROPOFF` whose driver declared 20,000 against a 24,500 order, then
   * went OFFLINE. Leaves behind exactly: 2 users (DRIVER, PHARMACY_OWNER), 1 pharmacy, 1 branch,
   * 1 product, 1 order, 1 fulfillment, 1 driver profile (OFFLINE), 1 job, 1 COD collection.
   */
  async function seedDeliveryScenario() {
    const driver = await seedDriver();
    const seed = await seedFulfillment();
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
    await recordCod.execute({
      userId: driver.userId,
      jobId: job.id,
      collectedAmount: COD_COLLECTED,
      method: CodCollectionMethod.CASH,
    });
    await availability.execute({ userId: driver.userId, availability: DriverAvailability.OFFLINE });
    return { ...seed, jobId: job.id };
  }

  // ===========================================================================================
  // 1. Zero data — the shape is the vocabulary, not the rows
  // ===========================================================================================

  describe('with no marketplace activity', () => {
    it('answers every section zero-filled over the owner’s full enum, in enum order', async () => {
      const view = await read(admin.accessToken);

      // The only users are the two the test created, both ACTIVE, both registered as CUSTOMER.
      expect(view.accounts).toEqual({
        total: 2,
        byStatus: withCounts(USER_STATUSES, { ACTIVE: 2 }),
        byPrimaryRole: PRIMARY_ROLES.map((primaryRole) => ({ primaryRole, count: primaryRole === 'CUSTOMER' ? 2 : 0 })),
      });
      expect(view.catalog).toEqual({ products: { total: 0, byStatus: zeros(PRODUCT_STATUSES) } });
      expect(view.providers).toEqual({
        pharmacies: { total: 0, eligible: 0, byTransactingStatus: zeros(TRANSACTING), byLicenseStatus: zeros(LICENSE) },
        branches: { total: 0, active: 0, inactive: 0 },
        listings: { total: 0, enabled: 0, disabled: 0, inStock: 0, outOfStock: 0 },
      });
      expect(view.orders).toEqual({
        orders: { total: 0, byStatus: zeros(ORDER_STATUSES) },
        fulfillments: { total: 0, byStatus: zeros(FULFILLMENT_STATUSES) },
      });
      expect(view.delivery).toEqual({
        jobs: { total: 0, byStatus: zeros(JOB_STATUSES) },
        drivers: { total: 0, dispatchable: 0, byAvailability: AVAILABILITY.map((availability) => ({ availability, count: 0 })) },
      });
      expect(view.cod).toEqual({
        count: 0,
        expectedAmount: 0,
        collectedAmount: 0,
        remittedAmount: 0,
        outstandingCount: 0,
        outstandingAmount: 0,
        discrepancyCount: 0,
      });
      expect(Object.keys(view)).toEqual(['generatedAt', 'accounts', 'catalog', 'providers', 'orders', 'delivery', 'cod']);
      expect(new Date(view.generatedAt).toISOString()).toBe(view.generatedAt);
    });
  });

  // ===========================================================================================
  // 2. Exact metrics from seeded data
  // ===========================================================================================

  describe('with seeded activity', () => {
    it('reports each section as its owner counts it', async () => {
      const scenario = await seedDeliveryScenario();
      // A second driver, dispatchable (ONLINE, on shift); the scenario's is OFFLINE.
      await seedDriver();
      // A job that never left CREATED, on a second fulfillment of a second pharmacy.
      const second = await seedFulfillment();
      await createJob.execute({ fulfillmentId: second.fulfillmentId });

      // Accounts: one suspended customer, one doctor still verifying.
      await ctx.prisma.user.create({ data: { primaryRole: 'CUSTOMER', status: 'SUSPENDED', phone: uniquePhone() } });
      await ctx.prisma.user.create({ data: { primaryRole: 'DOCTOR', status: 'PENDING_VERIFICATION', phone: uniquePhone() } });

      // Catalogue: two ACTIVE, one DELISTED, one soft-deleted ACTIVE (not counted).
      await ctx.prisma.product.createMany({
        data: [
          { type: 'MEDICINE', nameEn: 'A', status: 'ACTIVE' },
          { type: 'MEDICINE', nameEn: 'B', status: 'ACTIVE' },
          { type: 'MEDICINE', nameEn: 'C', status: 'DELISTED' },
          { type: 'MEDICINE', nameEn: 'D', status: 'ACTIVE', deletedAt: new Date() },
        ],
      });

      // Providers: the two scenario pharmacies are PENDING/VALID. Add one eligible (ACTIVE,
      // VALID, licence in the future), one ACTIVE whose licence lapsed yesterday (not eligible),
      // one SUSPENDED/EXPIRED, and one soft-deleted ACTIVE (not counted).
      const yesterday = new Date(Date.now() - 86_400_000);
      const nextYear = new Date(Date.now() + 365 * 86_400_000);
      const eligible = await ctx.prisma.pharmacy.create({
        data: { organizationId: randomUUID(), displayName: 'Eligible', transactingStatus: 'ACTIVE', licenseStatus: 'VALID', licenseExpiresAt: nextYear },
      });
      await ctx.prisma.pharmacy.create({
        data: { organizationId: randomUUID(), displayName: 'Lapsed', transactingStatus: 'ACTIVE', licenseStatus: 'VALID', licenseExpiresAt: yesterday },
      });
      await ctx.prisma.pharmacy.create({
        data: { organizationId: randomUUID(), displayName: 'Suspended', transactingStatus: 'SUSPENDED', licenseStatus: 'EXPIRED' },
      });
      await ctx.prisma.pharmacy.create({
        data: { organizationId: randomUUID(), displayName: 'Gone', transactingStatus: 'ACTIVE', licenseStatus: 'VALID', deletedAt: new Date() },
      });
      // Branches: the two scenario branches are active. Add one inactive and one soft-deleted.
      const inactiveBranch = await ctx.prisma.branch.create({ data: { pharmacyId: eligible.id, name: 'Closed', isActive: false } });
      await ctx.prisma.branch.create({ data: { pharmacyId: eligible.id, name: 'Gone', deletedAt: new Date() } });
      // Listings: enabled with stock ×2, enabled without stock ×1, disabled ×1, soft-deleted ×1.
      await ctx.prisma.inventoryListing.createMany({
        data: [
          { pharmacyId: eligible.id, branchId: inactiveBranch.id, catalogProductId: randomUUID(), price: 100, sellable: 5, onHand: 5 },
          { pharmacyId: eligible.id, branchId: inactiveBranch.id, catalogProductId: randomUUID(), price: 100, sellable: 1, onHand: 1 },
          { pharmacyId: eligible.id, branchId: inactiveBranch.id, catalogProductId: randomUUID(), price: 100, sellable: 0, onHand: 0 },
          { pharmacyId: eligible.id, branchId: inactiveBranch.id, catalogProductId: randomUUID(), price: 100, sellable: 9, isEnabled: false },
          { pharmacyId: eligible.id, branchId: inactiveBranch.id, catalogProductId: randomUUID(), price: 100, sellable: 9, deletedAt: new Date() },
        ],
      });

      // Orders: the two scenario orders are PAID with READY fulfillments. Add a CANCELLED order
      // with a CANCELLED fulfillment and a DRAFT order with none.
      const cancelled = await ctx.prisma.order.create({
        data: { orderNumber: `ORD-${randomUUID()}`, customerUserId: randomUUID(), status: 'CANCELLED', subtotal: 1, grandTotal: 1, currency: 'ETB', idempotencyKey: randomUUID() },
      });
      await ctx.prisma.fulfillment.create({ data: { orderId: cancelled.id, pharmacyId: scenario.pharmacyId, branchId: scenario.branchId, status: 'CANCELLED' } });
      await ctx.prisma.order.create({
        data: { orderNumber: `ORD-${randomUUID()}`, customerUserId: randomUUID(), status: 'DRAFT', subtotal: 1, grandTotal: 1, currency: 'ETB', idempotencyKey: randomUUID() },
      });

      const view = await read(admin.accessToken);

      // admin, finance (CUSTOMER/ACTIVE) + 2 drivers (DRIVER/ACTIVE) + 2 owners + suspended + doctor.
      expect(view.accounts).toEqual({
        total: 8,
        byStatus: withCounts(USER_STATUSES, { ACTIVE: 6, SUSPENDED: 1, PENDING_VERIFICATION: 1 }),
        byPrimaryRole: PRIMARY_ROLES.map((primaryRole) => ({
          primaryRole,
          count: { CUSTOMER: 3, DRIVER: 2, PHARMACY_OWNER: 2, DOCTOR: 1 }[primaryRole] ?? 0,
        })),
      });
      expect(await ctx.prisma.user.count()).toBe(8);

      // 2 scenario DRAFT products + A, B, C. D is deleted.
      expect(view.catalog).toEqual({
        products: { total: 5, byStatus: withCounts(PRODUCT_STATUSES, { DRAFT: 2, ACTIVE: 2, DELISTED: 1 }) },
      });

      expect(view.providers).toEqual({
        pharmacies: {
          total: 5,
          eligible: 1,
          byTransactingStatus: withCounts(TRANSACTING, { ACTIVE: 2, SUSPENDED: 1, PENDING: 2 }),
          byLicenseStatus: withCounts(LICENSE, { VALID: 4, EXPIRED: 1 }),
        },
        branches: { total: 3, active: 2, inactive: 1 },
        listings: { total: 4, enabled: 3, disabled: 1, inStock: 2, outOfStock: 1 },
      });

      expect(view.orders).toEqual({
        orders: { total: 4, byStatus: withCounts(ORDER_STATUSES, { PAID: 2, CANCELLED: 1, DRAFT: 1 }) },
        fulfillments: { total: 3, byStatus: withCounts(FULFILLMENT_STATUSES, { READY: 2, CANCELLED: 1 }) },
      });

      expect(view.delivery).toEqual({
        jobs: { total: 2, byStatus: withCounts(JOB_STATUSES, { ARRIVED_DROPOFF: 1, CREATED: 1 }) },
        drivers: {
          total: 2,
          dispatchable: 1,
          byAvailability: [
            { availability: 'ONLINE', count: 1 },
            { availability: 'OFFLINE', count: 1 },
            { availability: 'BUSY', count: 0 },
          ],
        },
      });

      expect(view.cod).toEqual({
        count: 1,
        expectedAmount: COD_EXPECTED,
        collectedAmount: COD_COLLECTED,
        remittedAmount: 0,
        outstandingCount: 1,
        outstandingAmount: COD_COLLECTED,
        discrepancyCount: 1,
      });
    });

    it('reports COD exactly as Module 08 own summary route does', async () => {
      await seedDeliveryScenario();
      const theirs = body(
        await request(ctx.server)
          .get('/admin/delivery/cod-reconciliation/summary')
          .set(...auth(admin.accessToken))
          .expect(200),
      );
      expect((await read(admin.accessToken)).cod).toEqual(theirs);
    });

    it('keeps operational counts and cash apart: no order total, no job total, no section sum', async () => {
      await seedDeliveryScenario();
      const view = await read(admin.accessToken);
      const raw = JSON.stringify(view);
      // An order worth 24,500 exists, and the only place a 24,500 appears is Module 08's COD
      // expectation — orders and jobs are counted, never priced.
      expect(view.orders.orders.total).toBe(1);
      expect(raw.split(String(COD_EXPECTED)).length - 1).toBe(1);
      for (const forbidden of ['grandtotal', 'revenue', 'gmv', 'netpayable', 'earnings', 'conversion', 'cancellationrate', 'average', 'sla']) {
        expect(raw.toLowerCase()).not.toContain(forbidden);
      }
      // Every breakdown sums to its own total and to nothing else.
      const sum = (b: { count: number }[]) => b.reduce((a, x) => a + x.count, 0);
      expect(sum(view.accounts.byStatus)).toBe(view.accounts.total);
      expect(sum(view.accounts.byPrimaryRole)).toBe(view.accounts.total);
      expect(sum(view.orders.orders.byStatus)).toBe(view.orders.orders.total);
      expect(sum(view.delivery.jobs.byStatus)).toBe(view.delivery.jobs.total);
      expect(sum(view.delivery.drivers.byAvailability)).toBe(view.delivery.drivers.total);
    });

    it('carries no identifier, contact detail, credential, location or document in the raw body', async () => {
      await seedDeliveryScenario();
      const res = await overview(admin.accessToken).expect(200);
      const raw = JSON.stringify(res.body);
      for (const forbidden of [
        'phone', 'email', 'passwordHash', 'faydaId', 'storageRef', 'accessToken', 'providerToken', 'idempotencyKey',
        'plateNumber', 'lat"', 'lng"', 'displayName', 'userId', 'driverId', 'orderId', 'customerUserId', 'Bole', 'Amoxicillin',
      ]) {
        expect({ forbidden, found: raw.includes(forbidden) }).toEqual({ forbidden, found: false });
      }
    });
  });

  // ===========================================================================================
  // 3. Authorization, read-only-ness, boundaries
  // ===========================================================================================

  describe('authorization', () => {
    it('serves ADMIN and SUPER_ADMIN', async () => {
      const superAdmin = await createUserWithRole(ctx, 'SUPER_ADMIN');
      await overview(admin.accessToken).expect(200);
      await overview(superAdmin.accessToken).expect(200);
    });

    it('refuses FINANCE_OFFICER — finance:report:any is not analytics:read', async () => {
      const res = await overview(finance.accessToken).expect(403);
      expect(errorOf(res).code).toBe(ErrorCode.FORBIDDEN);
    });

    it.each(['CUSTOMER', 'DRIVER', 'PHARMACY_OWNER', 'CUSTOMER_SUPPORT'])('refuses %s', async (role) => {
      const caller = await createUserWithRole(ctx, role);
      const res = await overview(caller.accessToken).expect(403);
      expect(errorOf(res).code).toBe(ErrorCode.FORBIDDEN);
    });

    it('refuses an unauthenticated caller', async () => {
      await request(ctx.server).get(OVERVIEW).expect(401);
    });

    it('is the exact catalogue key the design names, granted to ADMIN alone', async () => {
      const permission = await ctx.prisma.permission.findUniqueOrThrow({ where: { key: 'analytics:read' } });
      expect(permission).toMatchObject({ resource: 'analytics', action: 'read' });
      const holders = await ctx.prisma.rolePermission.findMany({
        where: { permissionId: permission.id },
        include: { role: { select: { key: true } } },
      });
      expect(holders.map((h) => h.role.key)).toEqual(['ADMIN']);
    });
  });

  describe('read-only', () => {
    it('exposes nothing but GET /overview under /admin/analytics', async () => {
      for (const [method, path] of [
        ['post', '/overview'],
        ['put', '/overview'],
        ['patch', '/overview'],
        ['delete', '/overview'],
        ['post', ''],
        ['get', ''],
        ['get', '/orders'],
        ['get', '/delivery'],
        ['get', '/pharmacies'],
        ['get', '/snapshots'],
        ['post', '/snapshots'],
      ] as const) {
        const res = await request(ctx.server)[method](`/admin/analytics${path}`).set(...auth(admin.accessToken)).send({});
        expect({ method, path, status: res.status }).toEqual({ method, path, status: 404 });
      }
    });

    it('ignores a query string rather than filtering by one', async () => {
      // No DTO is declared, so nothing is whitelisted and nothing is forbidden: the read is the
      // same all-time snapshot whatever is appended. A period filter is deferred, not half-built.
      await seedDeliveryScenario();
      const plain = await read(admin.accessToken);
      const filtered = body(
        await request(ctx.server)
          .get(OVERVIEW)
          .query({ from: '2000-01-01T00:00:00.000Z', to: '2000-01-02T00:00:00.000Z' })
          .set(...auth(admin.accessToken))
          .expect(200),
      ) as unknown as Overview;
      expect({ ...filtered, generatedAt: undefined }).toEqual({ ...plain, generatedAt: undefined });
    });

    it('appends no audit entry and changes no row', async () => {
      await seedDeliveryScenario();
      const before = {
        audits: await ctx.prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } }),
        users: await ctx.prisma.user.findMany({ orderBy: { id: 'asc' } }),
        orders: await ctx.prisma.order.findMany({ orderBy: { id: 'asc' } }),
        jobs: await ctx.prisma.deliveryJob.findMany({ orderBy: { id: 'asc' } }),
        drivers: await ctx.prisma.driverProfile.findMany({ orderBy: { id: 'asc' } }),
        collections: await ctx.prisma.codCollection.findMany({ orderBy: { id: 'asc' } }),
      };
      await overview(admin.accessToken).expect(200);
      await overview(admin.accessToken).expect(200);
      expect(await ctx.prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } })).toEqual(before.audits);
      expect(await ctx.prisma.user.findMany({ orderBy: { id: 'asc' } })).toEqual(before.users);
      expect(await ctx.prisma.order.findMany({ orderBy: { id: 'asc' } })).toEqual(before.orders);
      expect(await ctx.prisma.deliveryJob.findMany({ orderBy: { id: 'asc' } })).toEqual(before.jobs);
      expect(await ctx.prisma.driverProfile.findMany({ orderBy: { id: 'asc' } })).toEqual(before.drivers);
      expect(await ctx.prisma.codCollection.findMany({ orderBy: { id: 'asc' } })).toEqual(before.collections);
    });
  });

  describe('boundaries', () => {
    const adminRoot = join(__dirname, '..', '..', 'src', 'modules', 'admin');
    const sources = (): string[] => {
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          if (statSync(full).isDirectory()) walk(full);
          else if (full.endsWith('.ts') && !full.endsWith('.spec.ts')) files.push(full);
        }
      };
      walk(adminRoot);
      return files;
    };

    it('Module 16 touches no Module 01/03/04/06/08 table, repository, entity, command, query or infrastructure', () => {
      const files = sources();
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const source = readFileSync(file, 'utf8');
        for (const forbidden of [
          '$queryRaw',
          '$executeRaw',
          // Module 01
          'prisma.user',
          'prisma.organization',
          'prisma.userRole',
          'USER_REPOSITORY',
          'identity/domain/',
          'identity/infrastructure/',
          'identity/application/commands/',
          'identity/application/queries/',
          // Module 03
          'prisma.product',
          'prisma.category',
          'PRODUCT_REPOSITORY',
          'catalog/domain/',
          'catalog/infrastructure/',
          'catalog/application/commands/',
          'catalog/application/queries/',
          // Module 04
          'prisma.pharmacy',
          'prisma.branch',
          'prisma.inventoryListing',
          'prisma.stock',
          'PHARMACY_REPOSITORY',
          'BRANCH_REPOSITORY',
          'LISTING_REPOSITORY',
          'pharmacy-inventory/domain/',
          'pharmacy-inventory/infrastructure/',
          'pharmacy-inventory/application/commands/',
          'pharmacy-inventory/application/queries/',
          // Module 06
          'prisma.order',
          'prisma.fulfillment',
          'prisma.cart',
          'ORDER_REPOSITORY',
          'FULFILLMENT_REPOSITORY',
          'orders/domain/',
          'orders/infrastructure/',
          'orders/application/commands/',
          'orders/application/queries/',
          // Module 08
          'prisma.deliveryJob',
          'prisma.driverProfile',
          'prisma.jobOffer',
          'prisma.cod',
          'DELIVERY_JOB_REPOSITORY',
          'DRIVER_PROFILE_REPOSITORY',
          'COD_COLLECTION_REPOSITORY',
          'delivery/domain/',
          'delivery/infrastructure/',
          'delivery/application/commands/',
          'delivery/application/queries/',
        ]) {
          expect({ file, forbidden, found: source.includes(forbidden) }).toEqual({ file, forbidden, found: false });
        }
      }
    });

    it('Module 16 reaches the source modules only through their inbound ports, modules and interface decorators', () => {
      const imports = new Set<string>();
      for (const file of sources()) {
        for (const m of readFileSync(file, 'utf8').matchAll(
          /from '([^']*(?:identity|catalog|pharmacy-inventory|orders|delivery|payment)\/[^']*)'/g,
        )) {
          imports.add(m[1].replace(/^(\.\.\/)+/, ''));
        }
      }
      expect([...imports].sort()).toEqual([
        'catalog/application/ports/inbound/catalog-admin-read.port',
        'catalog/application/ports/inbound/catalog-analytics-read.port',
        // Work 28: catalogue review approval (admin-catalog-approval.e2e-spec.ts).
        'catalog/application/ports/inbound/catalog-review-approval.port',
        // Work 29: catalogue review submission (admin-catalog-submission.e2e-spec.ts).
        'catalog/application/ports/inbound/catalog-review-submission.port',
        'catalog/catalog.module',
        'delivery/application/ports/inbound/cod-dispute-admin.port',
        'delivery/application/ports/inbound/cod-finance-read.port',
        'delivery/application/ports/inbound/delivery-analytics-read.port',
        'delivery/delivery.module',
        'identity/application/ports/inbound/identity-admin.port',
        'identity/application/ports/inbound/identity-analytics-read.port',
        'identity/identity.module',
        'identity/interface/decorators/current-user.decorator',
        'orders/application/ports/inbound/order-analytics-read.port',
        'orders/orders.module',
        'payment/application/ports/inbound/finance-oversight.port',
        'payment/payment.module',
        'pharmacy-inventory/application/ports/inbound/pharmacy-analytics-read.port',
        // Work 25: eligible providers with / without anything to sell (admin-inventory-operations.e2e-spec.ts).
        'pharmacy-inventory/application/ports/inbound/pharmacy-stock-availability-read.port',
        'pharmacy-inventory/pharmacy-inventory.module',
      ]);
    });
  });
});
