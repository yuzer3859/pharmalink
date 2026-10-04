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
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

/**
 * ADR-019 — **platform-funded coupon discounts**, proved end to end against real PostgreSQL.
 *
 * The decision: a coupon discount is borne by the platform, never by the pharmacy. So for a
 * discount `D` on an order whose customer paid `grandTotal`:
 *
 * ```
 * DEBIT  GATEWAY_CLEARING   grandTotal              what the customer actually paid
 * DEBIT  PROMOTION_EXPENSE  D                       the platform's promotional spend
 * CREDIT PROVIDER_PAYABLE   grandTotal - fee + D    as if there had been no coupon
 * CREDIT PLATFORM_REVENUE   fee                     Order.platformFee, unchanged
 * ```
 *
 * Both debits and both credits come to `subtotal + deliveryFee + platformFee`, which is why the
 * promotion leg is not decoration: without it the posting is short by exactly `D`, and the only
 * ways to close that gap would be to pay the pharmacy less (pharmacy-funded — the model ADR-019
 * rejected) or to under-credit revenue (which would merge commission earned with promotional
 * spend and make both unreportable).
 *
 * Everything here is real except the gateway itself: real `AppModule` wiring, real commands, real
 * Prisma repositories, real `Serializable` transactions, the real append-only ledger, and real
 * PostgreSQL. The fixtures seed Module 06 rows directly because Module 06's checkout has no coupon
 * step — this task deliberately does not add one — so `orders.discountTotal` is set the way a
 * future integration would set it.
 */
class FakeGateway implements IPaymentProviderPort {
  readonly key = 'fake-gateway';
  nextCapture: ProviderCaptureResult | Error = { outcome: 'CAPTURED', providerRef: null };

  supports(method: PaymentMethod): boolean {
    return method !== PaymentMethod.COD && method !== PaymentMethod.WALLET;
  }

  async authorize(request: ProviderAuthorizationRequest): Promise<ProviderAuthorizationResult> {
    return { outcome: 'AUTHORIZED', providerRef: `gw-auth-${request.paymentId}` };
  }

