import { randomUUID } from 'crypto';
import { AuthorizePaymentCommand } from '../../src/modules/payment/application/commands/authorize-payment.command';
import { CapturePaymentCommand } from '../../src/modules/payment/application/commands/capture-payment.command';
import {
  RefundInitiator,
  RefundPaymentCommand,
  RefundPaymentInput,
} from '../../src/modules/payment/application/commands/refund-payment.command';
import { RunSettlementCommand } from '../../src/modules/payment/application/commands/run-settlement.command';
import {
  GetSettlementQuery,
  ListSettlementsQuery,
} from '../../src/modules/payment/application/queries/get-settlement.query';
import { AccountingReconciliationService } from '../../src/modules/payment/application/services/accounting-reconciliation.service';
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
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

/**
 * Settlement & reconciliation against real PostgreSQL (§3.5 F-STL-01/02, §3.6 F-REC-01).
 *
 * The claim under test is the one that platform-funded coupons made non-obvious: **what a provider
 * is owed is what the ledger credited its `PROVIDER_PAYABLE`, not what the customer paid.** With
 * the suite's 5% commission and a 2,000 coupon:
 *
 * ```
 * subtotal 9,000 + delivery 1,000 + fee 450 − coupon 2,000 = 8,450 captured from the customer
 *   DEBIT  GATEWAY_CLEARING   8,450        DEBIT  PROMOTION_EXPENSE  2,000
 *   CREDIT PROVIDER_PAYABLE  10,000        CREDIT PLATFORM_REVENUE     450
 * ```
 *
 * Settlement must derive **10,000** — more than the cash collected. Paying out of cash would short
 * the pharmacy by the discount the platform promised to fund; subtracting the fee again (8,000)
 * would charge the commission twice.
 *
 * Everything is real except the gateway: real wiring, real Prisma repositories, real Serializable
 * transactions, the real append-only ledger with its triggers. **No payout provider exists and
 * none is called** — a statement is a read of the ledger written down, and this spec asserts that
 * generating one posts nothing.
 */
class FakeGateway implements IPaymentProviderPort {
  readonly key = 'fake-gateway';

  supports(method: PaymentMethod): boolean {
    return method !== PaymentMethod.COD && method !== PaymentMethod.WALLET;
  }
  async authorize(request: ProviderAuthorizationRequest): Promise<ProviderAuthorizationResult> {
    return { outcome: 'AUTHORIZED', providerRef: `gw-auth-${request.paymentId}` };
  }
  async capture(request: ProviderPaymentOperationRequest): Promise<ProviderCaptureResult> {
    return { outcome: 'CAPTURED', providerRef: `gw-capture-${request.paymentId}` };
  }
  async voidAuthorization(
    request: ProviderPaymentOperationRequest,
  ): Promise<ProviderVoidResult> {
    return { outcome: 'VOIDED', providerRef: `gw-void-${request.paymentId}` };
  }
  async refund(request: ProviderRefundRequest): Promise<ProviderRefundResult> {
    return { outcome: 'REFUNDED', providerRef: `gw-refund-${request.refundId}` };
  }
}

const DELIVERY_FEE = 1_000;
const DISCOUNT = 2_000;
const EXPECTED_PLATFORM_FEE = 450;
const EXPECTED_CAPTURE = 8_450;
const EXPECTED_PAYABLE = 10_000;

