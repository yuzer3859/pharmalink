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

const FINANCE = '/admin/finance';
const GRAND_TOTAL = 10_000;
const PLATFORM_FEE = 1_000;
const COD_EXPECTED = 24_500;
const COD_COLLECTED = 20_000;
const PERIOD_START = '2020-01-01T00:00:00.000Z';
const PERIOD_END = '2030-01-01T00:00:00.000Z';

interface PaymentRow {
  paymentId: string;
  orderId: string;
  customerUserId: string;
  amount: number;
  currency: string;
  method: string;
  status: string;
  provider: string | null;
  providerRef: string | null;
  authorizedAt: string | null;
  capturedAt: string | null;
  createdAt: string;
}

interface Page<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

interface RefundRow {
  refundId: string;
  paymentId: string;
  amount: number;
  currency: string;
  type: string;
  destination: string;
  status: string;
  reason: string | null;
  approvedBy: string | null;
  createdAt: string;
}

interface Totals {
  currency: string;
  status: string;
  count: number;
  amount: number;
}

interface Overview {
  generatedAt: string;
  payments: { byStatus: Totals[] };
  refunds: { byStatus: Totals[] };
  settlements: {
    byStatus: Array<{
      currency: string;
      status: string;
      count: number;
      providerPayableGross: number;
      refundClawback: number;
      netPayable: number;
      platformRevenue: number;
      promotionExpense: number;
      customerCashCollected: number;
    }>;
  };
  cod: {
    count: number;
    expectedAmount: number;
    collectedAmount: number;
    remittedAmount: number;
    outstandingCount: number;
    outstandingAmount: number;
    discrepancyCount: number;
  };
}

/**
 * Module 16 Work 07 against real PostgreSQL and the real HTTP stack.
 *
 * Every figure the control plane shows is produced first through the owning module's own
 * commands and routes — a payment authorised and captured through §9.1, a refund through §9.3, a
 * statement through Module 07's `/run`, COD cash through Module 08's collection command — and
 * then compared, number for number, with what those modules themselves report. What can only be
 * shown here: that the oversight surface is those modules' facts and not a recomputation, that
 * the four kinds of money stay apart, and that nothing on it can move any of them.
 */