  async capture(request: ProviderPaymentOperationRequest): Promise<ProviderCaptureResult> {
    if (this.nextCapture instanceof Error) {
      throw this.nextCapture;
    }
    return {
      ...this.nextCapture,
      providerRef: this.nextCapture.providerRef ?? `gw-capture-${request.paymentId}`,
    };
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

const WEBHOOK_SECRET = 'platform-funded-coupon-e2e-secret';

describe('Platform-funded coupon accounting, ADR-019 (e2e)', () => {
  let ctx: TestContext;
  let gateway: FakeGateway;
  let authorize: AuthorizePaymentCommand;
  let capture: CapturePaymentCommand;
  let processWebhook: ProcessWebhookCommand;
  let refund: RefundPaymentCommand;
  let ledger: LedgerService;
  let previousSecret: string | undefined;

  beforeAll(async () => {
    previousSecret = process.env[MOCK_WEBHOOK_SECRET_KEY];
    process.env[MOCK_WEBHOOK_SECRET_KEY] = WEBHOOK_SECRET;
    gateway = new FakeGateway();
    ctx = await createTestApp([{ provide: PAYMENT_PROVIDER_PORT, useValue: gateway }]);
    authorize = ctx.app.get(AuthorizePaymentCommand);
    capture = ctx.app.get(CapturePaymentCommand);
    processWebhook = ctx.app.get(ProcessWebhookCommand);
    refund = ctx.app.get(RefundPaymentCommand);
    ledger = ctx.app.get(LedgerService);
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
    gateway.nextCapture = { outcome: 'CAPTURED', providerRef: null };
  });

  /**
   * Seeds a Module 06 order the way `PricingCalculator` would have priced it with a coupon:
   * `platformFee` is computed on the **undiscounted** subtotal, and the discount is subtracted
   * from what the customer pays. `authorizeOnly` leaves the payment `INITIATED` so a capture
   * webhook has something to resolve.
   */
  async function seedOrder(options: {
    subtotal?: number;
    deliveryFee?: number;
    platformFee?: number;
    discountTotal?: number;
  } = {}) {
    const subtotal = options.subtotal ?? 9_000;
    const deliveryFee = options.deliveryFee ?? 1_000;
    const platformFee = options.platformFee ?? 1_000;
    const discountTotal = options.discountTotal ?? 0;
    const grandTotal = subtotal + deliveryFee + platformFee - discountTotal;

    const customerUserId = `customer-${randomUUID()}`;
    const pharmacyId = `pharmacy-${randomUUID()}`;

    const order = await ctx.prisma.order.create({
      data: {
        orderNumber: `ORD-${randomUUID()}`,
        customerUserId,
        status: 'PENDING_PAYMENT',
        subtotal,
        deliveryFee,
        platformFee,
        discountTotal,
        grandTotal,
        currency: 'ETB',
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

    return {
      paymentId: authorized.paymentId,
      orderId: order.id,
      customerUserId,
      pharmacyId,
      subtotal,
      deliveryFee,
      platformFee,
      discountTotal,
      grandTotal,
    };
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

  /** Every leg of a posting as `{ type, ownerId, direction, amount }`, order-independent. */
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

  /** The property the whole double-entry model rests on, asserted over the entire database. */
  async function ledgerConservesMoney() {
    const sums = await ctx.prisma.ledgerEntry.groupBy({
      by: ['direction'],
      _sum: { amount: true },
    });
    const total = (direction: LedgerDirection) =>
      sums.find((row) => row.direction === direction)?._sum.amount ?? 0;
    return { debits: total(LedgerDirection.DEBIT), credits: total(LedgerDirection.CREDIT) };
  }

  // -------------------------------------------------------------------------------------------
  // Capture
  // -------------------------------------------------------------------------------------------

  it('captures an un-discounted order with no promotion leg at all', async () => {
    const seed = await seedOrder({ discountTotal: 0 });

    const result = await capture.execute({ paymentId: seed.paymentId });

    // 9_000 + 1_000 + 1_000 = 11_000 collected; 1_000 commission; 10_000 to the pharmacy.
    expect(result.amount).toBe(11_000);
    expect(result.fee).toBe(1_000);
    expect(result.providerNet).toBe(10_000);
    expect(result.promotionExpense).toBe(0);

    // Exactly the three legs that existed before ADR-019 — a zero expense posts nothing, so no
    // historical capture is reinterpreted and no empty PROMOTION_EXPENSE account is opened.
    expect(await legsOf(`CAPTURE-${seed.paymentId}`)).toEqual([
      {
        type: LedgerAccountType.GATEWAY_CLEARING,
        ownerId: null,
        direction: LedgerDirection.DEBIT,
        amount: 11_000,
      },
      {
        type: LedgerAccountType.PLATFORM_REVENUE,
        ownerId: null,
        direction: LedgerDirection.CREDIT,
        amount: 1_000,
      },
      {
        type: LedgerAccountType.PROVIDER_PAYABLE,
        ownerId: seed.pharmacyId,
        direction: LedgerDirection.CREDIT,
        amount: 10_000,
      },
    ]);
    expect(
      await ctx.prisma.ledgerAccount.count({
        where: { type: LedgerAccountType.PROMOTION_EXPENSE },
      }),
    ).toBe(0);
  });

  it('captures a platform-funded coupon as its own expense leg, leaving the pharmacy whole', async () => {
    // Subtotal 9_000 + delivery 1_000 + fee 1_000 - discount 2_000 = 9_000 paid by the customer.
    const seed = await seedOrder({ discountTotal: 2_000 });
    expect(seed.grandTotal).toBe(9_000);

    const result = await capture.execute({ paymentId: seed.paymentId });

    expect(result.amount).toBe(9_000);
    expect(result.fee).toBe(1_000);
    // The whole point: 9_000 - 1_000 + 2_000 = 10_000 = subtotal + deliveryFee. The pharmacy is
    // paid exactly what it would have been paid had the customer used no coupon.
    expect(result.providerNet).toBe(10_000);
    expect(result.promotionExpense).toBe(2_000);

    expect(await legsOf(`CAPTURE-${seed.paymentId}`)).toEqual([
      {
        type: LedgerAccountType.GATEWAY_CLEARING,
        ownerId: null,
        direction: LedgerDirection.DEBIT,
        amount: 9_000,
      },
      {
        type: LedgerAccountType.PLATFORM_REVENUE,
        ownerId: null,
        direction: LedgerDirection.CREDIT,
        amount: 1_000,
      },
      {
        type: LedgerAccountType.PROMOTION_EXPENSE,
        ownerId: null,
        direction: LedgerDirection.DEBIT,
        amount: 2_000,
      },
      {
        type: LedgerAccountType.PROVIDER_PAYABLE,
        ownerId: seed.pharmacyId,
        direction: LedgerDirection.CREDIT,
        amount: 10_000,
      },
    ]);
  });

  it('balances exactly, and the coupon does not touch the pharmacy or the commission', async () => {
    const noCoupon = await seedOrder({ discountTotal: 0 });
    await capture.execute({ paymentId: noCoupon.paymentId });
    const payableWithoutCoupon = await balanceOf(
      AccountRef.providerPayable(noCoupon.pharmacyId, 'ETB'),
    );

    const withCoupon = await seedOrder({ discountTotal: 2_000 });
    await capture.execute({ paymentId: withCoupon.paymentId });

    // Same order economics, one with a coupon and one without: the pharmacy's payable and the
    // platform's commission are identical. Only the promotion expense and what the customer
    // actually paid differ — which is what "funded entirely by the platform" means.
    expect(await balanceOf(AccountRef.providerPayable(withCoupon.pharmacyId, 'ETB'))).toBe(
      payableWithoutCoupon,
    );
    // Balances are credits - debits, so a debited account reads negative.
    expect(await balanceOf(revenueRef())).toBe(2_000); // 1_000 from each capture.
    expect(await balanceOf(promotionRef())).toBe(-2_000); // Exactly the discount, and only it.
    expect(await balanceOf(gatewayRef())).toBe(-20_000); // 11_000 + 9_000 collected.

    const { debits, credits } = await ledgerConservesMoney();
    expect(debits).toBe(credits);
  });

  it('credits PLATFORM_REVENUE the historical Order.platformFee, never a rate re-derived at capture', async () => {
    // A fee that is not any round percentage of anything, so a re-derivation could not match it
    // by luck, and a discount larger than the fee, so netting them would be visible.
    const seed = await seedOrder({
      subtotal: 7_777,
      deliveryFee: 1_111,
      platformFee: 333,
      discountTotal: 1_500,
    });

    const result = await capture.execute({ paymentId: seed.paymentId });

    expect(result.fee).toBe(333);
    expect(await balanceOf(revenueRef())).toBe(333);
    // Revenue is NOT reduced by the discount — the expense is a separate fact, so commission
    // earned stays reportable. The platform's net position is 333 - 1_500 = -1_167, which is the
    // promotion costing more than the order earned, and that is a real and visible outcome.
    expect(await balanceOf(promotionRef())).toBe(-1_500);
  });

  // -------------------------------------------------------------------------------------------
  // The two capture paths, and idempotency
  // -------------------------------------------------------------------------------------------

  it('a capture webhook posts exactly the same legs as the capture command', async () => {
    const viaCommand = await seedOrder({ discountTotal: 2_000 });
    await capture.execute({ paymentId: viaCommand.paymentId });

    const viaWebhook = await seedOrder({ discountTotal: 2_000 });
    const accepted = await processWebhook.execute(
      signed({
        id: `evt-${randomUUID()}`,
        type: 'payment.captured',
        paymentId: viaWebhook.paymentId,
        providerRef: 'gw-webhook-capture',
      }),
    );
    expect(accepted.accepted).toBe(true);

    const commandLegs = await legsOf(`CAPTURE-${viaCommand.paymentId}`);
    const webhookLegs = await legsOf(`CAPTURE-${viaWebhook.paymentId}`);

    // Identical down to the leg, modulo the pharmacy each order happens to be fulfilled by. Both
    // paths call the one `CaptureAccountingService`, which is what makes this true by construction
    // rather than by two implementations happening to agree today.
    const withoutOwner = (legs: typeof commandLegs) =>
      legs.map((leg) => ({ type: leg.type, direction: leg.direction, amount: leg.amount }));
    expect(withoutOwner(webhookLegs)).toEqual(withoutOwner(commandLegs));
    expect(webhookLegs).toHaveLength(4);

    const captured = await ctx.prisma.payment.findUniqueOrThrow({
      where: { id: viaWebhook.paymentId },
    });
    expect(captured.status).toBe(PaymentStatus.CAPTURED);
  });

  it('a repeated capture posts no second promotion expense', async () => {
    const seed = await seedOrder({ discountTotal: 2_000 });

    const first = await capture.execute({ paymentId: seed.paymentId });
    const replay = await capture.execute({ paymentId: seed.paymentId });

    expect(first.replay).toBe(false);
    expect(replay.replay).toBe(true);

    // The deterministic `CAPTURE-<paymentId>` reference is `@unique`, so the second attempt cannot
    // post anything. Were it able to, the platform would book the discount as an expense twice.
    expect(await ctx.prisma.ledgerTransaction.count({ where: { type: 'CAPTURE' } })).toBe(1);
    expect(await balanceOf(promotionRef())).toBe(-2_000);
  });

  it('a capture webhook after a command capture adds nothing', async () => {
    const seed = await seedOrder({ discountTotal: 2_000 });
    await capture.execute({ paymentId: seed.paymentId });

    await processWebhook.execute(
      signed({
        id: `evt-${randomUUID()}`,
        type: 'payment.captured',
        paymentId: seed.paymentId,
        providerRef: 'gw-late-callback',
      }),
    );

    expect(await ctx.prisma.ledgerTransaction.count({ where: { type: 'CAPTURE' } })).toBe(1);
    expect(await balanceOf(promotionRef())).toBe(-2_000);
    const { debits, credits } = await ledgerConservesMoney();
    expect(debits).toBe(credits);
  });

  // -------------------------------------------------------------------------------------------
  // Refunds
  // -------------------------------------------------------------------------------------------

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

  it('a full refund reverses the promotion expense along with every other capture leg', async () => {
    const seed = await seedOrder({ discountTotal: 2_000 });
    await capture.execute({ paymentId: seed.paymentId });

    const result = await refund.execute(manualRefund(seed.paymentId));
    expect(result.amount).toBe(9_000);

    // Every account the capture moved is back to zero. The platform is no longer subsidising an
    // order that no longer exists, and the pharmacy keeps none of the money.
    expect(await balanceOf(promotionRef())).toBe(0);
    expect(await balanceOf(revenueRef())).toBe(0);
    expect(await balanceOf(AccountRef.providerPayable(seed.pharmacyId, 'ETB'))).toBe(0);
    expect(await balanceOf(gatewayRef())).toBe(0);

    // The mirror of the capture: what it debited, this credits.
    expect(await legsOf(`REFUND-${result.refundId}`)).toEqual([
      {
        type: LedgerAccountType.GATEWAY_CLEARING,
        ownerId: null,
        direction: LedgerDirection.CREDIT,
        amount: 9_000,
      },
      {
        type: LedgerAccountType.PLATFORM_REVENUE,
        ownerId: null,
        direction: LedgerDirection.DEBIT,
        amount: 1_000,
      },
      {
        type: LedgerAccountType.PROMOTION_EXPENSE,
        ownerId: null,
        direction: LedgerDirection.CREDIT,
        amount: 2_000,
      },
      {
        type: LedgerAccountType.PROVIDER_PAYABLE,
        ownerId: seed.pharmacyId,
        direction: LedgerDirection.DEBIT,
        amount: 10_000,
      },
    ]);

    const { debits, credits } = await ledgerConservesMoney();
    expect(debits).toBe(credits);
  });

  it('a partial refund reverses the proportional share of the promotion expense', async () => {
    const seed = await seedOrder({ discountTotal: 2_000 });
    await capture.execute({ paymentId: seed.paymentId });

    // A quarter of the 9_000 captured.
    const result = await refund.execute(manualRefund(seed.paymentId, { amount: 2_250 }));
    expect(result.amount).toBe(2_250);

    // ADR-016's proportional rule applied to each historical leg: a quarter of the 1_000 fee and a
    // quarter of the 2_000 expense. The provider leg is the remainder, 2_250 + 500 - 250 = 2_500,
    // which is exactly a quarter of the 10_000 the capture credited it.
    expect(await balanceOf(revenueRef())).toBe(750);
    expect(await balanceOf(promotionRef())).toBe(-1_500);
    expect(await balanceOf(AccountRef.providerPayable(seed.pharmacyId, 'ETB'))).toBe(7_500);
    expect(await balanceOf(gatewayRef())).toBe(-6_750);

    const { debits, credits } = await ledgerConservesMoney();
    expect(debits).toBe(credits);
  });

  it('partial refunds to 100% leave no promotion residue, whatever the rounding', async () => {
    // 7_777 + 1_111 + 333 - 1_000 = 8_221 captured against a 1_000 expense — deliberately a total
    // that divides into nothing cleanly, so every increment rounds.
    const seed = await seedOrder({
      subtotal: 7_777,
      deliveryFee: 1_111,
      platformFee: 333,
      discountTotal: 1_000,
    });
    await capture.execute({ paymentId: seed.paymentId });
    expect(await balanceOf(gatewayRef())).toBe(-8_221);

    for (const amount of [1_111, 2_222, 3_333]) {
      await refund.execute(manualRefund(seed.paymentId, { amount }));
    }
    // The remainder, taken as a full refund of what is left.
    await refund.execute(manualRefund(seed.paymentId));

    // The cumulative-allocation rule makes the roundings telescope, so all three capture legs
    // return to exactly zero rather than to "nearly zero" — a ledger that never reconciles is the
    // failure this arithmetic exists to prevent.
    expect(await balanceOf(promotionRef())).toBe(0);
    expect(await balanceOf(revenueRef())).toBe(0);
    expect(await balanceOf(AccountRef.providerPayable(seed.pharmacyId, 'ETB'))).toBe(0);
    expect(await balanceOf(gatewayRef())).toBe(0);

    const { debits, credits } = await ledgerConservesMoney();
    expect(debits).toBe(credits);
  });
});
