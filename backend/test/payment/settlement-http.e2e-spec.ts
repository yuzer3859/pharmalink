import { randomUUID } from 'crypto';
import request from 'supertest';
import { AuthorizePaymentCommand } from '../../src/modules/payment/application/commands/authorize-payment.command';
import { CapturePaymentCommand } from '../../src/modules/payment/application/commands/capture-payment.command';
import {
  RefundInitiator,
  RefundPaymentCommand,
} from '../../src/modules/payment/application/commands/refund-payment.command';
import {
  IPaymentProviderPort,
  PAYMENT_PROVIDER_PORT,
  ProviderAuthorizationRequest,
  ProviderAuthorizationResult,
  ProviderCaptureResult,
  ProviderPaymentOperationRequest,
  ProviderRefundRequest,
  ProviderRefundResult,
  ProviderVoidResult,
} from '../../src/modules/payment/application/ports/outbound/payment-provider.port';
import { PaymentMethod } from '../../src/modules/payment/domain/enums';
import { PricingCalculator } from '../../src/modules/orders/domain/services/pricing-calculator';
import { CONFIG_PORT, IConfigPort } from '../../src/shared/config/config.port';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { createActivatedPharmacy, PharmacyOwnerContext } from '../pharmacy-inventory/support';
import {
  auth,
  body,
  createUserWithRole,
  errorOf,
  RegisteredUser,
  Tokens,
} from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

/**
 * §9.6's settlement HTTP surface end to end: real `AppModule`, real global `JwtAuthGuard` +
 * `PermissionsGuard` with the real RBAC catalog, real `ValidationPipe`, real `AllExceptionsFilter`
 * envelope, real `RunSettlementCommand`/`GetSettlementQuery`/`ListSettlementsQuery`, real
 * `Serializable` transactions, the real append-only ledger and real PostgreSQL.
 *
 * The derivation itself — that a platform-funded coupon pays the pharmacy 10,000 on an 8,450
 * capture, that ADR-016's clawback telescopes — is already proved by `settlement.e2e-spec.ts`.
 * What is proved **here** is that HTTP reaches those figures faithfully, exposes nothing it should
 * not, scopes every read to the caller's own pharmacies, and moves no money.
 *
 * Pharmacies, organizations and role grants are real: `createActivatedPharmacy` registers a
 * `Pharmacy` under an `Organization` and scopes the `PHARMACY_OWNER` grant to it, which is exactly
 * the `user_roles.organizationId` -> `pharmacies.organizationId` chain `ProviderScopeService`
 * walks. A fabricated pharmacy id would have made every scope test pass for the wrong reason.
 */
class FakeGateway implements IPaymentProviderPort {
  readonly key = 'fake-gateway';

  supports(method: PaymentMethod): boolean {
    return method !== PaymentMethod.COD && method !== PaymentMethod.WALLET;
  }
  async authorize(req: ProviderAuthorizationRequest): Promise<ProviderAuthorizationResult> {
    return { outcome: 'AUTHORIZED', providerRef: `gw-auth-${req.paymentId}` };
  }
  async capture(req: ProviderPaymentOperationRequest): Promise<ProviderCaptureResult> {
    return { outcome: 'CAPTURED', providerRef: `gw-capture-${req.paymentId}` };
  }
  async voidAuthorization(req: ProviderPaymentOperationRequest): Promise<ProviderVoidResult> {
    return { outcome: 'VOIDED', providerRef: `gw-void-${req.paymentId}` };
  }
  async refund(req: ProviderRefundRequest): Promise<ProviderRefundResult> {
    return { outcome: 'REFUNDED', providerRef: `gw-refund-${req.refundId}` };
  }
}

const SUBTOTAL = 9_000;
const DELIVERY_FEE = 1_000;
const DISCOUNT = 2_000;
/** round(9,000 x 0.05) at the suite's configured commission. */
const EXPECTED_PLATFORM_FEE = 450;
const EXPECTED_CAPTURE = 8_450;
const EXPECTED_PAYABLE = 10_000;

