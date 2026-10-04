import { randomUUID } from 'crypto';
import { AuthorizePaymentCommand } from '../../src/modules/payment/application/commands/authorize-payment.command';
import { CapturePaymentCommand } from '../../src/modules/payment/application/commands/capture-payment.command';
import {
  RefundInitiator,
  RefundPaymentCommand,
  RefundPaymentInput,
} from '../../src/modules/payment/application/commands/refund-payment.command';
import { ListPaymentRefundsQuery } from '../../src/modules/payment/application/queries/list-payment-refunds.query';
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
  LedgerAccountType,
  LedgerDirection,
  PaymentMethod,
  PaymentStatus,
  RefundDestination,
  RefundStatus,
  RefundType,
} from '../../src/modules/payment/domain/enums';
import { LedgerService } from '../../src/modules/payment/domain/services/ledger.service';
import { AccountRef } from '../../src/modules/payment/domain/value-objects/account-ref.vo';
import { ApiException } from '../../src/shared/errors/api-exception';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

/**
 * Refunds against real PostgreSQL (§3.2, §9.3, §11.4, BRULE-24).
 *
 * A gateway double at the infrastructure boundary is the only thing replaced. Everything else is
 * real: real `AppModule` wiring, real commands, real Prisma repositories, real `Serializable`
 * transactions, the real immutable ledger with its append-only triggers, and real PostgreSQL. That
 * matters more here than anywhere else in Module 07, because the over-refund invariant is enforced
 * by PostgreSQL's serializable snapshot isolation — a test against an in-memory double could not
 * observe whether it actually holds.
 *
 * No external payment service is contacted, and none could be. Telebirr in particular is never
 * reached: it is unavailable by construction and refuses every operation.
 */
class FakeGateway implements IPaymentProviderPort {
  readonly key = 'fake-gateway';
  readonly refundRequests: ProviderRefundRequest[] = [];
  nextRefund: ProviderRefundResult | Error = { outcome: 'REFUNDED', providerRef: null };
  refundDelayMs = 0;

  supports(method: PaymentMethod): boolean {
    return method !== PaymentMethod.COD && method !== PaymentMethod.WALLET;
  }

  async authorize(request: ProviderAuthorizationRequest): Promise<ProviderAuthorizationResult> {
    return { outcome: 'AUTHORIZED', providerRef: `gw-auth-${request.paymentId}` };
  }

  async capture(request: ProviderPaymentOperationRequest): Promise<ProviderCaptureResult> {
    return { outcome: 'CAPTURED', providerRef: `gw-capture-${request.paymentId}` };
  }

  async voidAuthorization(request: ProviderPaymentOperationRequest): Promise<ProviderVoidResult> {
    return { outcome: 'VOIDED', providerRef: `gw-void-${request.paymentId}` };
  }

  async refund(request: ProviderRefundRequest): Promise<ProviderRefundResult> {
    this.refundRequests.push(request);
    if (this.refundDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.refundDelayMs));
    }
    if (this.nextRefund instanceof Error) {
      throw this.nextRefund;
    }
    return {
      ...this.nextRefund,
      providerRef: this.nextRefund.providerRef ?? `gw-refund-${request.refundId}`,
    };
  }
}

