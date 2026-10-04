import { randomUUID } from 'crypto';
import request from 'supertest';
import { AuthorizePaymentCommand } from '../../src/modules/payment/application/commands/authorize-payment.command';
import { CapturePaymentCommand } from '../../src/modules/payment/application/commands/capture-payment.command';
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
import {
  DEFAULT_CAPTURED_PAYMENT_LIMIT,
  SETTLEMENT_SCAN_LIMIT,
} from '../../src/modules/payment/application/services/accounting-reconciliation.service';
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
 * §9.6's `GET /admin/finance/reconciliation` end to end: real `AppModule`, real global
 * `JwtAuthGuard` + `PermissionsGuard` with the real RBAC catalog, real `ValidationPipe`, real
 * `AllExceptionsFilter` envelope, the real `AccountingReconciliationService`, the real append-only
 * ledger and real PostgreSQL.
 *
 * Two claims are under test here, and they are different in kind.
 *
 *  1. **The endpoint tells an operator what broke and where** — a code, a description, and the
 *     identifiers to go and look at. Not a boolean.
 *  2. **The endpoint changes nothing.** Reconciliation exists because the books can disagree with
 *     themselves, and the temptation with such a tool is to have it tidy up. It must not: a repair
 *     is a guess about which side is right, written into a ledger that cannot take it back. The
 *     mutation tests below snapshot every ledger row and every settlement row around repeated
 *     calls and compare them whole.
 *
 * The broken fixtures are built by writing the *non-ledger* side out of agreement — a payment
 * marked `CAPTURED` that never was, a statement header edited away from its own lines. That is
 * deliberate: the ledger is append-only and reconciliation's job is to notice the disagreement,
 * whichever side caused it.
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
const PERIOD_START = '2020-01-01T00:00:00.000Z';
const PERIOD_END = '2030-01-01T00:00:00.000Z';

/** Exactly the keys the response contract promises for one discrepancy — nothing more. */
const DISCREPANCY_KEYS = [
  'code',
  'description',
  'subject',
  'subjectType',
  'paymentId',
  'settlementId',
  'relatedSettlementIds',
  'ledgerReferences',
  'amount',
  'currency',
  'figures',
].sort();