/** Fixed, because the period is part of the statement's identity — see `settlement.e2e-spec.ts`. */
const PERIOD_START = '2020-01-01T00:00:00.000Z';
const PERIOD_END = '2030-01-01T00:00:00.000Z';

describe('Settlement HTTP API (e2e)', () => {
  let ctx: TestContext;
  let authorize: AuthorizePaymentCommand;
  let capture: CapturePaymentCommand;
  let refund: RefundPaymentCommand;
  let config: IConfigPort;

  let owner: PharmacyOwnerContext;
  let finance: RegisteredUser & Tokens;
  let customer: RegisteredUser & Tokens;

  beforeAll(async () => {
    ctx = await createTestApp([{ provide: PAYMENT_PROVIDER_PORT, useValue: new FakeGateway() }]);
    authorize = ctx.app.get(AuthorizePaymentCommand);
    capture = ctx.app.get(CapturePaymentCommand);
    refund = ctx.app.get(RefundPaymentCommand);
    config = ctx.app.get(CONFIG_PORT);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
    owner = await createActivatedPharmacy(ctx);
    finance = await createUserWithRole(ctx, 'FINANCE_OFFICER');
    customer = await createUserWithRole(ctx, 'CUSTOMER');
  });

  // -------------------------------------------------------------------------------------------
  // Fixtures. Ledger state is built through the real commands; only the settlement surface is
  // exercised over HTTP, because that is what this spec is about.
  // -------------------------------------------------------------------------------------------

  async function seedCapturedOrder(options: {
    pharmacyId: string;
    discountTotal?: number;
  }): Promise<{ paymentId: string; orderId: string }> {
    const totals = PricingCalculator.computeTotals({
      lines: [{ unitPrice: SUBTOTAL, quantity: 1 }],
      deliveryFee: DELIVERY_FEE,
      platformFeePercent: config.get<number>('orders.platformFeePercent') ?? 0,
      discountTotal: options.discountTotal ?? 0,
    });

    const order = await ctx.prisma.order.create({
      data: {
        orderNumber: `ORD-${randomUUID()}`,
        customerUserId: customer.userId,
        status: 'PENDING_PAYMENT',
        subtotal: totals.subtotal,
        deliveryFee: totals.deliveryFee,
        platformFee: totals.platformFee,
        discountTotal: totals.discountTotal,
        grandTotal: totals.grandTotal,
        currency: totals.currency,
        idempotencyKey: `checkout-${randomUUID()}`,
        isCod: false,
      },
    });
    await ctx.prisma.fulfillment.create({
      data: {
        orderId: order.id,
        pharmacyId: options.pharmacyId,
        branchId: `branch-${randomUUID()}`,
      },
    });

    const authorized = await authorize.execute({
      customerUserId: customer.userId,
      orderId: order.id,
      method: PaymentMethod.TELEBIRR,
      idempotencyKey: `pay-${randomUUID()}`,
    });
    await capture.execute({ paymentId: authorized.paymentId });

    return { paymentId: authorized.paymentId, orderId: order.id };
  }

  const runBody = (pharmacyId: string) => ({
    pharmacyId,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
  });

  /** Generates a statement the way an operator would: over HTTP, as a finance officer. */
  async function runAs(token: string, pharmacyId: string, expected = 200) {
    return request(ctx.server)
      .post('/admin/finance/settlements/run')
      .set(...auth(token))
      .send(runBody(pharmacyId))
      .expect(expected);
  }

  function settlementIdOf(res: request.Response): string {
    return (body(res).settlement as Record<string, unknown>).settlementId as string;
  }

  async function ledgerCounts() {
    const [transactions, entries] = await Promise.all([
      ctx.prisma.ledgerTransaction.count(),
      ctx.prisma.ledgerEntry.count(),
    ]);
    return { transactions, entries };
  }

  // -------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------

  it('lists a provider’s own statements with every figure kept separate', async () => {
    await seedCapturedOrder({ pharmacyId: owner.pharmacyId });
    await runAs(finance.accessToken, owner.pharmacyId);

    const page = body(
      await request(ctx.server)
        .get('/settlements')
        .set(...auth(owner.accessToken))
        .expect(200),
    );

    expect(page).toMatchObject({ total: 1, page: 1, size: 20 });
    const [statement] = page.items as Record<string, unknown>[];
    expect(statement).toMatchObject({
      pharmacyId: owner.pharmacyId,
      currency: 'ETB',
      providerPayableGross: EXPECTED_PAYABLE,
      refundClawback: 0,
      netPayable: EXPECTED_PAYABLE,
      platformRevenue: EXPECTED_PLATFORM_FEE,
      promotionExpense: 0,
      customerCashCollected: 10_450,
      lineCount: 1,
      status: 'DRAFT',
    });
    expect(typeof statement.settlementId).toBe('string');
    expect(statement.statementRef).toMatch(/^STL-/);
    expect(statement.createdAt).toBeDefined();
    // A list is not a statement.
    expect(statement).not.toHaveProperty('lines');
    // Approval/payout is not implemented, so a `paidAt` that could only ever say `null` would
    // advertise a lifecycle this module does not have.
    expect(statement).not.toHaveProperty('paidAt');
  });

  it('returns the statement with its lines, each naming the posting it reports', async () => {
    const seeded = await seedCapturedOrder({ pharmacyId: owner.pharmacyId });
    const settlementId = settlementIdOf(await runAs(finance.accessToken, owner.pharmacyId));

    const detail = body(
      await request(ctx.server)
        .get(`/settlements/${settlementId}`)
        .set(...auth(owner.accessToken))
        .expect(200),
    );

    expect(detail).toMatchObject({ settlementId, netPayable: EXPECTED_PAYABLE, lineCount: 1 });
    const lines = detail.lines as Record<string, unknown>[];
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      ledgerReference: `CAPTURE-${seeded.paymentId}`,
      transactionType: 'CAPTURE',
      orderId: seeded.orderId,
      providerPayableDelta: EXPECTED_PAYABLE,
      platformRevenueDelta: EXPECTED_PLATFORM_FEE,
      promotionExpenseDelta: 0,
      customerCashDelta: 10_450,
    });
    // The business reference is the handle; primary keys are not exposed.
    expect(lines[0]).not.toHaveProperty('id');
    expect(lines[0]).not.toHaveProperty('settlementId');
    expect(lines[0]).not.toHaveProperty('ledgerTransactionId');
  });

  it('shows a platform-funded coupon as promotion expense, not as a smaller payable', async () => {
    await seedCapturedOrder({ pharmacyId: owner.pharmacyId, discountTotal: DISCOUNT });
    await runAs(finance.accessToken, owner.pharmacyId);

    const page = body(
      await request(ctx.server)
        .get('/settlements')
        .set(...auth(owner.accessToken))
        .expect(200),
    );

    const [statement] = page.items as Record<string, number>[];
    // The customer paid 8,450; the pharmacy is owed 10,000. The 2,000 difference is the
    // platform's, and it is visible as its own figure rather than folded into the payable.
    expect(statement.customerCashCollected).toBe(EXPECTED_CAPTURE);
    expect(statement.netPayable).toBe(EXPECTED_PAYABLE);
    expect(statement.promotionExpense).toBe(DISCOUNT);
    expect(statement.platformRevenue).toBe(EXPECTED_PLATFORM_FEE);
    expect(statement.netPayable).toBeGreaterThan(statement.customerCashCollected);
  });

  it('reflects a full refund — the payable returns to zero', async () => {
    const seeded = await seedCapturedOrder({ pharmacyId: owner.pharmacyId });
    await refund.execute({
      paymentId: seeded.paymentId,
      idempotencyKey: `refund-${randomUUID()}`,
      initiator: RefundInitiator.MANUAL,
      actorUserId: finance.userId,
      actorPermissions: ['finance:refund:any'],
      reason: 'Order cancelled before delivery',
    });
    await runAs(finance.accessToken, owner.pharmacyId);

    const page = body(
      await request(ctx.server)
        .get('/settlements')
        .set(...auth(owner.accessToken))
        .expect(200),
    );

    expect(page.items).toHaveLength(1);
    expect((page.items as Record<string, number>[])[0]).toMatchObject({
      providerPayableGross: EXPECTED_PAYABLE,
      refundClawback: EXPECTED_PAYABLE,
      netPayable: 0,
      platformRevenue: 0,
      customerCashCollected: 0,
      lineCount: 2,
    });
  });

  it('reflects a partial refund at the amount the refund actually posted', async () => {
    const seeded = await seedCapturedOrder({
      pharmacyId: owner.pharmacyId,
      discountTotal: DISCOUNT,
    });
    await refund.execute({
      paymentId: seeded.paymentId,
      amount: 2_000,
      idempotencyKey: `refund-${randomUUID()}`,
      initiator: RefundInitiator.MANUAL,
      actorUserId: finance.userId,
      actorPermissions: ['finance:refund:any'],
      reason: 'Two items out of stock',
    });
    const settlementId = settlementIdOf(await runAs(finance.accessToken, owner.pharmacyId));

    const detail = body(
      await request(ctx.server)
        .get(`/settlements/${settlementId}`)
        .set(...auth(owner.accessToken))
        .expect(200),
    );

    // ADR-016's cumulative clawback on a 2,000 refund of an 8,450 capture: fee 107, promotion 473,
    // so the payable gives back 2,366 — not the 2,000 the customer got back, and not a proportion
    // the settlement recomputed for itself.
    expect(detail).toMatchObject({
      providerPayableGross: EXPECTED_PAYABLE,
      refundClawback: 2_366,
      netPayable: 7_634,
      platformRevenue: 343,
      promotionExpense: 1_527,
      lineCount: 2,
    });
    const refundLine = (detail.lines as Record<string, unknown>[]).find(
      (line) => line.transactionType === 'REFUND',
    );
    expect(refundLine).toMatchObject({ providerPayableDelta: -2_366 });
  });

  // -------------------------------------------------------------------------------------------
  // Scope
  // -------------------------------------------------------------------------------------------

  it('does not let one provider read another provider’s statement', async () => {
    const other = await createActivatedPharmacy(ctx);
    await seedCapturedOrder({ pharmacyId: other.pharmacyId });
    const settlementId = settlementIdOf(await runAs(finance.accessToken, other.pharmacyId));

    // Not `RBAC_FORBIDDEN` — a statement outside the caller's scope is indistinguishable from one
    // that does not exist, so ids cannot be probed.
    const res = await request(ctx.server)
      .get(`/settlements/${settlementId}`)
      .set(...auth(owner.accessToken))
      .expect(404);
    expect(errorOf(res).code).toBe(ErrorCode.NOT_FOUND);

    // And it is not reachable through the list either, with or without a filter naming it.
    const page = body(
      await request(ctx.server)
        .get('/settlements')
        .set(...auth(owner.accessToken))
        .expect(200),
    );
    expect(page).toMatchObject({ items: [], total: 0 });

    const filtered = body(
      await request(ctx.server)
        .get('/settlements')
        .query({ pharmacyId: other.pharmacyId })
        .set(...auth(owner.accessToken))
        .expect(200),
    );
    expect(filtered).toMatchObject({ items: [], total: 0 });
  });

  it('refuses a customer, who holds no settlement permission at all', async () => {
    await seedCapturedOrder({ pharmacyId: owner.pharmacyId });
    const settlementId = settlementIdOf(await runAs(finance.accessToken, owner.pharmacyId));

    for (const path of ['/settlements', `/settlements/${settlementId}`]) {
      const res = await request(ctx.server)
        .get(path)
        .set(...auth(customer.accessToken))
        .expect(403);
      expect(errorOf(res).code).toBe(ErrorCode.FORBIDDEN);
    }
  });

  it('requires authentication', async () => {
    await request(ctx.server).get('/settlements').expect(401);
    await request(ctx.server).post('/admin/finance/settlements/run').send(runBody('x')).expect(401);
  });

  it('filters by currency, status and period without widening scope', async () => {
    await seedCapturedOrder({ pharmacyId: owner.pharmacyId });
    await runAs(finance.accessToken, owner.pharmacyId);

    const listWith = async (query: Record<string, string>) =>
      body(
        await request(ctx.server)
          .get('/settlements')
          .query(query)
          .set(...auth(owner.accessToken))
          .expect(200),
      );

    expect(await listWith({ currency: 'ETB' })).toMatchObject({ total: 1 });
    expect(await listWith({ currency: 'etb' })).toMatchObject({ total: 1 });
    expect(await listWith({ currency: 'USD' })).toMatchObject({ total: 0 });
    expect(await listWith({ status: 'DRAFT' })).toMatchObject({ total: 1 });
    expect(await listWith({ status: 'PAID' })).toMatchObject({ total: 0 });
    expect(await listWith({ from: PERIOD_START, to: PERIOD_END })).toMatchObject({ total: 1 });
    expect(await listWith({ from: '2025-01-01T00:00:00.000Z' })).toMatchObject({ total: 0 });
  });

  it('rejects an unknown filter and a malformed one', async () => {
    await request(ctx.server)
      .get('/settlements')
      .query({ organizationId: owner.organizationId })
      .set(...auth(owner.accessToken))
      .expect(400);

    await request(ctx.server)
      .get('/settlements')
      .query({ status: 'SETTLED' })
      .set(...auth(owner.accessToken))
      .expect(400);
  });

  // -------------------------------------------------------------------------------------------
  // Generation
  // -------------------------------------------------------------------------------------------

  it('refuses settlement generation to a pharmacy owner and to a customer', async () => {
    await seedCapturedOrder({ pharmacyId: owner.pharmacyId });

    for (const token of [owner.accessToken, customer.accessToken]) {
      const res = await runAs(token, owner.pharmacyId, 403);
      expect(errorOf(res).code).toBe(ErrorCode.FORBIDDEN);
    }
    expect(await ctx.prisma.settlement.count()).toBe(0);
  });

  it('replays the same statement on a repeated run rather than duplicating it', async () => {
    await seedCapturedOrder({ pharmacyId: owner.pharmacyId });

    const first = body(await runAs(finance.accessToken, owner.pharmacyId));
    const second = body(await runAs(finance.accessToken, owner.pharmacyId));

    expect(first.replay).toBe(false);
    expect(second.replay).toBe(true);
    expect(second.settlement).toEqual(first.settlement);
    expect(await ctx.prisma.settlement.count()).toBe(1);
    expect(await ctx.prisma.payoutLine.count()).toBe(1);
  });

  it('converges on one statement when identical runs arrive concurrently', async () => {
    await seedCapturedOrder({ pharmacyId: owner.pharmacyId });

    const results = await Promise.all([
      runAs(finance.accessToken, owner.pharmacyId),
      runAs(finance.accessToken, owner.pharmacyId),
      runAs(finance.accessToken, owner.pharmacyId),
    ]);

    expect(new Set(results.map(settlementIdOf)).size).toBe(1);
    expect(await ctx.prisma.settlement.count()).toBe(1);
  });

  it('creates no ledger transaction, no entry and no payout', async () => {
    await seedCapturedOrder({ pharmacyId: owner.pharmacyId, discountTotal: DISCOUNT });
    const before = await ledgerCounts();

    await runAs(finance.accessToken, owner.pharmacyId);
    await runAs(finance.accessToken, owner.pharmacyId);

    expect(await ledgerCounts()).toEqual(before);
    // Specifically: §11.5's payout posting was never written, and the statement stays DRAFT —
    // there is no approve or pay route to move it, by design.
    expect(await ctx.prisma.ledgerTransaction.count({ where: { type: 'SETTLEMENT' } })).toBe(0);
    const statements = await ctx.prisma.settlement.findMany();
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatchObject({ status: 'DRAFT', paidAt: null });
  });

  it('records who generated the statement', async () => {
    await seedCapturedOrder({ pharmacyId: owner.pharmacyId });
    await runAs(finance.accessToken, owner.pharmacyId);

    const entries = await ctx.prisma.auditLog.findMany({
      where: { action: 'SETTLEMENT_GENERATED' },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].actorUserId).toBe(finance.userId);
  });

  it('rejects a run whose period is inverted, before any statement is written', async () => {
    await seedCapturedOrder({ pharmacyId: owner.pharmacyId });

    const res = await request(ctx.server)
      .post('/admin/finance/settlements/run')
      .set(...auth(finance.accessToken))
      .send({ pharmacyId: owner.pharmacyId, periodStart: PERIOD_END, periodEnd: PERIOD_START })
      .expect(400);

    expect(errorOf(res).code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(await ctx.prisma.settlement.count()).toBe(0);
  });

  // -------------------------------------------------------------------------------------------
  // Finance-admin reads. Same queries, same mappers, no provider scope — `finance:settlement:any`
  // is platform authority, and a finance officer narrowed to the pharmacies they happen to own
  // would see nothing at all.
  // -------------------------------------------------------------------------------------------

  describe('GET /admin/finance/settlements', () => {
    const adminList = (token: string, query: Record<string, string> = {}) =>
      request(ctx.server)
        .get('/admin/finance/settlements')
        .query(query)
        .set(...auth(token));

    const adminDetail = (token: string, id: string) =>
      request(ctx.server)
        .get(`/admin/finance/settlements/${id}`)
        .set(...auth(token));

    it('lists every provider’s statements, not only one org’s', async () => {
      const other = await createActivatedPharmacy(ctx);
      await seedCapturedOrder({ pharmacyId: owner.pharmacyId });
      await seedCapturedOrder({ pharmacyId: other.pharmacyId });
      await runAs(finance.accessToken, owner.pharmacyId);
      await runAs(finance.accessToken, other.pharmacyId);

      const page = body(await adminList(finance.accessToken).expect(200));

      expect(page).toMatchObject({ total: 2, page: 1, size: 20 });
      const pharmacyIds = (page.items as Record<string, string>[]).map((i) => i.pharmacyId).sort();
      expect(pharmacyIds).toEqual([owner.pharmacyId, other.pharmacyId].sort());
      // The finance officer belongs to no organization at all; were provider scoping applied
      // here by accident, this page would be empty.
      expect(page.total).not.toBe(0);
    });

    it('returns the same summary fields as the provider route', async () => {
      await seedCapturedOrder({ pharmacyId: owner.pharmacyId });
      await runAs(finance.accessToken, owner.pharmacyId);

      const mine = body(
        await request(ctx.server)
          .get('/settlements')
          .set(...auth(owner.accessToken))
          .expect(200),
      );
      const theirs = body(await adminList(finance.accessToken).expect(200));

      expect(theirs.items).toEqual(mine.items);
      expect((theirs.items as Record<string, unknown>[])[0]).not.toHaveProperty('lines');
      expect((theirs.items as Record<string, unknown>[])[0]).not.toHaveProperty('paidAt');
    });

    it('applies the same filters', async () => {
      const other = await createActivatedPharmacy(ctx);
      await seedCapturedOrder({ pharmacyId: owner.pharmacyId });
      await seedCapturedOrder({ pharmacyId: other.pharmacyId });
      await runAs(finance.accessToken, owner.pharmacyId);
      await runAs(finance.accessToken, other.pharmacyId);

      const filtered = async (query: Record<string, string>) =>
        body(await adminList(finance.accessToken, query).expect(200));

      expect(await filtered({ pharmacyId: other.pharmacyId })).toMatchObject({ total: 1 });
      expect(await filtered({ currency: 'ETB' })).toMatchObject({ total: 2 });
      expect(await filtered({ currency: 'USD' })).toMatchObject({ total: 0 });
      expect(await filtered({ status: 'DRAFT' })).toMatchObject({ total: 2 });
      expect(await filtered({ status: 'PAID' })).toMatchObject({ total: 0 });
      expect(await filtered({ from: PERIOD_START, to: PERIOD_END })).toMatchObject({ total: 2 });
      expect(await filtered({ size: '1' })).toMatchObject({ total: 2, size: 1 });
      await adminList(finance.accessToken, { organizationId: owner.organizationId }).expect(400);
    });

    it('retrieves any provider’s statement with its lines', async () => {
      const seeded = await seedCapturedOrder({ pharmacyId: owner.pharmacyId });
      const settlementId = settlementIdOf(await runAs(finance.accessToken, owner.pharmacyId));

      const detail = body(await adminDetail(finance.accessToken, settlementId).expect(200));

      expect(detail).toMatchObject({
        settlementId,
        pharmacyId: owner.pharmacyId,
        netPayable: EXPECTED_PAYABLE,
        lineCount: 1,
      });
      const lines = detail.lines as Record<string, unknown>[];
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ ledgerReference: `CAPTURE-${seeded.paymentId}` });
      // The same allow-list mapper: business references, never primary keys.
      expect(lines[0]).not.toHaveProperty('id');
      expect(lines[0]).not.toHaveProperty('settlementId');
      expect(lines[0]).not.toHaveProperty('ledgerTransactionId');
    });

    it('keeps the four figures of a platform-funded coupon separate', async () => {
      await seedCapturedOrder({ pharmacyId: owner.pharmacyId, discountTotal: DISCOUNT });
      const settlementId = settlementIdOf(await runAs(finance.accessToken, owner.pharmacyId));

      const detail = body(await adminDetail(finance.accessToken, settlementId).expect(200));

      expect(detail).toMatchObject({
        providerPayableGross: EXPECTED_PAYABLE,
        netPayable: EXPECTED_PAYABLE,
        platformRevenue: EXPECTED_PLATFORM_FEE,
        promotionExpense: DISCOUNT,
        customerCashCollected: EXPECTED_CAPTURE,
      });
      expect(detail.netPayable as number).toBeGreaterThan(detail.customerCashCollected as number);
    });

    it('reports full and partial refunds at the values the ledger posted', async () => {
      const full = await seedCapturedOrder({ pharmacyId: owner.pharmacyId });
      await refund.execute({
        paymentId: full.paymentId,
        idempotencyKey: `refund-${randomUUID()}`,
        initiator: RefundInitiator.MANUAL,
        actorUserId: finance.userId,
        actorPermissions: ['finance:refund:any'],
        reason: 'Order cancelled before delivery',
      });
      const fullId = settlementIdOf(await runAs(finance.accessToken, owner.pharmacyId));

      expect(body(await adminDetail(finance.accessToken, fullId).expect(200))).toMatchObject({
        providerPayableGross: EXPECTED_PAYABLE,
        refundClawback: EXPECTED_PAYABLE,
        netPayable: 0,
        platformRevenue: 0,
        customerCashCollected: 0,
      });

      const partialPharmacy = await createActivatedPharmacy(ctx);
      const partial = await seedCapturedOrder({
        pharmacyId: partialPharmacy.pharmacyId,
        discountTotal: DISCOUNT,
      });
      await refund.execute({
        paymentId: partial.paymentId,
        amount: 2_000,
        idempotencyKey: `refund-${randomUUID()}`,
        initiator: RefundInitiator.MANUAL,
        actorUserId: finance.userId,
        actorPermissions: ['finance:refund:any'],
        reason: 'Two items out of stock',
      });
      const partialId = settlementIdOf(
        await runAs(finance.accessToken, partialPharmacy.pharmacyId),
      );

      // ADR-016's cumulative clawback, unchanged by the route it is read through.
      expect(body(await adminDetail(finance.accessToken, partialId).expect(200))).toMatchObject({
        refundClawback: 2_366,
        netPayable: 7_634,
        platformRevenue: 343,
        promotionExpense: 1_527,
      });
    });

    it('answers NOT_FOUND for an unknown id', async () => {
      const res = await adminDetail(finance.accessToken, randomUUID()).expect(404);
      expect(errorOf(res).code).toBe(ErrorCode.NOT_FOUND);
    });

    // -----------------------------------------------------------------------------------------
    // Authorization, read off the actual catalog rather than assumed.
    // -----------------------------------------------------------------------------------------

    it('allows a super admin through the existing wildcard', async () => {
      await seedCapturedOrder({ pharmacyId: owner.pharmacyId });
      const settlementId = settlementIdOf(await runAs(finance.accessToken, owner.pharmacyId));
      const superAdmin = await createUserWithRole(ctx, 'SUPER_ADMIN');

      await adminList(superAdmin.accessToken).expect(200);
      await adminDetail(superAdmin.accessToken, settlementId).expect(200);
    });

    it('refuses an ADMIN, which does not hold finance:settlement:any in the catalog', async () => {
      await seedCapturedOrder({ pharmacyId: owner.pharmacyId });
      const settlementId = settlementIdOf(await runAs(finance.accessToken, owner.pharmacyId));
      const admin = await createUserWithRole(ctx, 'ADMIN');

      // ADMIN holds `finance:report:any` (reconciliation) but not the settlement permission —
      // the catalog's existing split between platform administration and finance authority.
      const res = await adminList(admin.accessToken).expect(403);
      expect(errorOf(res).code).toBe(ErrorCode.FORBIDDEN);
      await adminDetail(admin.accessToken, settlementId).expect(403);
    });

    it('refuses a customer and a pharmacy owner', async () => {
      await seedCapturedOrder({ pharmacyId: owner.pharmacyId });
      const settlementId = settlementIdOf(await runAs(finance.accessToken, owner.pharmacyId));

      for (const token of [customer.accessToken, owner.accessToken]) {
        const res = await adminList(token).expect(403);
        expect(errorOf(res).code).toBe(ErrorCode.FORBIDDEN);
        await adminDetail(token, settlementId).expect(403);
      }

      // The owner keeps their own provider-scoped view; only the finance surface is closed.
      await request(ctx.server)
        .get('/settlements')
        .set(...auth(owner.accessToken))
        .expect(200);
    });

    it('requires authentication', async () => {
      await request(ctx.server).get('/admin/finance/settlements').expect(401);
      await request(ctx.server).get(`/admin/finance/settlements/${randomUUID()}`).expect(401);
    });

    // -----------------------------------------------------------------------------------------
    // Read-only
    // -----------------------------------------------------------------------------------------

    it('writes no ledger row and changes no settlement state', async () => {
      await seedCapturedOrder({ pharmacyId: owner.pharmacyId, discountTotal: DISCOUNT });
      const settlementId = settlementIdOf(await runAs(finance.accessToken, owner.pharmacyId));
      const before = await ledgerCounts();
      const settlementsBefore = await ctx.prisma.settlement.findMany({ orderBy: { id: 'asc' } });
      const linesBefore = await ctx.prisma.payoutLine.findMany({ orderBy: { id: 'asc' } });

      await adminList(finance.accessToken).expect(200);
      await adminDetail(finance.accessToken, settlementId).expect(200);
      await adminDetail(finance.accessToken, settlementId).expect(200);

      expect(await ledgerCounts()).toEqual(before);
      expect(await ctx.prisma.ledgerTransaction.count({ where: { type: 'SETTLEMENT' } })).toBe(0);
      // Whole rows: an accidental status flip or a `paidAt` stamp would not change any count.
      expect(await ctx.prisma.settlement.findMany({ orderBy: { id: 'asc' } })).toEqual(
        settlementsBefore,
      );
      expect(await ctx.prisma.payoutLine.findMany({ orderBy: { id: 'asc' } })).toEqual(linesBefore);
      expect(settlementsBefore.every((row) => row.status === 'DRAFT' && row.paidAt === null)).toBe(
        true,
      );
    });
  });
});