describe('Admin finance oversight (e2e)', () => {
  let ctx: TestContext;
  let createJob: CreateDeliveryJobCommand;
  let dispatch: DispatchDeliveryJobCommand;
  let accept: AcceptJobOfferCommand;
  let advance: AdvanceDeliveryJobCommand;
  let recordCod: RecordCodCollectionCommand;
  let createProfile: CreateDriverProfileCommand;
  let shift: ManageDriverShiftCommand;
  let availability: SetDriverAvailabilityCommand;

  /** `finance:report:any`, `finance:settlement:any`, `finance:refund:any`, `payment:capture:any`. */
  let finance: Awaited<ReturnType<typeof createUserWithRole>>;
  /** `finance:report:any` and `payment:capture:any`, not the settlement or refund keys. */
  let admin: Awaited<ReturnType<typeof createUserWithRole>>;

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
    finance = await createUserWithRole(ctx, 'FINANCE_OFFICER');
    admin = await createUserWithRole(ctx, 'ADMIN');
  });

  // -------------------------------------------------------------------------------------------
  // Fixtures — Module 07 money, made through Module 07's own routes
  // -------------------------------------------------------------------------------------------

  interface Seeded {
    paymentId: string;
    orderId: string;
    customerUserId: string;
    pharmacyId: string;
    customerToken: string;
  }

  /** A gateway payment: authorised by its customer through §9.1 and, by default, captured by finance. */
  async function seedPayment(
    options: { capture?: boolean; customer?: Awaited<ReturnType<typeof createUserWithRole>> } = {},
  ): Promise<Seeded> {
    const customer = options.customer ?? (await createUserWithRole(ctx, 'CUSTOMER'));
    const pharmacyId = `pharmacy-${randomUUID()}`;
    const order = await ctx.prisma.order.create({
      data: {
        orderNumber: `ORD-${randomUUID()}`,
        customerUserId: customer.userId,
        status: 'PENDING_PAYMENT',
        subtotal: GRAND_TOTAL - PLATFORM_FEE,
        deliveryFee: 0,
        platformFee: PLATFORM_FEE,
        discountTotal: 0,
        grandTotal: GRAND_TOTAL,
        currency: 'ETB',
        idempotencyKey: `checkout-${randomUUID()}`,
        isCod: false,
      },
    });
    await ctx.prisma.fulfillment.create({
      data: { orderId: order.id, pharmacyId, branchId: `branch-${randomUUID()}` },
    });
    const authorized = body(
      await request(ctx.server)
        .post('/payments/authorize')
        .set(...auth(customer.accessToken))
        .set('Idempotency-Key', `pay-${randomUUID()}`)
        .send({ orderId: order.id, method: 'TELEBIRR' })
        .expect(201),
    );
    const paymentId = authorized.paymentId as string;
    if (options.capture !== false) {
      await request(ctx.server)
        .post(`/payments/${paymentId}/capture`)
        .set(...auth(finance.accessToken))
        .set('Idempotency-Key', `cap-${randomUUID()}`)
        .send({})
        .expect(200);
    }
    return { paymentId, orderId: order.id, customerUserId: customer.userId, pharmacyId, customerToken: customer.accessToken };
  }

  /** A refund through §9.3, approved by the finance officer. */
  async function seedRefund(paymentId: string, amount: number, destination = 'ORIGINAL') {
    const data = body(
      await request(ctx.server)
        .post(`/payments/${paymentId}/refunds`)
        .set(...auth(finance.accessToken))
        .set('Idempotency-Key', `refund-${randomUUID()}`)
        .send({ amount, reason: 'oversight fixture', destination })
        .expect(201),
    );
    return data.refundId as string;
  }

  /** A statement cut through Module 07's own finance route; returns the statement as it reports it. */
  async function seedSettlement(pharmacyId: string) {
    const data = body(
      await request(ctx.server)
        .post('/admin/finance/settlements/run')
        .set(...auth(finance.accessToken))
        .send({ pharmacyId, periodStart: PERIOD_START, periodEnd: PERIOD_END })
        .expect(200),
    );
    return data.settlement as Record<string, number>;
  }

  // -------------------------------------------------------------------------------------------
  // Fixtures — Module 08 cash, recorded through Module 08's own commands
  // -------------------------------------------------------------------------------------------

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

  async function seedCodFulfillment() {
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
    return { fulfillmentId: fulfillment.id };
  }

  /** A delivery whose driver declared 20,000 against a 24,500 order — a real shortfall. */
  async function seedCodCollection(): Promise<string> {
    const driver = await seedDriver();
    const seed = await seedCodFulfillment();
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
    const { collection } = await recordCod.execute({
      userId: driver.userId,
      jobId: job.id,
      collectedAmount: COD_COLLECTED,
      method: CodCollectionMethod.CASH,
    });
    await availability.execute({ userId: driver.userId, availability: DriverAvailability.OFFLINE });
    return collection.id;
  }

  // -------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------

  const get = (token: string, path: string, query: Record<string, unknown> = {}) =>
    request(ctx.server).get(`${FINANCE}${path}`).query(query).set(...auth(token));
  const overview = (token: string) => get(token, '/overview');
  const payments = (token: string, query: Record<string, unknown> = {}) => get(token, '/payments', query);
  const payment = (token: string, id: string) => get(token, `/payments/${id}`);
  const refunds = (token: string, query: Record<string, unknown> = {}) => get(token, '/refunds', query);

  const ids = (page: Page<PaymentRow>) => page.items.map((i) => i.paymentId);

  // ===========================================================================================
  // 1. Overview
  // ===========================================================================================

  describe('GET /admin/finance/overview', () => {
    it('reports the four kinds of money apart, each equal to what its owner records', async () => {
      const captured = await seedPayment();
      await seedPayment();
      const authorizedOnly = await seedPayment({ capture: false });
      await seedRefund(captured.paymentId, 2_500);
      const statement = await seedSettlement(captured.pharmacyId);
      await seedCodCollection();

      const view = body(await overview(finance.accessToken).expect(200)) as unknown as Overview;

      // Payments: a gross figure per status. The partly refunded one still sits at its full
      // captured amount under PARTIALLY_REFUNDED — refunds are not netted here.
      expect(view.payments.byStatus).toEqual([
        { currency: 'ETB', status: 'AUTHORIZED', count: 1, amount: GRAND_TOTAL },
        { currency: 'ETB', status: 'CAPTURED', count: 1, amount: GRAND_TOTAL },
        { currency: 'ETB', status: 'PARTIALLY_REFUNDED', count: 1, amount: GRAND_TOTAL },
      ]);
      expect(view.refunds.byStatus).toEqual([{ currency: 'ETB', status: 'COMPLETED', count: 1, amount: 2_500 }]);

      // Settlements: exactly the statement Module 07 cut, summed over one DRAFT bucket.
      expect(view.settlements.byStatus).toEqual([
        {
          currency: 'ETB',
          status: 'DRAFT',
          count: 1,
          providerPayableGross: statement.providerPayableGross,
          refundClawback: statement.refundClawback,
          netPayable: statement.netPayable,
          platformRevenue: statement.platformRevenue,
          promotionExpense: statement.promotionExpense,
          customerCashCollected: statement.customerCashCollected,
        },
      ]);
      expect(view.settlements.byStatus[0].netPayable).toBe(
        view.settlements.byStatus[0].providerPayableGross - view.settlements.byStatus[0].refundClawback,
      );

      // COD: Module 08's cash, and only Module 08's cash — none of the gateway payments above.
      expect(view.cod).toEqual({
        count: 1,
        expectedAmount: COD_EXPECTED,
        collectedAmount: COD_COLLECTED,
        remittedAmount: 0,
        outstandingCount: 1,
        outstandingAmount: COD_COLLECTED,
        discrepancyCount: 1,
      });

      // The distinction, stated as numbers: what was captured is not what a pharmacy is owed is
      // not what a driver is holding. No key totals them.
      expect(view.payments.byStatus.find((b) => b.status === 'CAPTURED')?.amount).not.toBe(
        view.settlements.byStatus[0].netPayable,
      );
      expect(view.cod.collectedAmount).not.toBe(view.settlements.byStatus[0].netPayable);
      expect(Object.keys(view).sort()).toEqual(['cod', 'generatedAt', 'payments', 'refunds', 'settlements']);
      expect(authorizedOnly.paymentId).toBeDefined();
    });

    it('matches Module 08 own summary route figure for figure', async () => {
      await seedCodCollection();
      const theirs = body(
        await request(ctx.server)
          .get('/admin/delivery/cod-reconciliation/summary')
          .set(...auth(finance.accessToken))
          .expect(200),
      );
      const view = body(await overview(finance.accessToken).expect(200)) as unknown as Overview;
      expect(view.cod).toEqual(theirs);
    });

    it('answers an empty platform with empty sections, not zeros invented for absent statuses', async () => {
      const view = body(await overview(admin.accessToken).expect(200)) as unknown as Overview;
      expect(view.payments.byStatus).toEqual([]);
      expect(view.refunds.byStatus).toEqual([]);
      expect(view.settlements.byStatus).toEqual([]);
      expect(view.cod).toEqual({
        count: 0,
        expectedAmount: 0,
        collectedAmount: 0,
        remittedAmount: 0,
        outstandingCount: 0,
        outstandingAmount: 0,
        discrepancyCount: 0,
      });
    });
  });

  // ===========================================================================================
  // 2. Payments
  // ===========================================================================================

  describe('GET /admin/finance/payments', () => {
    it('lists every payment across customers, newest first, with the Module 07 projection', async () => {
      const first = await seedPayment();
      const second = await seedPayment({ capture: false });

      const page = body(await payments(admin.accessToken).expect(200)) as unknown as Page<PaymentRow>;

      expect(page).toMatchObject({ total: 2, page: 1, size: 20 });
      expect(ids(page)).toEqual([second.paymentId, first.paymentId]);
      const row = page.items[1];
      const stored = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: first.paymentId } });
      expect(row).toEqual({
        paymentId: first.paymentId,
        orderId: first.orderId,
        customerUserId: first.customerUserId,
        amount: GRAND_TOTAL,
        currency: 'ETB',
        method: 'TELEBIRR',
        status: 'CAPTURED',
        provider: 'mock',
        providerRef: stored.providerRef,
        originalAmount: null,
        originalCurrency: null,
        fxRate: null,
        fxSource: null,
        authorizedAt: stored.authorizedAt?.toISOString() ?? null,
        capturedAt: stored.capturedAt?.toISOString() ?? null,
        failureReason: null,
        createdAt: stored.createdAt.toISOString(),
        updatedAt: stored.updatedAt.toISOString(),
      });
      expect(page.items[0].status).toBe('AUTHORIZED');
    });

    it('orders deterministically by createdAt desc, id desc across pages', async () => {
      for (let i = 0; i < 5; i += 1) {
        await seedPayment({ capture: false });
      }
      const rows = await ctx.prisma.payment.findMany({ select: { id: true, createdAt: true } });
      const expected = rows
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (b.id > a.id ? 1 : -1))
        .map((r) => r.id);

      const p1 = body(await payments(admin.accessToken, { page: 1, size: 2 }).expect(200)) as unknown as Page<PaymentRow>;
      const p2 = body(await payments(admin.accessToken, { page: 2, size: 2 }).expect(200)) as unknown as Page<PaymentRow>;
      const p3 = body(await payments(admin.accessToken, { page: 3, size: 2 }).expect(200)) as unknown as Page<PaymentRow>;

      expect([...ids(p1), ...ids(p2), ...ids(p3)]).toEqual(expected);
      expect(p1).toMatchObject({ total: 5, page: 1, size: 2 });
      expect(p3.items).toHaveLength(1);
    });

    it('filters by status, method, provider, orderId and customerUserId', async () => {
      const captured = await seedPayment();
      const held = await seedPayment({ capture: false });

      expect(ids(body(await payments(admin.accessToken, { status: 'CAPTURED' }).expect(200)) as unknown as Page<PaymentRow>)).toEqual([captured.paymentId]);
      expect(ids(body(await payments(admin.accessToken, { status: 'AUTHORIZED' }).expect(200)) as unknown as Page<PaymentRow>)).toEqual([held.paymentId]);
      expect(ids(body(await payments(admin.accessToken, { status: 'FAILED' }).expect(200)) as unknown as Page<PaymentRow>)).toEqual([]);
      expect(ids(body(await payments(admin.accessToken, { method: 'TELEBIRR' }).expect(200)) as unknown as Page<PaymentRow>)).toEqual([held.paymentId, captured.paymentId]);
      expect(ids(body(await payments(admin.accessToken, { method: 'COD' }).expect(200)) as unknown as Page<PaymentRow>)).toEqual([]);
      expect(ids(body(await payments(admin.accessToken, { provider: 'mock' }).expect(200)) as unknown as Page<PaymentRow>)).toEqual([held.paymentId, captured.paymentId]);
      expect(ids(body(await payments(admin.accessToken, { provider: 'telebirr' }).expect(200)) as unknown as Page<PaymentRow>)).toEqual([]);
      expect(ids(body(await payments(admin.accessToken, { orderId: captured.orderId }).expect(200)) as unknown as Page<PaymentRow>)).toEqual([captured.paymentId]);
      expect(ids(body(await payments(admin.accessToken, { customerUserId: held.customerUserId }).expect(200)) as unknown as Page<PaymentRow>)).toEqual([held.paymentId]);
      expect(ids(body(await payments(admin.accessToken, { customerUserId: randomUUID() }).expect(200)) as unknown as Page<PaymentRow>)).toEqual([]);
    });

    it('filters by a half-open createdAt window', async () => {
      const first = await seedPayment({ capture: false });
      const second = await seedPayment({ capture: false });
      const third = await seedPayment({ capture: false });
      const pivot = (await ctx.prisma.payment.findUniqueOrThrow({ where: { id: second.paymentId } })).createdAt.toISOString();

      const from = body(await payments(admin.accessToken, { createdFrom: pivot }).expect(200)) as unknown as Page<PaymentRow>;
      const to = body(await payments(admin.accessToken, { createdTo: pivot }).expect(200)) as unknown as Page<PaymentRow>;

      expect(ids(from)).toEqual([third.paymentId, second.paymentId]);
      expect(ids(to)).toEqual([first.paymentId]);
    });

    it.each([
      ['an unknown status', { status: 'PAID' }],
      ['an unknown method', { method: 'BITCOIN' }],
      ['a provider key with an expression in it', { provider: 'mock OR 1=1' }],
      ['a non-UUID orderId', { orderId: 'order-1' }],
      ['a non-UUID customerUserId', { customerUserId: 'me' }],
      ['an unparseable date', { createdFrom: 'yesterday' }],
      ['page 0', { page: 0 }],
      ['size above the cap', { size: 101 }],
      ['a filter the DTO does not declare', { where: '{"amount":{"gt":0}}' }],
    ])('rejects %s with 400', async (_label, query) => {
      const res = await payments(admin.accessToken, query).expect(400);
      expect(errorOf(res).code).toBe(ErrorCode.VALIDATION_ERROR);
    });

    it('carries no gateway token, idempotency key or Module 01 field in the raw body', async () => {
      await seedPayment();
      const res = await payments(finance.accessToken).expect(200);
      const raw = JSON.stringify(res.body);
      for (const forbidden of ['providerToken', 'idempotencyKey', 'tok_', 'phone', 'email', 'passwordHash', 'faydaId', 'accessToken', 'ledger']) {
        expect(raw).not.toContain(forbidden);
      }
    });
  });

  describe('GET /admin/finance/payments/:id', () => {
    it('returns the payment with §9.3 refund view beside it', async () => {
      const seeded = await seedPayment();
      const refundId = await seedRefund(seeded.paymentId, 2_500, 'WALLET');

      const detail = body(await payment(admin.accessToken, seeded.paymentId).expect(200));
      const theirs = body(
        await request(ctx.server)
          .get(`/payments/${seeded.paymentId}/refunds`)
          .set(...auth(seeded.customerToken))
          .expect(200),
      );

      expect(detail.payment).toMatchObject({ paymentId: seeded.paymentId, status: 'PARTIALLY_REFUNDED', amount: GRAND_TOTAL });
      expect(detail.refunds).toEqual({
        capturedAmount: GRAND_TOTAL,
        totalRefunded: 2_500,
        remainingRefundable: GRAND_TOTAL - 2_500,
        refunds: [expect.objectContaining({ refundId, amount: 2_500, destination: 'WALLET', status: 'COMPLETED' })],
      });
      // The same figures §9.3 gives the customer: Module 07's projection, not a recomputation.
      expect(detail.refunds).toMatchObject({
        capturedAmount: theirs.capturedAmount,
        totalRefunded: theirs.totalRefunded,
        remainingRefundable: theirs.remainingRefundable,
      });
      expect(JSON.stringify(detail)).not.toContain('idempotencyKey');
    });

    it('answers 404 for an unknown payment and 400 for a malformed id', async () => {
      const missing = await payment(admin.accessToken, randomUUID()).expect(404);
      expect(errorOf(missing).code).toBe(ErrorCode.NOT_FOUND);
      const malformed = await payment(admin.accessToken, 'not-a-uuid').expect(400);
      expect(errorOf(malformed).code).toBe(ErrorCode.VALIDATION_ERROR);
    });
  });

  // ===========================================================================================
  // 3. Refunds
  // ===========================================================================================

  describe('GET /admin/finance/refunds', () => {
    it('lists every refund across payments, newest first, with the approver and the payment currency', async () => {
      const a = await seedPayment();
      const b = await seedPayment();
      const r1 = await seedRefund(a.paymentId, 1_000);
      const r2 = await seedRefund(b.paymentId, 3_000, 'WALLET');

      const page = body(await refunds(finance.accessToken).expect(200)) as unknown as Page<RefundRow>;

      expect(page).toMatchObject({ total: 2, page: 1, size: 20 });
      expect(page.items.map((i) => i.refundId)).toEqual([r2, r1]);
      const stored = await ctx.prisma.refund.findUniqueOrThrow({ where: { id: r1 } });
      expect(page.items[1]).toEqual({
        refundId: r1,
        paymentId: a.paymentId,
        amount: 1_000,
        currency: 'ETB',
        type: 'PARTIAL',
        destination: 'ORIGINAL',
        status: 'COMPLETED',
        providerRef: stored.providerRef,
        reason: 'oversight fixture',
        approvedBy: finance.userId,
        createdAt: stored.createdAt.toISOString(),
        completedAt: stored.completedAt?.toISOString() ?? null,
      });
      expect(JSON.stringify(page)).not.toContain('idempotencyKey');
    });

    it('filters by status, type, destination, paymentId and createdAt window', async () => {
      const a = await seedPayment();
      const b = await seedPayment();
      const partial = await seedRefund(a.paymentId, 1_000);
      const full = await seedRefund(b.paymentId, GRAND_TOTAL, 'WALLET');
      const pivot = (await ctx.prisma.refund.findUniqueOrThrow({ where: { id: full } })).createdAt.toISOString();
      const list = async (query: Record<string, unknown>) =>
        (body(await refunds(finance.accessToken, query).expect(200)) as unknown as Page<RefundRow>).items.map((i) => i.refundId);

      expect(await list({ status: 'COMPLETED' })).toEqual([full, partial]);
      expect(await list({ status: 'PENDING' })).toEqual([]);
      expect(await list({ type: 'FULL' })).toEqual([full]);
      expect(await list({ type: 'PARTIAL' })).toEqual([partial]);
      expect(await list({ destination: 'WALLET' })).toEqual([full]);
      expect(await list({ destination: 'ORIGINAL' })).toEqual([partial]);
      expect(await list({ paymentId: a.paymentId })).toEqual([partial]);
      expect(await list({ paymentId: randomUUID() })).toEqual([]);
      expect(await list({ createdFrom: pivot })).toEqual([full]);
      expect(await list({ createdTo: pivot })).toEqual([partial]);
    });

    it('paginates with the same clamp as payments', async () => {
      const a = await seedPayment();
      for (const amount of [1_000, 1_000, 1_000]) {
        await seedRefund(a.paymentId, amount);
      }
      const p1 = body(await refunds(finance.accessToken, { page: 1, size: 2 }).expect(200)) as unknown as Page<RefundRow>;
      const p2 = body(await refunds(finance.accessToken, { page: 2, size: 2 }).expect(200)) as unknown as Page<RefundRow>;
      expect(p1).toMatchObject({ total: 3, page: 1, size: 2 });
      expect(p1.items).toHaveLength(2);
      expect(p2.items).toHaveLength(1);
      expect(new Set([...p1.items, ...p2.items].map((i) => i.refundId)).size).toBe(3);
    });

    it.each([
      ['an unknown status', { status: 'DONE' }],
      ['an unknown type', { type: 'HALF' }],
      ['an unknown destination', { destination: 'CASH' }],
      ['a non-UUID paymentId', { paymentId: 'pay-1' }],
      ['an unparseable date', { createdTo: 'soon' }],
      ['size 0', { size: 0 }],
      ['a filter the DTO does not declare', { reason: 'dispute' }],
    ])('rejects %s with 400', async (_label, query) => {
      const res = await refunds(finance.accessToken, query).expect(400);
      expect(errorOf(res).code).toBe(ErrorCode.VALIDATION_ERROR);
    });
  });

  // ===========================================================================================
  // 4. Authorization, read-only-ness, boundaries
  // ===========================================================================================

  describe('authorization', () => {
    it('serves FINANCE_OFFICER, ADMIN and SUPER_ADMIN on every route', async () => {
      const seeded = await seedPayment();
      const superAdmin = await createUserWithRole(ctx, 'SUPER_ADMIN');
      for (const caller of [finance, admin, superAdmin]) {
        await overview(caller.accessToken).expect(200);
        await payments(caller.accessToken).expect(200);
        await payment(caller.accessToken, seeded.paymentId).expect(200);
        await refunds(caller.accessToken).expect(200);
      }
    });

    it.each(['CUSTOMER', 'DRIVER', 'PHARMACY_OWNER', 'CUSTOMER_SUPPORT'])('refuses %s on every route', async (role) => {
      const seeded = await seedPayment();
      const caller = await createUserWithRole(ctx, role);
      for (const res of [
        await overview(caller.accessToken),
        await payments(caller.accessToken),
        await payment(caller.accessToken, seeded.paymentId),
        await refunds(caller.accessToken),
      ]) {
        expect(res.status).toBe(403);
        expect(errorOf(res).code).toBe(ErrorCode.FORBIDDEN);
      }
    });

    it('refuses an unauthenticated caller', async () => {
      for (const path of ['/overview', '/payments', `/payments/${randomUUID()}`, '/refunds']) {
        await request(ctx.server).get(`${FINANCE}${path}`).expect(401);
      }
    });
  });

  describe('read-only', () => {
    it('exposes no mutation under /admin/finance that Module 07 does not already own', async () => {
      const seeded = await seedPayment();
      for (const [method, path] of [
        ['post', '/overview'],
        ['post', '/payments'],
        ['post', `/payments/${seeded.paymentId}`],
        ['post', `/payments/${seeded.paymentId}/refund`],
        ['post', `/payments/${seeded.paymentId}/refunds`],
        ['post', `/payments/${seeded.paymentId}/capture`],
        ['post', `/payments/${seeded.paymentId}/void`],
        ['post', '/refunds'],
        ['post', '/cod'],
        ['post', '/payouts'],
        ['put', `/payments/${seeded.paymentId}`],
        ['patch', `/payments/${seeded.paymentId}`],
        ['delete', `/payments/${seeded.paymentId}`],
        ['delete', '/refunds'],
      ] as const) {
        const res = await request(ctx.server)[method](`${FINANCE}${path}`).set(...auth(finance.accessToken)).send({});
        expect({ method, path, status: res.status }).toEqual({ method, path, status: 404 });
      }
      // Nothing moved: the payment stands exactly as captured, with no refund and no ledger delta.
      await expect(ctx.prisma.payment.findUniqueOrThrow({ where: { id: seeded.paymentId } })).resolves.toMatchObject({ status: 'CAPTURED' });
      expect(await ctx.prisma.refund.count()).toBe(0);
    });

    it('reads append no audit entry and change no row', async () => {
      const seeded = await seedPayment();
      await seedRefund(seeded.paymentId, 1_000);
      await seedSettlement(seeded.pharmacyId);
      const before = {
        audits: await ctx.prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } }),
        payments: await ctx.prisma.payment.findMany({ orderBy: { id: 'asc' } }),
        refunds: await ctx.prisma.refund.findMany({ orderBy: { id: 'asc' } }),
        settlements: await ctx.prisma.settlement.findMany({ orderBy: { id: 'asc' } }),
        ledger: await ctx.prisma.ledgerEntry.count(),
      };

      await overview(admin.accessToken).expect(200);
      await payments(admin.accessToken).expect(200);
      await payment(admin.accessToken, seeded.paymentId).expect(200);
      await refunds(admin.accessToken).expect(200);

      expect(await ctx.prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } })).toEqual(before.audits);
      expect(await ctx.prisma.payment.findMany({ orderBy: { id: 'asc' } })).toEqual(before.payments);
      expect(await ctx.prisma.refund.findMany({ orderBy: { id: 'asc' } })).toEqual(before.refunds);
      expect(await ctx.prisma.settlement.findMany({ orderBy: { id: 'asc' } })).toEqual(before.settlements);
      expect(await ctx.prisma.ledgerEntry.count()).toBe(before.ledger);
    });
  });

  describe('existing routes', () => {
    it('leaves Module 07 finance routes answering exactly as before, under their own permissions', async () => {
      const seeded = await seedPayment();
      await seedSettlement(seeded.pharmacyId);
      // Statements stay on Module 07's route under `finance:settlement:any`: finance reads, ADMIN
      // does not — even though ADMIN sees settlement totals on the overview.
      await request(ctx.server).get('/admin/finance/settlements').set(...auth(finance.accessToken)).expect(200);
      await request(ctx.server).get('/admin/finance/settlements').set(...auth(admin.accessToken)).expect(403);
      await request(ctx.server).get('/admin/finance/reconciliation').set(...auth(admin.accessToken)).expect(200);
      // The customer's own read, untouched.
      await request(ctx.server).get(`/payments/${seeded.paymentId}`).set(...auth(seeded.customerToken)).expect(200);
      // Module 07's `/run` still answers 200 and Module 16 wrote no audit entry beside it.
      await seedSettlement(seeded.pharmacyId);
      expect(await ctx.prisma.auditLog.count({ where: { action: { startsWith: 'ADMIN_' } } })).toBe(0);
    });

    it('leaves Module 08 COD routes answering exactly as before', async () => {
      const collectionId = await seedCodCollection();
      await request(ctx.server).get('/admin/delivery/cod-reconciliation').set(...auth(admin.accessToken)).expect(200);
      await request(ctx.server).get(`/admin/delivery/cod-reconciliation/${collectionId}`).set(...auth(admin.accessToken)).expect(200);
      await request(ctx.server).get(`${FINANCE}/cod`).set(...auth(admin.accessToken)).expect(404);
    });
  });

  describe('boundaries', () => {
    it('Module 16 touches no Module 07/08 table, repository, entity, command, query or infrastructure', () => {
      const root = join(__dirname, '..', '..', 'src', 'modules', 'admin');
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          if (statSync(full).isDirectory()) walk(full);
          else if (full.endsWith('.ts') && !full.endsWith('.spec.ts')) files.push(full);
        }
      };
      walk(root);
      expect(files.length).toBeGreaterThan(0);

      for (const file of files) {
        const source = readFileSync(file, 'utf8');
        for (const forbidden of [
          // Module 07 persistence
          'prisma.payment',
          'prisma.refund',
          'prisma.settlement',
          'prisma.payoutLine',
          'prisma.ledger',
          'prisma.accountBalance',
          'prisma.providerWebhook',
          'prisma.coupon',
          'PAYMENT_REPOSITORY',
          'REFUND_REPOSITORY',
          'SETTLEMENT_REPOSITORY',
          'LEDGER_REPOSITORY',
          'payment/domain/',
          'payment/infrastructure/',
          'payment/application/commands/',
          'payment/application/queries/',
          'payment/application/services/',
          // Module 08 persistence
          'prisma.codDispute',
          'prisma.codCollection',
          'prisma.codCorrection',
          'prisma.codRemittance',
          'prisma.codReconciliation',
          'COD_COLLECTION_REPOSITORY',
          'ICodCollectionRepository',
          'delivery/domain/',
          'delivery/infrastructure/',
          'delivery/application/commands/',
          'delivery/application/queries/',
        ]) {
          expect({ file, forbidden, found: source.includes(forbidden) }).toEqual({ file, forbidden, found: false });
        }
      }
    });

    it('Module 16 reaches Modules 07 and 08 only through their inbound ports', () => {
      const root = join(__dirname, '..', '..', 'src', 'modules', 'admin');
      const imports = new Set<string>();
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          if (statSync(full).isDirectory()) walk(full);
          else if (full.endsWith('.ts') && !full.endsWith('.spec.ts')) {
            for (const m of readFileSync(full, 'utf8').matchAll(/from '([^']*(?:payment|delivery)\/[^']*)'/g)) {
              imports.add(m[1].replace(/^(\.\.\/)+/, ''));
            }
          }
        }
      };
      walk(root);
      expect([...imports].sort()).toEqual([
        'delivery/application/ports/inbound/cod-dispute-admin.port',
        'delivery/application/ports/inbound/cod-finance-read.port',
        // Work 08's operational dashboard: job and driver counts, read-only.
        'delivery/application/ports/inbound/delivery-analytics-read.port',
        'delivery/delivery.module',
        'payment/application/ports/inbound/finance-oversight.port',
        'payment/payment.module',
      ]);
    });
  });
});
