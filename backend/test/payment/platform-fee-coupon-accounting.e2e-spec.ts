import { randomUUID } from 'crypto';
import { AuthorizePaymentCommand } from '../../src/modules/payment/application/commands/authorize-payment.command';
import { CapturePaymentCommand } from '../../src/modules/payment/application/commands/capture-payment.command';
import { ProcessWebhookCommand } from '../../src/modules/payment/application/commands/process-webhook.command';
import {
  RefundInitiator,
  RefundPaymentCommand,
  RefundPaymentInput,
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
import { RawWebhookDelivery } from '../../src/modules/payment/application/webhooks/normalized-webhook-event';
import {
  LedgerAccountType,
  LedgerDirection,
  PaymentMethod,
  PaymentStatus,
} from '../../src/modules/payment/domain/enums';
import { LedgerService } from '../../src/modules/payment/domain/services/ledger.service';
import { AccountRef } from '../../src/modules/payment/domain/value-objects/account-ref.vo';
import { computeHmacSignature } from '../../src/modules/payment/infrastructure/webhooks/hmac-signature';
import {
  MOCK_WEBHOOK_SECRET_KEY,
  MOCK_WEBHOOK_SIGNATURE_HEADER,
} from '../../src/modules/payment/infrastructure/webhooks/mock-webhook.adapter';
import { PricingCalculator } from '../../src/modules/orders/domain/services/pricing-calculator';
import { CONFIG_PORT, IConfigPort } from '../../src/shared/config/config.port';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

/**
 * The whole money chain with a **non-zero platform commission**: configuration → Module 06's
 * pricing → the persisted `Order` → Module 07's capture → refunds.
 *
 * Until `orders.platformFeePercent` was registered as a real config namespace, nothing could
 * resolve that key and every order carried `platformFee = 0`. A zero commission makes most of this
 * arithmetic trivially correct — `PLATFORM_REVENUE` is always zero, the fee clawback is always
 * zero, and ADR-019's central tension (a commission computed on the **pre-discount** subtotal
 * meeting a discount the platform funds) cannot be observed at all. This spec exists to observe
 * it.
 *
 * ## The worked example
 *
 * ```
 * subtotal        9,000     (2 lines the fixture prices)
 * deliveryFee     1,000
 * platformFee       450     = round(9,000 x 0.05), on the UNDISCOUNTED subtotal
 * discountTotal   2,000     platform-funded coupon (ADR-019)
 * ------------------------
 * grandTotal      8,450     = 9,000 + 1,000 + 450 - 2,000   <- what the customer is captured for
 * ```
 *
 * and the capture that produces:
 *
 * ```
 * DEBIT  GATEWAY_CLEARING    8,450    what the customer actually paid
 * DEBIT  PROMOTION_EXPENSE   2,000    the platform's promotional spend
 * CREDIT PROVIDER_PAYABLE   10,000    = subtotal + deliveryFee — as if there were no coupon
 * CREDIT PLATFORM_REVENUE      450    = the persisted Order.platformFee, unchanged by the coupon
 * ```
 *
 * Debits 10,450 = credits 10,450. The two numbers worth staring at: the pharmacy is credited
 * **more than the customer paid**, which is what platform funding means; and the platform's net
 * position is `450 - 2,000 = -1,550`, a promotion that costs more than the order earns — visible
 * precisely because revenue and promotional spend are separate legs rather than netted.
 *
 * `platformFee` is never recomputed by Module 07. It is read from the order, so the 450 credited
 * at capture is the same 450 the customer was charged, even though capture happens later.
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

const WEBHOOK_SECRET = 'platform-fee-accounting-e2e-secret';

/** The worked example above, as constants the assertions read from. */
const SUBTOTAL = 9_000;
const DELIVERY_FEE = 1_000;
const DISCOUNT = 2_000;
const EXPECTED_FEE_PERCENT = 0.05;
const EXPECTED_PLATFORM_FEE = 450;
const EXPECTED_GRAND_TOTAL = 8_450;
const EXPECTED_PROVIDER_PAYABLE = 10_000;

describe('Non-zero platform fee with a platform-funded coupon (e2e)', () => {
  let ctx: TestContext;
  let authorize: AuthorizePaymentCommand;
  let capture: CapturePaymentCommand;
  let processWebhook: ProcessWebhookCommand;
  let refund: RefundPaymentCommand;
  let ledger: LedgerService;
  let config: IConfigPort;
  let previousSecret: string | undefined;

  beforeAll(async () => {
    previousSecret = process.env[MOCK_WEBHOOK_SECRET_KEY];
    process.env[MOCK_WEBHOOK_SECRET_KEY] = WEBHOOK_SECRET;
    ctx = await createTestApp([{ provide: PAYMENT_PROVIDER_PORT, useValue: new FakeGateway() }]);
    authorize = ctx.app.get(AuthorizePaymentCommand);
    capture = ctx.app.get(CapturePaymentCommand);
    processWebhook = ctx.app.get(ProcessWebhookCommand);
    refund = ctx.app.get(RefundPaymentCommand);
    ledger = ctx.app.get(LedgerService);
    config = ctx.app.get(CONFIG_PORT);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
    if (previousSecret === undefined) {
      delete process.env[MOCK_WEBHOOK_SECRET_KEY];
    } else {
      process.env[MOCK_WEBHOOK_SECRET_KEY] = previousSecret;
    }
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  /**
   * Seeds the order Module 06 would have created, priced by **the real `PricingCalculator` with
   * the real configured rate** rather than by hand. That is what ties this spec to the
   * configuration: if the namespace stopped resolving, the rate would fall back to zero and the
   * assertions below would fail rather than quietly passing against a hard-coded fixture.
   *
   * The order is seeded rather than checked out over HTTP because Module 06's Slice-1 checkout is
   * COD-only and commits straight to `PAID`, leaving no gateway payment to capture. Module 06's
   * own e2e covers the checkout half; this spec covers what Module 07 does with the result.
   */
  async function seedOrder(options: { discountTotal?: number } = {}) {
    const discountTotal = options.discountTotal ?? 0;
    const platformFeePercent = config.get<number>('orders.platformFeePercent') ?? 0;

    const totals = PricingCalculator.computeTotals({
      lines: [
        { unitPrice: 3_000, quantity: 2 },
        { unitPrice: 3_000, quantity: 1 },
      ],
      deliveryFee: DELIVERY_FEE,
      platformFeePercent,
      discountTotal,
    });

    const customerUserId = `customer-${randomUUID()}`;
    const pharmacyId = `pharmacy-${randomUUID()}`;
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

  function signed(body: Record<string, unknown>): RawWebhookDelivery {
    const rawBody = JSON.stringify(body);
    return {
      provider: 'mock',
      rawBody,
      headers: { [MOCK_WEBHOOK_SIGNATURE_HEADER]: computeHmacSignature(WEBHOOK_SECRET, rawBody) },
    };
  }

  async function balanceOf(ref: AccountRef): Promise<number> {
    const account = await ledger.resolveAccount(ref);
    return (await ledger.balanceOf(account.id)).amountMinor;
  }

  const promotionRef = () => AccountRef.platform(LedgerAccountType.PROMOTION_EXPENSE, 'ETB');
  const revenueRef = () => AccountRef.platform(LedgerAccountType.PLATFORM_REVENUE, 'ETB');
  const gatewayRef = () => AccountRef.platform(LedgerAccountType.GATEWAY_CLEARING, 'ETB');

  /** Every leg of a posting, order-independent. */
  async function legsOf(reference: string) {
    const header = await ctx.prisma.ledgerTransaction.findUniqueOrThrow({
      where: { reference },
      include: { entries: { include: { account: true } } },
    });
    return header.entries
      .map((entry) => ({
        type: entry.account.type,
        ownerId: entry.account.ownerId,
        direction: entry.direction,
        amount: entry.amount,
      }))
      .sort((a, b) => `${a.type}${a.direction}`.localeCompare(`${b.type}${b.direction}`));
  }

  async function ledgerConservesMoney() {
    const sums = await ctx.prisma.ledgerEntry.groupBy({
      by: ['direction'],
      _sum: { amount: true },
    });
    const total = (direction: LedgerDirection) =>
      sums.find((row) => row.direction === direction)?._sum.amount ?? 0;
    return { debits: total(LedgerDirection.DEBIT), credits: total(LedgerDirection.CREDIT) };
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

  // -------------------------------------------------------------------------------------------
  // Configuration reaches pricing
  // -------------------------------------------------------------------------------------------

  it('resolves orders.platformFeePercent from configuration, not from a missing key', () => {
    // The regression this whole change exists to prevent: before the `orders` namespace was
    // registered, `ConfigService` had no source for a dotted key and this returned `undefined`,
    // pinning every commission at zero regardless of what an operator configured.
    expect(config.get<number>('orders.platformFeePercent')).toBe(EXPECTED_FEE_PERCENT);
  });

  it('prices the order with a real commission, computed on the pre-discount subtotal', async () => {
    const seed = await seedOrder({ discountTotal: DISCOUNT });

    // round(9,000 x 0.05) = 450. Note it is 450 and not round(7,000 x 0.05) = 350: the fee is
    // charged on the subtotal *before* the discount, which is the ADR-019 behaviour the whole
    // funding decision turns on.
    expect(seed.totals.subtotal).toBe(SUBTOTAL);
    expect(seed.totals.platformFee).toBe(EXPECTED_PLATFORM_FEE);
    expect(seed.totals.discountTotal).toBe(DISCOUNT);
    expect(seed.totals.grandTotal).toBe(EXPECTED_GRAND_TOTAL);

    const persisted = await ctx.prisma.order.findUniqueOrThrow({ where: { id: seed.orderId } });
    expect(persisted.platformFee).toBe(EXPECTED_PLATFORM_FEE);
    expect(persisted.grandTotal).toBe(EXPECTED_GRAND_TOTAL);
  });

  // -------------------------------------------------------------------------------------------
  // Capture
  // -------------------------------------------------------------------------------------------

  it('captures the discounted total and posts all four legs exactly', async () => {
    const seed = await seedOrder({ discountTotal: DISCOUNT });

    const result = await capture.execute({ paymentId: seed.paymentId });

    // The customer is captured for the discounted total, not the list price.
    expect(result.amount).toBe(EXPECTED_GRAND_TOTAL);
    expect(result.fee).toBe(EXPECTED_PLATFORM_FEE);
    expect(result.promotionExpense).toBe(DISCOUNT);
    // 8,450 - 450 + 2,000 = 10,000 = subtotal + deliveryFee. The pharmacy is paid as though no
    // coupon had been used, and is credited more than the customer actually paid.
    expect(result.providerNet).toBe(EXPECTED_PROVIDER_PAYABLE);

    expect(await legsOf(`CAPTURE-${seed.paymentId}`)).toEqual([
      {
        type: LedgerAccountType.GATEWAY_CLEARING,
        ownerId: null,
        direction: LedgerDirection.DEBIT,
        amount: EXPECTED_GRAND_TOTAL,
      },
      {
        type: LedgerAccountType.PLATFORM_REVENUE,
        ownerId: null,
        direction: LedgerDirection.CREDIT,
        amount: EXPECTED_PLATFORM_FEE,
      },
      {
        type: LedgerAccountType.PROMOTION_EXPENSE,
        ownerId: null,
        direction: LedgerDirection.DEBIT,
        amount: DISCOUNT,
      },
      {
        type: LedgerAccountType.PROVIDER_PAYABLE,
        ownerId: seed.pharmacyId,
        direction: LedgerDirection.CREDIT,
        amount: EXPECTED_PROVIDER_PAYABLE,
      },
    ]);

    const { debits, credits } = await ledgerConservesMoney();
    expect(debits).toBe(10_450);
    expect(credits).toBe(10_450);
  });

  it('leaves the pharmacy and the commission identical to an un-couponed order', async () => {
    const plain = await seedOrder({ discountTotal: 0 });
    await capture.execute({ paymentId: plain.paymentId });

    const discounted = await seedOrder({ discountTotal: DISCOUNT });
    await capture.execute({ paymentId: discounted.paymentId });

    // Same order economics either way: the pharmacy is owed 10,000 and the platform earns 450.
    // Only the customer's gross (10,450 vs 8,450) and the promotion expense differ — which is
    // precisely the claim "the platform funds 100% of the discount".
    expect(
      await balanceOf(AccountRef.providerPayable(plain.pharmacyId, 'ETB')),
    ).toBe(EXPECTED_PROVIDER_PAYABLE);
    expect(
      await balanceOf(AccountRef.providerPayable(discounted.pharmacyId, 'ETB')),
    ).toBe(EXPECTED_PROVIDER_PAYABLE);

    // Balances are credits - debits, so debited accounts read negative.
    expect(await balanceOf(revenueRef())).toBe(2 * EXPECTED_PLATFORM_FEE);
    expect(await balanceOf(promotionRef())).toBe(-DISCOUNT);
    expect(await balanceOf(gatewayRef())).toBe(-(10_450 + EXPECTED_GRAND_TOTAL));

    const { debits, credits } = await ledgerConservesMoney();
    expect(debits).toBe(credits);
  });

  it('credits the persisted historical fee even after the configured rate changes', async () => {
    const seed = await seedOrder({ discountTotal: DISCOUNT });

    // The order was priced at 5%; the platform now charges 20%. Capture happens at fulfillment,
    // potentially days later — and must still credit the 450 the customer was actually charged,
    // not round(9,000 x 0.20) = 1,800. Module 07 reads `Order.platformFee` and never re-derives.
    process.env.ORDERS_PLATFORM_FEE_PERCENT = '0.2';
    try {
      const result = await capture.execute({ paymentId: seed.paymentId });
      expect(result.fee).toBe(EXPECTED_PLATFORM_FEE);
      expect(await balanceOf(revenueRef())).toBe(EXPECTED_PLATFORM_FEE);
      expect(result.providerNet).toBe(EXPECTED_PROVIDER_PAYABLE);
    } finally {
      process.env.ORDERS_PLATFORM_FEE_PERCENT = String(EXPECTED_FEE_PERCENT);
    }
  });

  it('produces identical accounting whether captured by command or by webhook', async () => {
    const viaCommand = await seedOrder({ discountTotal: DISCOUNT });
    await capture.execute({ paymentId: viaCommand.paymentId });

    const viaWebhook = await seedOrder({ discountTotal: DISCOUNT });
    const accepted = await processWebhook.execute(
      signed({
        id: `evt-${randomUUID()}`,
        type: 'payment.captured',
        paymentId: viaWebhook.paymentId,
        providerRef: 'gw-webhook-capture',
      }),
    );
    expect(accepted.accepted).toBe(true);

    const withoutOwner = (legs: Awaited<ReturnType<typeof legsOf>>) =>
      legs.map((leg) => ({ type: leg.type, direction: leg.direction, amount: leg.amount }));

    // Leg for leg, modulo the pharmacy each order is fulfilled by. Both paths run the one
    // `CaptureAccountingService`, so this holds by construction rather than by coincidence.
    expect(withoutOwner(await legsOf(`CAPTURE-${viaWebhook.paymentId}`))).toEqual(
      withoutOwner(await legsOf(`CAPTURE-${viaCommand.paymentId}`)),
    );
    expect(withoutOwner(await legsOf(`CAPTURE-${viaWebhook.paymentId}`))).toEqual([
      {
        type: LedgerAccountType.GATEWAY_CLEARING,
        direction: LedgerDirection.DEBIT,
        amount: EXPECTED_GRAND_TOTAL,
      },
      {
        type: LedgerAccountType.PLATFORM_REVENUE,
        direction: LedgerDirection.CREDIT,
        amount: EXPECTED_PLATFORM_FEE,
      },
      {
        type: LedgerAccountType.PROMOTION_EXPENSE,
        direction: LedgerDirection.DEBIT,
        amount: DISCOUNT,
      },
      {
        type: LedgerAccountType.PROVIDER_PAYABLE,
        direction: LedgerDirection.CREDIT,
        amount: EXPECTED_PROVIDER_PAYABLE,
      },
    ]);

    const captured = await ctx.prisma.payment.findUniqueOrThrow({
      where: { id: viaWebhook.paymentId },
    });
    expect(captured.status).toBe(PaymentStatus.CAPTURED);
  });

  // -------------------------------------------------------------------------------------------
  // Refunds
  // -------------------------------------------------------------------------------------------

  it('reverses every historical leg on a full refund', async () => {
    const seed = await seedOrder({ discountTotal: DISCOUNT });
    await capture.execute({ paymentId: seed.paymentId });

    const result = await refund.execute(manualRefund(seed.paymentId));
    expect(result.amount).toBe(EXPECTED_GRAND_TOTAL);

    // The exact mirror of the capture: what it debited, this credits.
    expect(await legsOf(`REFUND-${result.refundId}`)).toEqual([
      {
        type: LedgerAccountType.GATEWAY_CLEARING,
        ownerId: null,
        direction: LedgerDirection.CREDIT,
        amount: EXPECTED_GRAND_TOTAL,
      },
      {
        type: LedgerAccountType.PLATFORM_REVENUE,
        ownerId: null,
        direction: LedgerDirection.DEBIT,
        amount: EXPECTED_PLATFORM_FEE,
      },
      {
        type: LedgerAccountType.PROMOTION_EXPENSE,
        ownerId: null,
        direction: LedgerDirection.CREDIT,
        amount: DISCOUNT,
      },
      {
        type: LedgerAccountType.PROVIDER_PAYABLE,
        ownerId: seed.pharmacyId,
        direction: LedgerDirection.DEBIT,
        amount: EXPECTED_PROVIDER_PAYABLE,
      },
    ]);

    for (const ref of [promotionRef(), revenueRef(), gatewayRef()]) {
      expect(await balanceOf(ref)).toBe(0);
    }
    expect(await balanceOf(AccountRef.providerPayable(seed.pharmacyId, 'ETB'))).toBe(0);
  });

  it('splits a partial refund across all three legs under the cumulative rounding rule', async () => {
    const seed = await seedOrder({ discountTotal: DISCOUNT });
    await capture.execute({ paymentId: seed.paymentId });

    // 2,000 of the 8,450 captured — deliberately not a clean fraction, so every leg rounds.
    const result = await refund.execute(manualRefund(seed.paymentId, { amount: 2_000 }));
    expect(result.amount).toBe(2_000);

    // ADR-016's cumulative allocation, applied to each historical leg:
    //   feeClawback   = round(450   x 2,000 / 8,450) = round(106.51) = 107
    //   promoClawback = round(2,000 x 2,000 / 8,450) = round(473.37) = 473
    //   providerClawback = 2,000 + 473 - 107 = 2,366   (the balancing remainder)
    expect(await legsOf(`REFUND-${result.refundId}`)).toEqual([
      {
        type: LedgerAccountType.GATEWAY_CLEARING,
        ownerId: null,
        direction: LedgerDirection.CREDIT,
        amount: 2_000,
      },
      {
        type: LedgerAccountType.PLATFORM_REVENUE,
        ownerId: null,
        direction: LedgerDirection.DEBIT,
        amount: 107,
      },
      {
        type: LedgerAccountType.PROMOTION_EXPENSE,
        ownerId: null,
        direction: LedgerDirection.CREDIT,
        amount: 473,
      },
      {
        type: LedgerAccountType.PROVIDER_PAYABLE,
        ownerId: seed.pharmacyId,
        direction: LedgerDirection.DEBIT,
        amount: 2_366,
      },
    ]);

    expect(await balanceOf(revenueRef())).toBe(EXPECTED_PLATFORM_FEE - 107);
    expect(await balanceOf(promotionRef())).toBe(-(DISCOUNT - 473));
    expect(await balanceOf(AccountRef.providerPayable(seed.pharmacyId, 'ETB'))).toBe(
      EXPECTED_PROVIDER_PAYABLE - 2_366,
    );
    expect(await balanceOf(gatewayRef())).toBe(-(EXPECTED_GRAND_TOTAL - 2_000));

    const { debits, credits } = await ledgerConservesMoney();
    expect(debits).toBe(credits);
  });

  it('leaves no residue on any leg after a sequence of partial refunds to 100%', async () => {
    const seed = await seedOrder({ discountTotal: DISCOUNT });
    await capture.execute({ paymentId: seed.paymentId });

    for (const amount of [2_000, 1_111, 3_333]) {
      await refund.execute(manualRefund(seed.paymentId, { amount }));
    }
    // The remainder, as a full refund of what is left (8,450 - 6,444 = 2,006).
    const last = await refund.execute(manualRefund(seed.paymentId));
    expect(last.amount).toBe(2_006);

    // Because the clawbacks are computed cumulatively and then differenced, the roundings
    // telescope: the final refund absorbs the residue automatically, with nothing stored. A
    // per-refund rounding would have left `PLATFORM_REVENUE` and `PROMOTION_EXPENSE` permanently
    // non-zero — a ledger that never reconciles.
    expect(await balanceOf(revenueRef())).toBe(0);
    expect(await balanceOf(promotionRef())).toBe(0);
    expect(await balanceOf(AccountRef.providerPayable(seed.pharmacyId, 'ETB'))).toBe(0);
    expect(await balanceOf(gatewayRef())).toBe(0);

    const { debits, credits } = await ledgerConservesMoney();
    expect(debits).toBe(credits);
  });
});