describe('Reconciliation HTTP API (e2e)', () => {
  let ctx: TestContext;
  let authorize: AuthorizePaymentCommand;
  let capture: CapturePaymentCommand;
  let config: IConfigPort;

  let owner: PharmacyOwnerContext;
  let finance: RegisteredUser & Tokens;
  let customer: RegisteredUser & Tokens;

  beforeAll(async () => {
    ctx = await createTestApp([{ provide: PAYMENT_PROVIDER_PORT, useValue: new FakeGateway() }]);
    authorize = ctx.app.get(AuthorizePaymentCommand);
    capture = ctx.app.get(CapturePaymentCommand);
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
  // Fixtures
  // -------------------------------------------------------------------------------------------

  async function seedOrder(pharmacyId: string): Promise<{ paymentId: string; orderId: string }> {
    const totals = PricingCalculator.computeTotals({
      lines: [{ unitPrice: SUBTOTAL, quantity: 1 }],
      deliveryFee: DELIVERY_FEE,
      platformFeePercent: config.get<number>('orders.platformFeePercent') ?? 0,
      discountTotal: 0,
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
      data: { orderId: order.id, pharmacyId, branchId: `branch-${randomUUID()}` },
    });

    const authorized = await authorize.execute({
      customerUserId: customer.userId,
      orderId: order.id,
      method: PaymentMethod.TELEBIRR,
      idempotencyKey: `pay-${randomUUID()}`,
    });
    return { paymentId: authorized.paymentId, orderId: order.id };
  }

  /** One healthy captured order and one statement covering it — books that agree. */
  async function seedHealthyBooks(): Promise<{ paymentId: string; settlementId: string }> {
    const seeded = await seedOrder(owner.pharmacyId);
    await capture.execute({ paymentId: seeded.paymentId });
    const run = body(
      await request(ctx.server)
        .post('/admin/finance/settlements/run')
        .set(...auth(finance.accessToken))
        .send({
          pharmacyId: owner.pharmacyId,
          periodStart: PERIOD_START,
          periodEnd: PERIOD_END,
        })
        .expect(200),
    );
    return {
      paymentId: seeded.paymentId,
      settlementId: (run.settlement as Record<string, unknown>).settlementId as string,
    };
  }

  /**
   * A payment marked `CAPTURED` that never went through `CapturePaymentCommand` — the shape a
   * crash between the gateway call and the ledger write would leave. The ledger is not touched.
   */
  async function seedPaymentWithoutPosting(): Promise<string> {
    const orphan = await seedOrder(owner.pharmacyId);
    await ctx.prisma.payment.update({
      where: { id: orphan.paymentId },
      data: { status: 'CAPTURED', capturedAt: new Date() },
    });
    return orphan.paymentId;
  }

  const getReport = async (token: string, query: Record<string, string> = {}) =>
    body(
      await request(ctx.server)
        .get('/admin/finance/reconciliation')
        .query(query)
        .set(...auth(token))
        .expect(200),
    );

  /** Every ledger and settlement row, ordered, for a whole-snapshot comparison. */
  async function snapshot() {
    const [transactions, entries, settlements, lines] = await Promise.all([
      ctx.prisma.ledgerTransaction.findMany({ orderBy: { id: 'asc' } }),
      ctx.prisma.ledgerEntry.findMany({ orderBy: { id: 'asc' } }),
      ctx.prisma.settlement.findMany({ orderBy: { id: 'asc' } }),
      ctx.prisma.payoutLine.findMany({ orderBy: { id: 'asc' } }),
    ]);
    return { transactions, entries, settlements, lines };
  }

  const discrepancies = (report: Record<string, unknown>) =>
    report.discrepancies as Record<string, unknown>[];

  /** Every property name in the payload, at every depth. */
  function allKeys(value: unknown, found: string[] = []): string[] {
    if (Array.isArray(value)) {
      value.forEach((item) => allKeys(item, found));
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, child] of Object.entries(value)) {
        found.push(key);
        allKeys(child, found);
      }
    }
    return found;
  }

  // -------------------------------------------------------------------------------------------
  // Authorization
  // -------------------------------------------------------------------------------------------

  it('refuses a customer', async () => {
    const res = await request(ctx.server)
      .get('/admin/finance/reconciliation')
      .set(...auth(customer.accessToken))
      .expect(403);
    expect(errorOf(res).code).toBe(ErrorCode.FORBIDDEN);
  });

  it('refuses a pharmacy owner — platform-wide reconciliation is not a provider view', async () => {
    // The owner holds `settlement:read:org` and can read their own statements; that permission
    // deliberately does not reach a report about the whole ledger.
    await request(ctx.server)
      .get('/settlements')
      .set(...auth(owner.accessToken))
      .expect(200);

    const res = await request(ctx.server)
      .get('/admin/finance/reconciliation')
      .set(...auth(owner.accessToken))
      .expect(403);
    expect(errorOf(res).code).toBe(ErrorCode.FORBIDDEN);

    // Not even for their own pharmacy.
    await request(ctx.server)
      .get('/admin/finance/reconciliation')
      .query({ pharmacyId: owner.pharmacyId })
      .set(...auth(owner.accessToken))
      .expect(403);
  });

  it('allows a finance officer, and an admin, from the existing catalog grants', async () => {
    const admin = await createUserWithRole(ctx, 'ADMIN');
    const superAdmin = await createUserWithRole(ctx, 'SUPER_ADMIN');

    for (const token of [finance.accessToken, admin.accessToken, superAdmin.accessToken]) {
      await request(ctx.server)
        .get('/admin/finance/reconciliation')
        .set(...auth(token))
        .expect(200);
    }
  });

  it('requires authentication', async () => {
    await request(ctx.server).get('/admin/finance/reconciliation').expect(401);
  });

  // -------------------------------------------------------------------------------------------
  // Clean books
  // -------------------------------------------------------------------------------------------

  it('reports zero discrepancies when capture, ledger and statement agree', async () => {
    await seedHealthyBooks();

    const report = await getReport(finance.accessToken);

    expect(report).toMatchObject({ status: 'CLEAN', discrepancyCount: 0, discrepancies: [] });
    expect(typeof report.checkedAt).toBe('string');
    // "Nothing found" is only meaningful beside "across this much" — an empty report must be
    // distinguishable from an empty database.
    expect(report.scope).toMatchObject({
      pharmacyId: null,
      settlementChecksScoped: false,
      capturedPaymentsExamined: 1,
      capturedPaymentLimit: DEFAULT_CAPTURED_PAYMENT_LIMIT,
      settlementsExamined: 1,
      settlementScanLimit: SETTLEMENT_SCAN_LIMIT,
      settlementLinesExamined: 1,
      currenciesExamined: 1,
      truncated: false,
    });
  });

  it('reports the scope it was actually given', async () => {
    await seedHealthyBooks();

    const scoped = await getReport(finance.accessToken, {
      pharmacyId: owner.pharmacyId,
      limit: '10',
    });

    expect(scoped.scope).toMatchObject({
      pharmacyId: owner.pharmacyId,
      settlementChecksScoped: true,
      capturedPaymentLimit: 10,
    });
  });

  // -------------------------------------------------------------------------------------------
  // Discrepancies
  // -------------------------------------------------------------------------------------------

  it('returns a CAPTURE_POSTING_MISSING discrepancy with the identifiers to chase it', async () => {
    const healthy = await seedHealthyBooks();
    const orphanId = await seedPaymentWithoutPosting();

    const report = await getReport(finance.accessToken);

    expect(report).toMatchObject({ status: 'DISCREPANCIES_FOUND', discrepancyCount: 1 });
    const [found] = discrepancies(report);
    expect(found).toMatchObject({
      code: 'CAPTURE_POSTING_MISSING',
      subject: orphanId,
      subjectType: 'PAYMENT',
      paymentId: orphanId,
      settlementId: null,
      relatedSettlementIds: [],
      ledgerReferences: [`CAPTURE-${orphanId}`],
      amount: 10_450,
      currency: 'ETB',
    });
    expect(found.description).toContain(orphanId);
    // The healthy payment beside it is not implicated.
    expect(found.paymentId).not.toBe(healthy.paymentId);
  });

  it('returns a SETTLEMENT_TOTAL_MISMATCH when a statement stops matching its own lines', async () => {
    const healthy = await seedHealthyBooks();

    // Edit the statement header away from its lines. `netAmount = grossAmount - refundClawback` is
    // a CHECK constraint, so both move together — the corruption is the header against the ledger
    // and against its own lines, not a self-inconsistent row the database would have refused.
    await ctx.prisma.settlement.update({
      where: { id: healthy.settlementId },
      data: { grossAmount: 11_000, netAmount: 11_000 },
    });

    const report = await getReport(finance.accessToken);

    const mismatches = discrepancies(report).filter(
      (item) => item.code === 'SETTLEMENT_TOTAL_MISMATCH',
    );
    expect(mismatches.length).toBeGreaterThan(0);
    expect(mismatches[0]).toMatchObject({
      subject: healthy.settlementId,
      subjectType: 'SETTLEMENT',
      settlementId: healthy.settlementId,
    });
    // The figures are the point: an operator must see 11,000 against the 10,000 the ledger holds.
    const figures = mismatches[0].figures as Record<string, number>;
    expect(figures.stored).toBe(11_000);
    expect(Object.values(figures)).toContain(10_000);
  });

  it('does not collapse several discrepancies into one', async () => {
    const healthy = await seedHealthyBooks();
    await seedPaymentWithoutPosting();
    await ctx.prisma.settlement.update({
      where: { id: healthy.settlementId },
      data: { grossAmount: 11_000, netAmount: 11_000 },
    });

    const report = await getReport(finance.accessToken);

    const codes = discrepancies(report).map((item) => item.code);
    expect(codes).toContain('CAPTURE_POSTING_MISSING');
    expect(codes).toContain('SETTLEMENT_TOTAL_MISMATCH');
    expect(report.discrepancyCount).toBe(discrepancies(report).length);
    expect(report.discrepancyCount as number).toBeGreaterThan(1);
  });

  // -------------------------------------------------------------------------------------------
  // Read-only
  // -------------------------------------------------------------------------------------------

  it('mutates no ledger row and no settlement row, on clean or broken books', async () => {
    const healthy = await seedHealthyBooks();
    await seedPaymentWithoutPosting();
    await ctx.prisma.settlement.update({
      where: { id: healthy.settlementId },
      data: { grossAmount: 11_000, netAmount: 11_000 },
    });
    const before = await snapshot();

    const first = await getReport(finance.accessToken);
    const second = await getReport(finance.accessToken);
    await getReport(finance.accessToken, { pharmacyId: owner.pharmacyId });

    // Whole rows, not counts: a repair would show up as an edited amount or a flipped status just
    // as readily as a new row, and neither must happen.
    expect(await snapshot()).toEqual(before);
    // Repeated calls are safe and answer the same thing — the anomaly is still there, unrepaired.
    expect(second.discrepancies).toEqual(first.discrepancies);
    expect(second.discrepancyCount).toBe(first.discrepancyCount);
  });

  it('creates no settlement and no payout transaction', async () => {
    await seedHealthyBooks();
    const settlementsBefore = await ctx.prisma.settlement.count();

    await getReport(finance.accessToken);
    await getReport(finance.accessToken);

    expect(await ctx.prisma.settlement.count()).toBe(settlementsBefore);
    expect(await ctx.prisma.ledgerTransaction.count({ where: { type: 'SETTLEMENT' } })).toBe(0);
    // Nothing was marked paid on the way past.
    const statements = await ctx.prisma.settlement.findMany();
    expect(statements.every((row) => row.status === 'DRAFT' && row.paidAt === null)).toBe(true);
  });

  // -------------------------------------------------------------------------------------------
  // The response boundary
  // -------------------------------------------------------------------------------------------

  it('exposes exactly the allow-listed discrepancy fields and no internals', async () => {
    const healthy = await seedHealthyBooks();
    await seedPaymentWithoutPosting();
    await ctx.prisma.settlement.update({
      where: { id: healthy.settlementId },
      data: { grossAmount: 11_000, netAmount: 11_000 },
    });

    const report = await getReport(finance.accessToken);

    expect(Object.keys(report).sort()).toEqual(
      ['checkedAt', 'discrepancies', 'discrepancyCount', 'scope', 'status'].sort(),
    );
    for (const item of discrepancies(report)) {
      expect(Object.keys(item).sort()).toEqual(DISCREPANCY_KEYS);
      // The service's free-form detail bag never reaches the wire, and neither do primary keys:
      // `ledgerReference` is the durable handle, `ledger_transactions.id` is persistence structure.
      expect(item).not.toHaveProperty('details');
      expect(item).not.toHaveProperty('kind');
      expect(item).not.toHaveProperty('message');
      expect(item).not.toHaveProperty('transactionId');
      expect(item).not.toHaveProperty('ledgerTransactionId');
      expect(item).not.toHaveProperty('accountId');
    }

    // No secret, token, gateway-reference or card field anywhere in the payload — checked against
    // the *keys*, at every depth. Scanning the serialized text instead would collide with prose,
    // and "pan" needs word boundaries even here — "discrepancyCount" contains it.
    const forbidden = /secret|token|signature|providerref|cvv|password|card|pan/i;
    expect(allKeys(report).filter((key) => forbidden.test(key))).toEqual([]);
  });

  it('rejects an unknown filter and an out-of-range limit', async () => {
    await request(ctx.server)
      .get('/admin/finance/reconciliation')
      .query({ from: PERIOD_START })
      .set(...auth(finance.accessToken))
      .expect(400);

    await request(ctx.server)
      .get('/admin/finance/reconciliation')
      .query({ limit: '0' })
      .set(...auth(finance.accessToken))
      .expect(400);

    await request(ctx.server)
      .get('/admin/finance/reconciliation')
      .query({ limit: '1000000' })
      .set(...auth(finance.accessToken))
      .expect(400);
  });
});