describe('Payment refunds (e2e)', () => {
  let ctx: TestContext;
  let gateway: FakeGateway;
  let authorize: AuthorizePaymentCommand;
  let capture: CapturePaymentCommand;
  let refund: RefundPaymentCommand;
  let listRefunds: ListPaymentRefundsQuery;
  let ledger: LedgerService;

  beforeAll(async () => {
    gateway = new FakeGateway();
    ctx = await createTestApp([{ provide: PAYMENT_PROVIDER_PORT, useValue: gateway }]);
    authorize = ctx.app.get(AuthorizePaymentCommand);
    capture = ctx.app.get(CapturePaymentCommand);
    refund = ctx.app.get(RefundPaymentCommand);
    listRefunds = ctx.app.get(ListPaymentRefundsQuery);
    ledger = ctx.app.get(LedgerService);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
    gateway.refundRequests.length = 0;
    gateway.nextRefund = { outcome: 'REFUNDED', providerRef: null };
    gateway.refundDelayMs = 0;
  });

  /**
   * Seeds a Module 06 order with its single `Fulfillment`, then authorizes and captures a payment
   * through the real commands — so the refund reverses a capture posting that was genuinely
   * written by `CaptureAccountingService`, not one fabricated by the fixture.
   */
  async function seedCapturedPayment(
    options: { grandTotal?: number; platformFee?: number } = {},
  ) {
    const grandTotal = options.grandTotal ?? 10_000;
    const platformFee = options.platformFee ?? 0;
    const customerUserId = `customer-${randomUUID()}`;
    const pharmacyId = `pharmacy-${randomUUID()}`;

    const order = await ctx.prisma.order.create({
      data: {
        orderNumber: `ORD-${randomUUID()}`,
        customerUserId,
        status: 'PENDING_PAYMENT',
        subtotal: grandTotal - platformFee,
        deliveryFee: 0,
        platformFee,
        discountTotal: 0,
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
    await capture.execute({ paymentId: authorized.paymentId });

    return {
      paymentId: authorized.paymentId,
      orderId: order.id,
      customerUserId,
      pharmacyId,
      grandTotal,
      platformFee,
    };
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

  async function balanceOf(ref: AccountRef): Promise<number> {
    const account = await ledger.resolveAccount(ref);
    return (await ledger.balanceOf(account.id)).amountMinor;
  }

  async function codeOf(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
      throw new Error('expected the operation to be rejected');
    } catch (err) {
      if (err instanceof ApiException) {
        return err.code;
      }
      throw err;
    }
  }

  // -----------------------------------------------------------------------------------------
  // Full and partial refunds
  // -----------------------------------------------------------------------------------------

  it('refunds a captured payment in full and persists the refund, the payment state and the ledger', async () => {
    const seed = await seedCapturedPayment();

    const result = await refund.execute(manualRefund(seed.paymentId));

    expect(result.type).toBe(RefundType.FULL);
    expect(result.amount).toBe(10_000);
    expect(result.status).toBe(RefundStatus.COMPLETED);
    expect(result.remainingRefundable).toBe(0);

    const row = await ctx.prisma.refund.findUniqueOrThrow({ where: { id: result.refundId } });
    expect(row.paymentId).toBe(seed.paymentId);
    expect(row.amount).toBe(10_000);
    expect(row.type).toBe('FULL');
    expect(row.destination).toBe('ORIGINAL');
    expect(row.status).toBe('COMPLETED');
    expect(row.completedAt).toBeInstanceOf(Date);
    expect(row.providerRef).toBe(`gw-refund-${result.refundId}`);

    const payment = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: seed.paymentId } });
    expect(payment.status).toBe('REFUNDED');
  });

  it('refunds partially and moves the payment to PARTIALLY_REFUNDED', async () => {
    const seed = await seedCapturedPayment();

    const result = await refund.execute(manualRefund(seed.paymentId, { amount: 3_500 }));

    expect(result.type).toBe(RefundType.PARTIAL);
    expect(result.remainingRefundable).toBe(6_500);

    const payment = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: seed.paymentId } });
    expect(payment.status).toBe('PARTIALLY_REFUNDED');
  });

  it("posts the design's balanced refund transaction, reversing the capture (§11.4)", async () => {
    const seed = await seedCapturedPayment();

    const result = await refund.execute(manualRefund(seed.paymentId));

    const txn = await ctx.prisma.ledgerTransaction.findUniqueOrThrow({
      where: { reference: `REFUND-${result.refundId}` },
      include: { entries: { include: { account: true } } },
    });
    expect(result.ledgerReference).toBe(txn.reference);
    expect(txn.type).toBe('REFUND');
    expect(txn.refType).toBe('refund');
    expect(txn.refId).toBe(result.refundId);

    const leg = (type: LedgerAccountType) =>
      txn.entries.find((entry) => entry.account.type === type);
    expect(leg(LedgerAccountType.PROVIDER_PAYABLE)).toMatchObject({
      direction: LedgerDirection.DEBIT,
      amount: 10_000,
    });
    expect(leg(LedgerAccountType.GATEWAY_CLEARING)).toMatchObject({
      direction: LedgerDirection.CREDIT,
      amount: 10_000,
    });
    // The payable clawed back is the pharmacy the capture credited — resolved from the ledger, not
    // from any caller input.
    expect(leg(LedgerAccountType.PROVIDER_PAYABLE)?.account.ownerId).toBe(seed.pharmacyId);

    // Σ debits = Σ credits, read back off the persisted rows.
    const sum = (direction: LedgerDirection) =>
      txn.entries
        .filter((entry) => entry.direction === direction)
        .reduce((total, entry) => total + entry.amount, 0);
    expect(sum(LedgerDirection.DEBIT)).toBe(sum(LedgerDirection.CREDIT));

    // Capture then full refund nets every account back to zero.
    expect(await balanceOf(AccountRef.providerPayable(seed.pharmacyId))).toBe(0);
    expect(await balanceOf(AccountRef.platform(LedgerAccountType.GATEWAY_CLEARING))).toBe(0);
  });

  it('reverses a fee-bearing capture exactly on a full refund', async () => {
    const seed = await seedCapturedPayment({ grandTotal: 10_000, platformFee: 1_000 });
    // Guard: the capture really did credit a platform fee, so this is not a zero-fee case in
    // disguise.
    expect(await balanceOf(AccountRef.platform(LedgerAccountType.PLATFORM_REVENUE))).toBe(1_000);

    await refund.execute(manualRefund(seed.paymentId));

    expect(await balanceOf(AccountRef.platform(LedgerAccountType.PLATFORM_REVENUE))).toBe(0);
    expect(await balanceOf(AccountRef.providerPayable(seed.pharmacyId))).toBe(0);
  });

  /**
   * ADR-016 end to end against a real fee-bearing capture: three partial refunds that together
   * exhaust the payment, with every posting read back off PostgreSQL. What is proved here is not
   * one arithmetic result but the closing property — the fee clawbacks sum to exactly the fee that
   * was captured, so `PLATFORM_REVENUE` lands on zero rather than on a residue.
   */
  it('claws the platform fee back proportionally across a sequence of partial refunds', async () => {
    const seed = await seedCapturedPayment({ grandTotal: 10_000, platformFee: 1_000 });
    expect(await balanceOf(AccountRef.platform(LedgerAccountType.PLATFORM_REVENUE))).toBe(1_000);
    expect(await balanceOf(AccountRef.providerPayable(seed.pharmacyId))).toBe(9_000);

    const first = await refund.execute(manualRefund(seed.paymentId, { amount: 3_333 }));
    const second = await refund.execute(manualRefund(seed.paymentId, { amount: 3_333 }));
    const third = await refund.execute(manualRefund(seed.paymentId, { amount: 3_334 }));

    const postings = await Promise.all(
      [first, second, third].map((result) =>
        ctx.prisma.ledgerTransaction.findUniqueOrThrow({
          where: { reference: `REFUND-${result.refundId}` },
          include: { entries: { include: { account: true } } },
        }),
      ),
    );

    const legAmount = (
      posting: (typeof postings)[number],
      type: LedgerAccountType,
      direction: LedgerDirection,
    ) =>
      posting.entries
        .filter((entry) => entry.account.type === type && entry.direction === direction)
        .reduce((total, entry) => total + entry.amount, 0);

    // round(1000 x 3333/10000) = 333; then 667 - 333 = 334; then 1000 - 667 = 333.
    const feeDebits = postings.map((posting) =>
      legAmount(posting, LedgerAccountType.PLATFORM_REVENUE, LedgerDirection.DEBIT),
    );
    expect(feeDebits).toEqual([333, 334, 333]);
    expect(feeDebits.reduce((a, b) => a + b, 0)).toBe(1_000);

    const payableDebits = postings.map((posting) =>
      legAmount(posting, LedgerAccountType.PROVIDER_PAYABLE, LedgerDirection.DEBIT),
    );
    expect(payableDebits).toEqual([3_000, 2_999, 3_001]);
    expect(payableDebits.reduce((a, b) => a + b, 0)).toBe(9_000);

    // Every posting balances, uses one currency, and is keyed to its own refund.
    for (const posting of postings) {
      const debit = posting.entries
        .filter((entry) => entry.direction === LedgerDirection.DEBIT)
        .reduce((total, entry) => total + entry.amount, 0);
      const credit = posting.entries
        .filter((entry) => entry.direction === LedgerDirection.CREDIT)
        .reduce((total, entry) => total + entry.amount, 0);
      expect(debit).toBe(credit);
      expect(new Set(posting.entries.map((entry) => entry.currency)).size).toBe(1);
      expect(posting.refType).toBe('refund');
      expect(posting.type).toBe('REFUND');
    }

    // The books close exactly — no residue anywhere.
    expect(await balanceOf(AccountRef.platform(LedgerAccountType.PLATFORM_REVENUE))).toBe(0);
    expect(await balanceOf(AccountRef.providerPayable(seed.pharmacyId))).toBe(0);
    expect(await balanceOf(AccountRef.platform(LedgerAccountType.GATEWAY_CLEARING))).toBe(0);

    const payment = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: seed.paymentId } });
    expect(payment.status).toBe('REFUNDED');
  });

  it('does not post the fee clawback twice when a fee-bearing refund is replayed', async () => {
    const seed = await seedCapturedPayment({ grandTotal: 10_000, platformFee: 1_000 });
    const request = manualRefund(seed.paymentId, { amount: 3_333 });
    await refund.execute(request);

    await refund.execute(request);

    expect(await ctx.prisma.ledgerTransaction.count({ where: { type: 'REFUND' } })).toBe(1);
    expect(await balanceOf(AccountRef.platform(LedgerAccountType.PLATFORM_REVENUE))).toBe(667);
    expect(gateway.refundRequests).toHaveLength(1);
  });

  it('keeps the fee split exact when two fee-bearing refunds run concurrently', async () => {
    const seed = await seedCapturedPayment({ grandTotal: 10_000, platformFee: 1_000 });
    gateway.refundDelayMs = 40;

    const results = await Promise.allSettled([
      refund.execute(manualRefund(seed.paymentId, { amount: 3_333 })),
      refund.execute(manualRefund(seed.paymentId, { amount: 6_667 })),
    ]);

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    // Whichever order they serialized in, the cumulative formula closes the books exactly.
    expect(await balanceOf(AccountRef.platform(LedgerAccountType.PLATFORM_REVENUE))).toBe(0);
    expect(await balanceOf(AccountRef.providerPayable(seed.pharmacyId))).toBe(0);
    expect(await ctx.prisma.ledgerTransaction.count({ where: { type: 'REFUND' } })).toBe(2);
  });

  it('cannot over-refund a fee-bearing capture even under a concurrent race', async () => {
    const seed = await seedCapturedPayment({ grandTotal: 10_000, platformFee: 1_000 });
    gateway.refundDelayMs = 40;

    const results = await Promise.allSettled([
      refund.execute(manualRefund(seed.paymentId, { amount: 10_000 })),
      refund.execute(manualRefund(seed.paymentId, { amount: 10_000 })),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await ctx.prisma.refund.count({ where: { paymentId: seed.paymentId } })).toBe(1);
    expect(await balanceOf(AccountRef.platform(LedgerAccountType.PLATFORM_REVENUE))).toBe(0);
    expect(await balanceOf(AccountRef.providerPayable(seed.pharmacyId))).toBe(0);
  });

  it('applies the same fee clawback to a wallet refund, changing only the destination', async () => {
    const seed = await seedCapturedPayment({ grandTotal: 10_000, platformFee: 1_000 });

    const result = await refund.execute(
      manualRefund(seed.paymentId, { amount: 3_333, destination: RefundDestination.WALLET }),
    );

    const posting = await ctx.prisma.ledgerTransaction.findUniqueOrThrow({
      where: { reference: `REFUND-${result.refundId}` },
      include: { entries: { include: { account: true } } },
    });
    const leg = (type: LedgerAccountType) =>
      posting.entries.find((entry) => entry.account.type === type);

    expect(leg(LedgerAccountType.PLATFORM_REVENUE)).toMatchObject({
      direction: LedgerDirection.DEBIT,
      amount: 333,
    });
    expect(leg(LedgerAccountType.PROVIDER_PAYABLE)).toMatchObject({
      direction: LedgerDirection.DEBIT,
      amount: 3_000,
    });
    expect(leg(LedgerAccountType.CUSTOMER_WALLET)).toMatchObject({
      direction: LedgerDirection.CREDIT,
      amount: 3_333,
    });
    // No gateway leg, and no external call — the ledger credit is the refund.
    expect(leg(LedgerAccountType.GATEWAY_CLEARING)).toBeUndefined();
    expect(gateway.refundRequests).toHaveLength(0);
    expect(await balanceOf(AccountRef.customerWallet(seed.customerUserId))).toBe(3_333);
  });

  it('leaves the capture posting untouched when a fee-bearing refund reverses it', async () => {
    const seed = await seedCapturedPayment({ grandTotal: 10_000, platformFee: 1_000 });
    const before = await ctx.prisma.ledgerEntry.findMany({
      where: { transaction: { reference: `CAPTURE-${seed.paymentId}` } },
      orderBy: { id: 'asc' },
    });

    await refund.execute(manualRefund(seed.paymentId, { amount: 3_333 }));

    const after = await ctx.prisma.ledgerEntry.findMany({
      where: { transaction: { reference: `CAPTURE-${seed.paymentId}` } },
      orderBy: { id: 'asc' },
    });
    expect(after).toEqual(before);
  });

  it('credits the customer wallet for a WALLET refund without calling the gateway', async () => {
    const seed = await seedCapturedPayment();

    const result = await refund.execute(
      manualRefund(seed.paymentId, { destination: RefundDestination.WALLET }),
    );

    expect(gateway.refundRequests).toHaveLength(0);
    expect(result.status).toBe(RefundStatus.COMPLETED);

    // The wallet balance is derived from the ledger (§3.3 F-WAL-01) — no wallet table, no stored
    // balance, and no mutable user balance field anywhere.
    expect(await balanceOf(AccountRef.customerWallet(seed.customerUserId))).toBe(10_000);
    expect(await balanceOf(AccountRef.providerPayable(seed.pharmacyId))).toBe(0);
  });

  // -----------------------------------------------------------------------------------------
  // BRULE-24: over-refund protection
  // -----------------------------------------------------------------------------------------

  it('rejects a refund beyond the remaining amount', async () => {
    const seed = await seedCapturedPayment();
    await refund.execute(manualRefund(seed.paymentId, { amount: 8_000 }));

    const code = await codeOf(refund.execute(manualRefund(seed.paymentId, { amount: 2_500 })));

    expect(code).toBe(ErrorCode.REFUND_EXCEEDS_CAPTURED);
    expect(await ctx.prisma.refund.count({ where: { paymentId: seed.paymentId } })).toBe(1);
  });

  it.each([
    ['an authorized payment', false],
    ['a voided payment', true],
  ])('refuses to refund %s — money was never captured', async (_label, voidIt) => {
    const customerUserId = `customer-${randomUUID()}`;
    const order = await ctx.prisma.order.create({
      data: {
        orderNumber: `ORD-${randomUUID()}`,
        customerUserId,
        status: 'PENDING_PAYMENT',
        subtotal: 5_000,
        deliveryFee: 0,
        platformFee: 0,
        discountTotal: 0,
        grandTotal: 5_000,
        currency: 'ETB',
        idempotencyKey: `checkout-${randomUUID()}`,
        isCod: false,
      },
    });
    await ctx.prisma.fulfillment.create({
      data: { orderId: order.id, pharmacyId: `pharmacy-${randomUUID()}`, branchId: `branch-${randomUUID()}` },
    });
    const authorized = await authorize.execute({
      customerUserId,
      orderId: order.id,
      method: PaymentMethod.TELEBIRR,
      idempotencyKey: `pay-${randomUUID()}`,
    });
    if (voidIt) {
      await ctx.prisma.payment.update({
        where: { id: authorized.paymentId },
        data: { status: PaymentStatus.VOIDED },
      });
    }

    expect(await codeOf(refund.execute(manualRefund(authorized.paymentId, { amount: 100 })))).toBe(
      ErrorCode.REFUND_NOT_ELIGIBLE,
    );
    expect(await ctx.prisma.refund.count()).toBe(0);
    expect(gateway.refundRequests).toHaveLength(0);
  });

  /**
   * The invariant that cannot be a database constraint. Two concurrent requests each ask for the
   * whole captured amount; the reservation transaction reads the refunded sum and inserts inside
   * one `Serializable` transaction, so PostgreSQL's SSI aborts one, the bounded retry re-runs it
   * against the winner's committed row, and it is correctly rejected.
   */
  it('lets only one of two concurrent full refunds succeed, against real Serializable isolation', async () => {
    const seed = await seedCapturedPayment();
    gateway.refundDelayMs = 40;

    const results = await Promise.allSettled([
      refund.execute(manualRefund(seed.paymentId, { amount: 10_000 })),
      refund.execute(manualRefund(seed.paymentId, { amount: 10_000 })),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0].reason as ApiException).code).toBe(ErrorCode.REFUND_EXCEEDS_CAPTURED);

    // The books agree: exactly one refund, one posting, and no over-refund.
    const rows = await ctx.prisma.refund.findMany({ where: { paymentId: seed.paymentId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(10_000);
    expect(await ctx.prisma.ledgerTransaction.count({ where: { type: 'REFUND' } })).toBe(1);
    expect(await balanceOf(AccountRef.providerPayable(seed.pharmacyId))).toBe(0);
  });

  it('lets two concurrent partial refunds that together fit both succeed', async () => {
    const seed = await seedCapturedPayment();
    gateway.refundDelayMs = 40;

    const results = await Promise.allSettled([
      refund.execute(manualRefund(seed.paymentId, { amount: 4_000 })),
      refund.execute(manualRefund(seed.paymentId, { amount: 6_000 })),
    ]);

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const rows = await ctx.prisma.refund.findMany({ where: { paymentId: seed.paymentId } });
    expect(rows).toHaveLength(2);
    expect(rows.reduce((total, row) => total + row.amount, 0)).toBe(10_000);
    expect(await balanceOf(AccountRef.providerPayable(seed.pharmacyId))).toBe(0);
  });

  // -----------------------------------------------------------------------------------------
  // Idempotency (BRULE-25)
  // -----------------------------------------------------------------------------------------

  it('replays a repeated refund request without refunding a second time', async () => {
    const seed = await seedCapturedPayment();
    const request = manualRefund(seed.paymentId, { amount: 2_000 });

    const first = await refund.execute(request);
    const second = await refund.execute(request);

    expect(second.refundId).toBe(first.refundId);
    expect(second.replay).toBe(true);
    // The gateway was asked exactly once, and exactly one posting exists.
    expect(gateway.refundRequests).toHaveLength(1);
    expect(await ctx.prisma.refund.count({ where: { paymentId: seed.paymentId } })).toBe(1);
    expect(await ctx.prisma.ledgerTransaction.count({ where: { type: 'REFUND' } })).toBe(1);
  });

  it('rejects an idempotency key reused for a different amount', async () => {
    const seed = await seedCapturedPayment();
    const key = `refund-${randomUUID()}`;
    await refund.execute(manualRefund(seed.paymentId, { amount: 2_000, idempotencyKey: key }));

    const code = await codeOf(
      refund.execute(manualRefund(seed.paymentId, { amount: 3_000, idempotencyKey: key })),
    );

    expect(code).toBe(ErrorCode.IDEMPOTENCY_CONFLICT);
    expect(await ctx.prisma.refund.count({ where: { paymentId: seed.paymentId } })).toBe(1);
  });

  // -----------------------------------------------------------------------------------------
  // Failure and ambiguity
  // -----------------------------------------------------------------------------------------

  it('marks a declined refund FAILED, posts nothing, and frees the amount to be refunded again', async () => {
    const seed = await seedCapturedPayment();
    gateway.nextRefund = { outcome: 'FAILED', providerRef: null, failureReason: 'not permitted' };

    await codeOf(refund.execute(manualRefund(seed.paymentId, { amount: 4_000 })));

    const [row] = await ctx.prisma.refund.findMany({ where: { paymentId: seed.paymentId } });
    expect(row.status).toBe('FAILED');
    expect(row.completedAt).toBeNull();
    expect(await ctx.prisma.ledgerTransaction.count({ where: { type: 'REFUND' } })).toBe(0);

    const payment = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: seed.paymentId } });
    expect(payment.status).toBe('CAPTURED');

    // The amount is refundable again — a declined refund moved no money.
    gateway.nextRefund = { outcome: 'REFUNDED', providerRef: null };
    const retry = await refund.execute(manualRefund(seed.paymentId));
    expect(retry.amount).toBe(10_000);
  });

  it('leaves an ambiguous refund PENDING and rolls back completely — nothing is recorded as refunded', async () => {
    const seed = await seedCapturedPayment();
    gateway.nextRefund = new Error('socket hang up');

    expect(await codeOf(refund.execute(manualRefund(seed.paymentId, { amount: 4_000 })))).toBe(
      ErrorCode.DEPENDENCY_UNAVAILABLE,
    );

    const [row] = await ctx.prisma.refund.findMany({ where: { paymentId: seed.paymentId } });
    expect(row.status).toBe('PENDING');
    expect(row.completedAt).toBeNull();
    expect(await ctx.prisma.ledgerTransaction.count({ where: { type: 'REFUND' } })).toBe(0);
    const payment = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: seed.paymentId } });
    expect(payment.status).toBe('CAPTURED');
    // The amount stays reserved: an in-flight refund may yet have succeeded at the gateway.
    expect(await balanceOf(AccountRef.providerPayable(seed.pharmacyId))).toBe(10_000);
  });

  it('resumes a PENDING refund on retry without creating a second refund or a second payout', async () => {
    const seed = await seedCapturedPayment();
    const request = manualRefund(seed.paymentId, { amount: 4_000 });
    gateway.nextRefund = new Error('socket hang up');
    await codeOf(refund.execute(request));

    gateway.nextRefund = { outcome: 'REFUNDED', providerRef: null };
    const resumed = await refund.execute(request);

    expect(resumed.status).toBe(RefundStatus.COMPLETED);
    expect(await ctx.prisma.refund.count({ where: { paymentId: seed.paymentId } })).toBe(1);
    expect(await ctx.prisma.ledgerTransaction.count({ where: { type: 'REFUND' } })).toBe(1);
    // Both gateway calls carried the same refund id — the provider-side idempotency identity.
    expect(new Set(gateway.refundRequests.map((r) => r.refundId)).size).toBe(1);
  });

  it('refuses to refund through Telebirr, which remains unintegrated and fail-closed', async () => {
    const seed = await seedCapturedPayment();
    await ctx.prisma.payment.update({
      where: { id: seed.paymentId },
      data: { provider: 'telebirr' },
    });

    const code = await codeOf(refund.execute(manualRefund(seed.paymentId, { amount: 1_000 })));

    expect(code).toBe(ErrorCode.DEPENDENCY_UNAVAILABLE);
    expect(await ctx.prisma.ledgerTransaction.count({ where: { type: 'REFUND' } })).toBe(0);
  });

  // -----------------------------------------------------------------------------------------
  // Authorization, audit and outbox (§9.3, §13)
  // -----------------------------------------------------------------------------------------

  it('refuses a manual refund from a caller without finance:refund:any', async () => {
    const seed = await seedCapturedPayment();

    const code = await codeOf(
      refund.execute(
        manualRefund(seed.paymentId, {
          amount: 1_000,
          actorUserId: seed.customerUserId,
          // A CUSTOMER's real permission set from the RBAC catalog — it has no refund permission.
          actorPermissions: ['payment:create:own', 'payment:read:own', 'order:read:own'],
        }),
      ),
    );

    expect(code).toBe(ErrorCode.RBAC_FORBIDDEN);
    expect(await ctx.prisma.refund.count()).toBe(0);
    expect(gateway.refundRequests).toHaveLength(0);
  });

  it('records the approving actor and §13\'s audit fields, and writes payment.refunded', async () => {
    const seed = await seedCapturedPayment();
    const actorUserId = `finance-${randomUUID()}`;

    const result = await refund.execute(
      manualRefund(seed.paymentId, { amount: 2_500, actorUserId }),
    );

    const row = await ctx.prisma.refund.findUniqueOrThrow({ where: { id: result.refundId } });
    expect(row.approvedBy).toBe(actorUserId);

    const audit = await ctx.prisma.auditLog.findFirst({
      where: { action: 'PAYMENT_REFUNDED', resourceId: result.refundId },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actorUserId).toBe(actorUserId);
    expect(audit?.context).toMatchObject({
      refundId: result.refundId,
      paymentId: seed.paymentId,
      orderId: seed.orderId,
      amount: 2_500,
      currency: 'ETB',
      type: 'PARTIAL',
      destination: 'ORIGINAL',
      approvedBy: actorUserId,
      ledgerReference: `REFUND-${result.refundId}`,
    });

    const outbox = await ctx.prisma.outbox.findMany({ where: { eventType: 'payment.refunded' } });
    expect(outbox).toHaveLength(1);
    expect(outbox[0].aggregateId).toBe(seed.paymentId);
  });

  // -----------------------------------------------------------------------------------------
  // The refunds query (§9.3)
  // -----------------------------------------------------------------------------------------

  it('lists a payment\'s refunds with the remaining refundable amount', async () => {
    const seed = await seedCapturedPayment();
    await refund.execute(manualRefund(seed.paymentId, { amount: 2_000 }));
    await refund.execute(manualRefund(seed.paymentId, { amount: 3_000 }));

    const view = await listRefunds.execute({
      paymentId: seed.paymentId,
      customerUserId: seed.customerUserId,
    });

    expect(view.capturedAmount).toBe(10_000);
    expect(view.totalRefunded).toBe(5_000);
    expect(view.remainingRefundable).toBe(5_000);
    expect(view.refunds).toHaveLength(2);
    expect(view.refunds[0]).toMatchObject({ amount: 2_000, status: RefundStatus.COMPLETED });
  });

  it('returns the same not-found for another customer\'s payment as for one that does not exist', async () => {
    const seed = await seedCapturedPayment();
    await refund.execute(manualRefund(seed.paymentId, { amount: 1_000 }));

    const foreign = await codeOf(
      listRefunds.execute({ paymentId: seed.paymentId, customerUserId: `other-${randomUUID()}` }),
    );
    const missing = await codeOf(
      listRefunds.execute({ paymentId: randomUUID(), customerUserId: seed.customerUserId }),
    );

    expect(foreign).toBe(ErrorCode.NOT_FOUND);
    expect(missing).toBe(foreign);
  });

  it('exposes no provider token, idempotency key, approver or ledger internals in the refunds view', async () => {
    const seed = await seedCapturedPayment();
    const result = await refund.execute(manualRefund(seed.paymentId, { amount: 1_000 }));

    const view = await listRefunds.execute({ paymentId: seed.paymentId });

    expect(Object.keys(view.refunds[0]).sort()).toEqual(
      [
        'amount',
        'completedAt',
        'createdAt',
        'currency',
        'destination',
        'paymentId',
        'providerRef',
        'reason',
        'refundId',
        'status',
        'type',
      ].sort(),
    );
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('idempotencyKey');
    expect(serialized).not.toContain('approvedBy');
    expect(serialized).not.toContain('accountId');
    // And no card data — there is none in this module to leak.
    for (const forbidden of ['pan', 'cardNumber', 'cvv']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    expect(result.refundId).toBeDefined();
  });

  // -----------------------------------------------------------------------------------------
  // Final payment state after a sequence of partial refunds (ADR-018)
  // -----------------------------------------------------------------------------------------

  /**
   * ADR-018's transition, end to end against real PostgreSQL: a captured payment, one partial
   * refund, then the partial refund that exhausts the remainder — and the payment lands in
   * `REFUNDED`, not `PARTIALLY_REFUNDED`. Both refunds and both postings are real persisted rows,
   * and the state is read back off the database rather than from the command's return value.
   */
  it('captured -> partial refund -> closing partial refund -> payment is REFUNDED', async () => {
    const seed = await seedCapturedPayment();

    const first = await refund.execute(manualRefund(seed.paymentId, { amount: 6_000 }));
    expect(first.paymentStatus).toBe(PaymentStatus.PARTIALLY_REFUNDED);
    const afterFirst = await ctx.prisma.payment.findUniqueOrThrow({
      where: { id: seed.paymentId },
    });
    expect(afterFirst.status).toBe('PARTIALLY_REFUNDED');

    const closing = await refund.execute(manualRefund(seed.paymentId, { amount: 4_000 }));

    expect(closing.status).toBe(RefundStatus.COMPLETED);
    expect(closing.remainingRefundable).toBe(0);
    expect(closing.paymentStatus).toBe(PaymentStatus.REFUNDED);

    const payment = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: seed.paymentId } });
    expect(payment.status).toBe('REFUNDED');

    const audit = await ctx.prisma.auditLog.findFirst({
      where: { action: 'PAYMENT_REFUNDED', resourceId: closing.refundId },
    });
    expect(audit?.context).toMatchObject({
      paymentStatusAdvanced: true,
      paymentStatus: 'REFUNDED',
    });

    // Two persisted refunds, two persisted postings, and the money fully reversed.
    const rows = await ctx.prisma.refund.findMany({ where: { paymentId: seed.paymentId } });
    expect(rows.map((row) => row.status)).toEqual(['COMPLETED', 'COMPLETED']);
    expect(await ctx.prisma.ledgerTransaction.count({ where: { type: 'REFUND' } })).toBe(2);
    expect(await balanceOf(AccountRef.providerPayable(seed.pharmacyId))).toBe(0);

    const view = await listRefunds.execute({ paymentId: seed.paymentId });
    expect(view.totalRefunded).toBe(10_000);
    expect(view.remainingRefundable).toBe(0);
  });

  it('reaches REFUNDED through an uneven sequence that lands exactly on the captured amount', async () => {
    const seed = await seedCapturedPayment();

    const statuses: PaymentStatus[] = [];
    for (const amount of [1_000, 3_000, 6_000]) {
      statuses.push((await refund.execute(manualRefund(seed.paymentId, { amount }))).paymentStatus);
    }

    expect(statuses).toEqual([
      PaymentStatus.PARTIALLY_REFUNDED,
      PaymentStatus.PARTIALLY_REFUNDED,
      PaymentStatus.REFUNDED,
    ]);
    const payment = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: seed.paymentId } });
    expect(payment.status).toBe('REFUNDED');
    expect(await balanceOf(AccountRef.providerPayable(seed.pharmacyId))).toBe(0);
  });

  it('stays PARTIALLY_REFUNDED while a remainder is left, and refuses a further refund once REFUNDED', async () => {
    const seed = await seedCapturedPayment();
    await refund.execute(manualRefund(seed.paymentId, { amount: 4_000 }));

    const stillPartial = await ctx.prisma.payment.findUniqueOrThrow({
      where: { id: seed.paymentId },
    });
    expect(stillPartial.status).toBe('PARTIALLY_REFUNDED');

    // Over-refunding the remainder is still rejected, and the state is unchanged.
    expect(await codeOf(refund.execute(manualRefund(seed.paymentId, { amount: 6_001 })))).toBe(
      ErrorCode.REFUND_EXCEEDS_CAPTURED,
    );
    expect(
      (await ctx.prisma.payment.findUniqueOrThrow({ where: { id: seed.paymentId } })).status,
    ).toBe('PARTIALLY_REFUNDED');

    // Closing it out moves the payment to REFUNDED, after which nothing further is accepted.
    await refund.execute(manualRefund(seed.paymentId, { amount: 6_000 }));
    expect(
      (await ctx.prisma.payment.findUniqueOrThrow({ where: { id: seed.paymentId } })).status,
    ).toBe('REFUNDED');
    expect(await codeOf(refund.execute(manualRefund(seed.paymentId, { amount: 1 })))).toBe(
      ErrorCode.REFUND_NOT_ELIGIBLE,
    );
    expect(await ctx.prisma.refund.count({ where: { paymentId: seed.paymentId } })).toBe(2);
  });

  // -----------------------------------------------------------------------------------------
  // Immutability
  // -----------------------------------------------------------------------------------------

  it('cannot rewrite a refund posting — the ledger stays append-only', async () => {
    const seed = await seedCapturedPayment();
    const result = await refund.execute(manualRefund(seed.paymentId, { amount: 1_000 }));
    const txn = await ctx.prisma.ledgerTransaction.findUniqueOrThrow({
      where: { reference: `REFUND-${result.refundId}` },
    });

    await expect(
      ctx.prisma.ledgerEntry.updateMany({
        where: { transactionId: txn.id },
        data: { amount: 1 },
      }),
    ).rejects.toBeDefined();
    await expect(
      ctx.prisma.ledgerTransaction.delete({ where: { id: txn.id } }),
    ).rejects.toBeDefined();
  });
});