describe('Settlement & reconciliation (e2e)', () => {
  let ctx: TestContext;
  let authorize: AuthorizePaymentCommand;
  let capture: CapturePaymentCommand;
  let refund: RefundPaymentCommand;
  let run: RunSettlementCommand;
  let get: GetSettlementQuery;
  let list: ListSettlementsQuery;
  let reconcile: AccountingReconciliationService;
  let config: IConfigPort;

  /**
   * A window wide enough to contain everything a test posts, and **fixed** — the period is part of
   * the settlement's identity, so a moving end would make every run a different statement and
   * quietly defeat the idempotency this spec is checking.
   */
  const PERIOD_START = new Date('2020-01-01T00:00:00.000Z');
  const PERIOD_END = new Date('2030-01-01T00:00:00.000Z');

  beforeAll(async () => {
    ctx = await createTestApp([{ provide: PAYMENT_PROVIDER_PORT, useValue: new FakeGateway() }]);
    authorize = ctx.app.get(AuthorizePaymentCommand);
    capture = ctx.app.get(CapturePaymentCommand);
    refund = ctx.app.get(RefundPaymentCommand);
    run = ctx.app.get(RunSettlementCommand);
    get = ctx.app.get(GetSettlementQuery);
    list = ctx.app.get(ListSettlementsQuery);
    reconcile = ctx.app.get(AccountingReconciliationService);
    config = ctx.app.get(CONFIG_PORT);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  /** Seeds and authorizes an order priced by the real `PricingCalculator` at the real rate. */
  async function seedOrder(
    options: { discountTotal?: number; pharmacyId?: string; subtotal?: number } = {},
  ) {
    const discountTotal = options.discountTotal ?? 0;
    const totals = PricingCalculator.computeTotals({
      lines: [{ unitPrice: options.subtotal ?? 9_000, quantity: 1 }],
      deliveryFee: DELIVERY_FEE,
      platformFeePercent: config.get<number>('orders.platformFeePercent') ?? 0,
      discountTotal,
    });

    const customerUserId = `customer-${randomUUID()}`;
    const pharmacyId = options.pharmacyId ?? `pharmacy-${randomUUID()}`;
    const order = await ctx.prisma.order.create({
      data: {
        orderNumber: `ORD-${randomUUID()}`,
        customerUserId,
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
      customerUserId,
      orderId: order.id,
      method: PaymentMethod.TELEBIRR,
      idempotencyKey: `pay-${randomUUID()}`,
    });

    return { paymentId: authorized.paymentId, orderId: order.id, pharmacyId, totals };
  }

  function manualRefund(
    paymentId: string,
    overrides: Partial<RefundPaymentInput> = {},
  ): RefundPaymentInput {
    return {
      paymentId,
      idempotencyKey: `refund-${randomUUID()}`,
      initiator: RefundInitiator.MANUAL,
      actorUserId: `finance-${randomUUID()}`,
      actorPermissions: ['finance:refund:any'],
      reason: 'Order cancelled before delivery',
      ...overrides,
    };
  }

  const settle = (pharmacyId: string) =>
    run.execute({ pharmacyId, periodStart: PERIOD_START, periodEnd: PERIOD_END });

  // -------------------------------------------------------------------------------------------
  // Derivation
  // -------------------------------------------------------------------------------------------

  it('settles a plain captured order from the ledger', async () => {
    const seed = await seedOrder();
    await capture.execute({ paymentId: seed.paymentId });

    const result = await settle(seed.pharmacyId);

    // 9,000 + 1,000 + 450 = 10,450 captured; 450 commission; 10,000 payable.
    expect(result.settlement).toMatchObject({
      providerPayableGross: EXPECTED_PAYABLE,
      refundClawback: 0,
      netPayable: EXPECTED_PAYABLE,
      platformRevenue: EXPECTED_PLATFORM_FEE,
      promotionExpense: 0,
      customerCashCollected: 10_450,
      lineCount: 1,
      status: 'DRAFT',
    });
  });

  it('derives 10,000 for a platform-funded coupon, not the 8,450 the customer paid', async () => {
    const seed = await seedOrder({ discountTotal: DISCOUNT });
    const captured = await capture.execute({ paymentId: seed.paymentId });
    expect(captured.amount).toBe(EXPECTED_CAPTURE);

    const result = await settle(seed.pharmacyId);

    expect(result.settlement.netPayable).toBe(EXPECTED_PAYABLE);
    expect(result.settlement.customerCashCollected).toBe(EXPECTED_CAPTURE);
    // The three figures stay visibly separate — collapsing them would hide that the platform
    // spent 2,000 to earn 450 on this order.
    expect(result.settlement.promotionExpense).toBe(DISCOUNT);
    expect(result.settlement.platformRevenue).toBe(EXPECTED_PLATFORM_FEE);
    expect(result.settlement.netPayable).toBeGreaterThan(result.settlement.customerCashCollected);
  });

  it('pays a discounted and an undiscounted order the same, because the platform funds the coupon', async () => {
    const plain = await seedOrder();
    await capture.execute({ paymentId: plain.paymentId });
    const discounted = await seedOrder({ discountTotal: DISCOUNT });
    await capture.execute({ paymentId: discounted.paymentId });

    const plainStatement = await settle(plain.pharmacyId);
    const discountedStatement = await settle(discounted.pharmacyId);

    expect(discountedStatement.settlement.netPayable).toBe(
      plainStatement.settlement.netPayable,
    );
    // Promotion expense never reduced the payable. Had it, this would be 8,000.
    expect(discountedStatement.settlement.netPayable).toBe(EXPECTED_PAYABLE);
  });

  it('sums several orders for one provider into one statement', async () => {
    const first = await seedOrder({ discountTotal: DISCOUNT });
    await capture.execute({ paymentId: first.paymentId });
    const second = await seedOrder({ pharmacyId: first.pharmacyId, subtotal: 4_000 });
    await capture.execute({ paymentId: second.paymentId });

    const result = await settle(first.pharmacyId);

    // Second order: 4,000 + 1,000 + round(4,000 x 0.05)=200 → payable 5,000.
    expect(result.settlement.netPayable).toBe(EXPECTED_PAYABLE + 5_000);
    expect(result.settlement.platformRevenue).toBe(EXPECTED_PLATFORM_FEE + 200);
    expect(result.settlement.promotionExpense).toBe(DISCOUNT);
    expect(result.settlement.lineCount).toBe(2);
    expect(result.lines.map((line) => line.ledgerReference).sort()).toEqual(
      [`CAPTURE-${first.paymentId}`, `CAPTURE-${second.paymentId}`].sort(),
    );
  });

  it('settles only the provider it was asked about', async () => {
    const mine = await seedOrder();
    await capture.execute({ paymentId: mine.paymentId });
    const theirs = await seedOrder();
    await capture.execute({ paymentId: theirs.paymentId });

    expect((await settle(mine.pharmacyId)).settlement.netPayable).toBe(EXPECTED_PAYABLE);
    expect((await settle(theirs.pharmacyId)).settlement.netPayable).toBe(EXPECTED_PAYABLE);
  });

  // -------------------------------------------------------------------------------------------
  // Refunds
  // -------------------------------------------------------------------------------------------

  it('zeroes the payable after a full refund', async () => {
    const seed = await seedOrder({ discountTotal: DISCOUNT });
    await capture.execute({ paymentId: seed.paymentId });
    await refund.execute(manualRefund(seed.paymentId));

    const result = await settle(seed.pharmacyId);

    expect(result.settlement).toMatchObject({
      providerPayableGross: EXPECTED_PAYABLE,
      refundClawback: EXPECTED_PAYABLE,
      netPayable: 0,
      platformRevenue: 0,
      promotionExpense: 0,
      customerCashCollected: 0,
      lineCount: 2,
    });
  });

  it('reduces the payable by the clawback the refund actually posted', async () => {
    const seed = await seedOrder({ discountTotal: DISCOUNT });
    await capture.execute({ paymentId: seed.paymentId });
    await refund.execute(manualRefund(seed.paymentId, { amount: 2_000 }));

    const result = await settle(seed.pharmacyId);

    // ADR-016's cumulative rounding on a 2,000 refund of an 8,450 capture:
    //   fee 107, promotion 473, provider 2,000 + 473 − 107 = 2,366.
    // Settlement reads those figures rather than recomputing a proportion of its own.
    expect(result.settlement.refundClawback).toBe(2_366);
    expect(result.settlement.netPayable).toBe(EXPECTED_PAYABLE - 2_366);
    expect(result.settlement.platformRevenue).toBe(EXPECTED_PLATFORM_FEE - 107);
    expect(result.settlement.promotionExpense).toBe(DISCOUNT - 473);
    expect(result.settlement.customerCashCollected).toBe(EXPECTED_CAPTURE - 2_000);

    const refundLine = result.lines.find((line) => line.transactionType === 'REFUND');
    expect(refundLine).toMatchObject({
      providerPayableDelta: -2_366,
      platformRevenueDelta: -107,
      promotionExpenseDelta: -473,
      customerCashDelta: -2_000,
      orderId: seed.orderId,
    });
  });

  // -------------------------------------------------------------------------------------------
  // Idempotency, and moving no money
  // -------------------------------------------------------------------------------------------

  it('is idempotent: re-running a period replays one statement', async () => {
    const seed = await seedOrder({ discountTotal: DISCOUNT });
    await capture.execute({ paymentId: seed.paymentId });

    const first = await settle(seed.pharmacyId);
    const second = await settle(seed.pharmacyId);

    expect(first.replay).toBe(false);
    expect(second.replay).toBe(true);
    expect(second.settlement.id).toBe(first.settlement.id);
    expect(await ctx.prisma.settlement.count()).toBe(1);
    expect(await ctx.prisma.payoutLine.count()).toBe(1);
  });

  it('collapses concurrent runs for one period into a single statement', async () => {
    const seed = await seedOrder();
    await capture.execute({ paymentId: seed.paymentId });

    const results = await Promise.all([
      settle(seed.pharmacyId),
      settle(seed.pharmacyId),
      settle(seed.pharmacyId),
    ]);

    // The unique index is what makes this true, not a read-then-write in application code.
    expect(new Set(results.map((result) => result.settlement.id)).size).toBe(1);
    expect(await ctx.prisma.settlement.count()).toBe(1);
  });

  it('posts nothing to the ledger — a statement moves no money', async () => {
    const seed = await seedOrder({ discountTotal: DISCOUNT });
    await capture.execute({ paymentId: seed.paymentId });
    const before = {
      transactions: await ctx.prisma.ledgerTransaction.count(),
      entries: await ctx.prisma.ledgerEntry.count(),
    };

    await settle(seed.pharmacyId);

    // No SETTLEMENT posting and no payable debit: §11.5's `ExecutePayout` is out of scope, and
    // recording money as sent before anything can send it would be unrecoverable here.
    expect(await ctx.prisma.ledgerTransaction.count()).toBe(before.transactions);
    expect(await ctx.prisma.ledgerEntry.count()).toBe(before.entries);
    expect(await ctx.prisma.ledgerTransaction.count({ where: { type: 'SETTLEMENT' } })).toBe(0);
  });

  it('persists a statement that reads back with its figures separate', async () => {
    const seed = await seedOrder({ discountTotal: DISCOUNT });
    await capture.execute({ paymentId: seed.paymentId });
    const created = await settle(seed.pharmacyId);

    const view = await get.execute({ settlementId: created.settlement.id });
    expect(view).toMatchObject({
      netPayable: EXPECTED_PAYABLE,
      platformRevenue: EXPECTED_PLATFORM_FEE,
      promotionExpense: DISCOUNT,
      customerCashCollected: EXPECTED_CAPTURE,
      statementRef: expect.stringContaining('STL-'),
    });
    expect(view.lines[0]).toMatchObject({
      ledgerReference: `CAPTURE-${seed.paymentId}`,
      orderId: seed.orderId,
    });

    const page = await list.execute({ pharmacyId: seed.pharmacyId });
    expect(page.total).toBe(1);
  });

  // -------------------------------------------------------------------------------------------
  // Reconciliation
  // -------------------------------------------------------------------------------------------

  it('reports no anomaly when capture, refund and statement agree', async () => {
    const seed = await seedOrder({ discountTotal: DISCOUNT });
    await capture.execute({ paymentId: seed.paymentId });
    await refund.execute(manualRefund(seed.paymentId, { amount: 2_000 }));
    await settle(seed.pharmacyId);

    const report = await reconcile.run();

    expect(report.anomalies).toEqual([]);
    expect(report.examined.capturedPayments).toBe(1);
    expect(report.examined.settlements).toBe(1);
  });

  it('detects a captured payment whose capture posting is missing', async () => {
    const seed = await seedOrder();
    await capture.execute({ paymentId: seed.paymentId });

    // A second payment marked CAPTURED without ever going through the capture command — the shape
    // a crash between the gateway call and the ledger write would leave, or a status written by
    // something other than `CapturePaymentCommand`. The ledger is not touched: it is append-only,
    // and reconciliation's job is to notice that the payment and the books disagree, whichever
    // side is at fault.
    const orphan = await seedOrder({ pharmacyId: seed.pharmacyId });
    await ctx.prisma.payment.update({
      where: { id: orphan.paymentId },
      data: { status: 'CAPTURED', capturedAt: new Date() },
    });

    const report = await reconcile.run();

    const missing = report.anomalies.filter(
      (anomaly) => anomaly.kind === 'CAPTURE_POSTING_MISSING',
    );
    expect(missing).toHaveLength(1);
    expect(missing[0].subject).toBe(orphan.paymentId);
    // The healthy payment alongside it is not implicated.
    expect(missing[0].subject).not.toBe(seed.paymentId);
  });

  it('does not mutate the ledger while reporting', async () => {
    const seed = await seedOrder({ discountTotal: DISCOUNT });
    await capture.execute({ paymentId: seed.paymentId });
    await settle(seed.pharmacyId);

    const before = await ctx.prisma.ledgerEntry.findMany({ orderBy: { id: 'asc' } });
    const settlementsBefore = await ctx.prisma.settlement.findMany({ orderBy: { id: 'asc' } });

    await reconcile.run();
    await reconcile.run();

    expect(await ctx.prisma.ledgerEntry.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
    expect(await ctx.prisma.settlement.findMany({ orderBy: { id: 'asc' } })).toEqual(
      settlementsBefore,
    );
  });
});
