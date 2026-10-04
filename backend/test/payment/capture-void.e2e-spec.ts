import { randomUUID } from 'crypto';
import {
  AuthorizePaymentCommand,
} from '../../src/modules/payment/application/commands/authorize-payment.command';
import {
  CapturePaymentCommand,
} from '../../src/modules/payment/application/commands/capture-payment.command';
import { VoidPaymentCommand } from '../../src/modules/payment/application/commands/void-payment.command';
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
} from '../../src/modules/payment/domain/enums';
import { LedgerService } from '../../src/modules/payment/domain/services/ledger.service';
import { AccountRef } from '../../src/modules/payment/domain/value-objects/account-ref.vo';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

/**
 * A gateway double at the infrastructure boundary — the only thing replaced. Everything else is
 * real: real `AppModule` wiring, real commands, real Prisma repositories, real `Serializable`
 * transactions, the real immutable ledger with its append-only triggers, and real PostgreSQL.
 * No external payment service is contacted, and none could be.
 */
class FakeGateway implements IPaymentProviderPort {
  readonly key = 'fake-gateway';
  readonly captureRequests: ProviderPaymentOperationRequest[] = [];
  readonly voidRequests: ProviderPaymentOperationRequest[] = [];
  nextCapture: ProviderCaptureResult | Error = { outcome: 'CAPTURED', providerRef: null };
  nextVoid: ProviderVoidResult | Error = { outcome: 'VOIDED', providerRef: null };
  captureDelayMs = 0;

  supports(method: PaymentMethod): boolean {
    return method !== PaymentMethod.COD && method !== PaymentMethod.WALLET;
  }

  async authorize(request: ProviderAuthorizationRequest): Promise<ProviderAuthorizationResult> {
    return { outcome: 'AUTHORIZED', providerRef: `gw-auth-${request.paymentId}` };
  }

  async capture(request: ProviderPaymentOperationRequest): Promise<ProviderCaptureResult> {
    this.captureRequests.push(request);
    if (this.captureDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.captureDelayMs));
    }
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
    this.voidRequests.push(request);
    if (this.nextVoid instanceof Error) {
      throw this.nextVoid;
    }
    return {
      ...this.nextVoid,
      providerRef: this.nextVoid.providerRef ?? `gw-void-${request.paymentId}`,
    };
  }

  /** Refunds have their own e2e spec; this exists so the double satisfies the port. */
  async refund(request: ProviderRefundRequest): Promise<ProviderRefundResult> {
    return { outcome: 'REFUNDED', providerRef: `gw-refund-${request.refundId}` };
  }
}

describe('Payment capture and void (e2e)', () => {
  let ctx: TestContext;
  let gateway: FakeGateway;
  let authorize: AuthorizePaymentCommand;
  let capture: CapturePaymentCommand;
  let voidPayment: VoidPaymentCommand;
  let ledger: LedgerService;

  beforeAll(async () => {
    gateway = new FakeGateway();
    ctx = await createTestApp([{ provide: PAYMENT_PROVIDER_PORT, useValue: gateway }]);
    authorize = ctx.app.get(AuthorizePaymentCommand);
    capture = ctx.app.get(CapturePaymentCommand);
    voidPayment = ctx.app.get(VoidPaymentCommand);
    ledger = ctx.app.get(LedgerService);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
    gateway.captureRequests.length = 0;
    gateway.voidRequests.length = 0;
    gateway.nextCapture = { outcome: 'CAPTURED', providerRef: null };
    gateway.nextVoid = { outcome: 'VOIDED', providerRef: null };
    gateway.captureDelayMs = 0;
  });

  /**
   * Seeds a Module 06 order in `PENDING_PAYMENT` with its single `Fulfillment` — the fulfillment
   * is what identifies the pharmacy whose `PROVIDER_PAYABLE` a capture credits, so it is part of
   * the fixture, never an input to the command. Module 06's own Slice-1 checkout is COD and
   * commits straight to `PAID`, and this task does not modify it, so the rows are seeded here.
   */
  async function seedAuthorizedPayment(
    options: { grandTotal?: number; platformFee?: number; withFulfillment?: boolean } = {},
  ) {
    const grandTotal = options.grandTotal ?? 10_000;
    const platformFee = options.platformFee ?? 1_000;
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

    if (options.withFulfillment !== false) {
      await ctx.prisma.fulfillment.create({
        data: { orderId: order.id, pharmacyId, branchId: `branch-${randomUUID()}` },
      });
    }

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
      grandTotal,
      platformFee,
    };
  }

  async function balanceOf(ref: AccountRef): Promise<number> {
    const account = await ledger.resolveAccount(ref);
    return (await ledger.balanceOf(account.id)).amountMinor;
  }

  // -------------------------------------------------------------------------------------------
  // Capture
  // -------------------------------------------------------------------------------------------

  it('captures an authorized payment and persists CAPTURED with the capture reference', async () => {
    const seed = await seedAuthorizedPayment();

    const result = await capture.execute({ paymentId: seed.paymentId });

    expect(result.status).toBe(PaymentStatus.CAPTURED);
    expect(result.replay).toBe(false);
    expect(gateway.captureRequests).toHaveLength(1);
    expect(gateway.captureRequests[0].amount).toBe(seed.grandTotal);

    const row = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: seed.paymentId } });
    expect(row.status).toBe('CAPTURED');
    expect(row.capturedAt).toBeInstanceOf(Date);
    expect(row.providerRef).toBe(`gw-capture-${seed.paymentId}`);
    // The authorization timestamp survives the capture.
    expect(row.authorizedAt).toBeInstanceOf(Date);
  });

  it("posts the design's balanced three-leg capture transaction (§11.3)", async () => {
    const seed = await seedAuthorizedPayment({ grandTotal: 10_000, platformFee: 1_000 });

    const result = await capture.execute({ paymentId: seed.paymentId });

    const txn = await ctx.prisma.ledgerTransaction.findUniqueOrThrow({
      where: { reference: `CAPTURE-${seed.paymentId}` },
      include: { entries: { include: { account: true } } },
    });
    expect(result.ledgerReference).toBe(txn.reference);
    expect(txn.type).toBe('CAPTURE');
    expect(txn.refType).toBe('payment');
    expect(txn.refId).toBe(seed.paymentId);
    expect(txn.entries).toHaveLength(3);

    const leg = (type: LedgerAccountType) =>
      txn.entries.find((entry) => entry.account.type === type);

    expect(leg(LedgerAccountType.GATEWAY_CLEARING)).toMatchObject({
      direction: LedgerDirection.DEBIT,
      amount: 10_000,
    });
    expect(leg(LedgerAccountType.PROVIDER_PAYABLE)).toMatchObject({
      direction: LedgerDirection.CREDIT,
      amount: 9_000,
    });
    expect(leg(LedgerAccountType.PLATFORM_REVENUE)).toMatchObject({
      direction: LedgerDirection.CREDIT,
      amount: 1_000,
    });

    // Σ debits = Σ credits, read back off the persisted rows.
    const sum = (direction: LedgerDirection) =>
      txn.entries
        .filter((entry) => entry.direction === direction)
        .reduce((total, entry) => total + entry.amount, 0);
    expect(sum(LedgerDirection.DEBIT)).toBe(sum(LedgerDirection.CREDIT));

    // The payable is owned by the pharmacy from the order's fulfillment, not by any input.
    expect(leg(LedgerAccountType.PROVIDER_PAYABLE)?.account.ownerId).toBe(seed.pharmacyId);
  });

  it('produces the correct derived balances, and the ledger still conserves money', async () => {
    const seed = await seedAuthorizedPayment({ grandTotal: 10_000, platformFee: 1_000 });

    await capture.execute({ paymentId: seed.paymentId });

    const gateway$ = await balanceOf(
      AccountRef.platform(LedgerAccountType.GATEWAY_CLEARING, 'ETB'),
    );
    const payable$ = await balanceOf(AccountRef.providerPayable(seed.pharmacyId, 'ETB'));
    const revenue$ = await balanceOf(
      AccountRef.platform(LedgerAccountType.PLATFORM_REVENUE, 'ETB'),
    );

    // Balances are credits − debits (§5.3).
    expect(gateway$).toBe(-10_000);
    expect(payable$).toBe(9_000);
    expect(revenue$).toBe(1_000);
    expect(gateway$ + payable$ + revenue$).toBe(0);

    // The materialized cache agrees with the derived balance it caches.
    const payableAccount = await ledger.resolveAccount(
      AccountRef.providerPayable(seed.pharmacyId, 'ETB'),
    );
    const cached = await ctx.prisma.accountBalance.findUniqueOrThrow({
      where: { accountId: payableAccount.id },
    });
    expect(cached.balance).toBe(payable$);
  });

  it('credits the whole gross to the provider when the configured platform fee is zero', async () => {
    const seed = await seedAuthorizedPayment({ grandTotal: 7_500, platformFee: 0 });

    const result = await capture.execute({ paymentId: seed.paymentId });

    expect(result.fee).toBe(0);
    expect(result.providerNet).toBe(7_500);
    const txn = await ctx.prisma.ledgerTransaction.findUniqueOrThrow({
      where: { reference: `CAPTURE-${seed.paymentId}` },
      include: { entries: true },
    });
    // A zero leg is omitted rather than posted — the ledger rejects zero entries.
    expect(txn.entries).toHaveLength(2);
    expect(await balanceOf(AccountRef.providerPayable(seed.pharmacyId, 'ETB'))).toBe(7_500);
  });

  it('writes the capture audit entry and the payment.captured event in the same commit', async () => {
    const seed = await seedAuthorizedPayment({ grandTotal: 10_000, platformFee: 1_000 });

    await capture.execute({ paymentId: seed.paymentId, actorUserId: 'pharmacist-1' });

    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { resourceId: seed.paymentId, action: 'PAYMENT_CAPTURED' },
    });
    expect(audit.actorUserId).toBe('pharmacist-1');
    expect(audit.context).toMatchObject({
      orderId: seed.orderId,
      paymentId: seed.paymentId,
      amount: 10_000,
      currency: 'ETB',
      method: 'TELEBIRR',
      provider: 'fake-gateway',
      outcome: 'CAPTURED',
      fee: 1_000,
      providerNet: 9_000,
      ledgerReference: `CAPTURE-${seed.paymentId}`,
    });

    const event = await ctx.prisma.outbox.findFirstOrThrow({
      where: { aggregateId: seed.paymentId, eventType: 'payment.captured' },
    });
    expect((event.payload as { payload: Record<string, unknown> }).payload).toEqual({
      paymentId: seed.paymentId,
      orderId: seed.orderId,
      fee: 1_000,
    });
  });

  it('a repeated capture is idempotent: one provider call, one posting, one event', async () => {
    const seed = await seedAuthorizedPayment();

    const first = await capture.execute({ paymentId: seed.paymentId });
    const second = await capture.execute({ paymentId: seed.paymentId });

    expect(first.replay).toBe(false);
    expect(second.replay).toBe(true);
    expect(second.status).toBe(PaymentStatus.CAPTURED);
    expect(gateway.captureRequests).toHaveLength(1);
    expect(await ctx.prisma.ledgerTransaction.count()).toBe(1);
    expect(await ctx.prisma.ledgerEntry.count()).toBe(3);
    expect(
      await ctx.prisma.outbox.count({
        where: { aggregateId: seed.paymentId, eventType: 'payment.captured' },
      }),
    ).toBe(1);
    // And the provider payable was credited once, not twice.
    expect(await balanceOf(AccountRef.providerPayable(seed.pharmacyId, 'ETB'))).toBe(9_000);
  });

  it('concurrent captures commit exactly one capture posting', async () => {
    const seed = await seedAuthorizedPayment();
    gateway.captureDelayMs = 40;

    const results = await Promise.allSettled([
      capture.execute({ paymentId: seed.paymentId }),
      capture.execute({ paymentId: seed.paymentId }),
      capture.execute({ paymentId: seed.paymentId }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThan(0);

    // The unique `ledger_transactions.reference` is the database-level backstop.
    expect(await ctx.prisma.ledgerTransaction.count()).toBe(1);
    expect(await ctx.prisma.ledgerEntry.count()).toBe(3);
    expect(await balanceOf(AccountRef.providerPayable(seed.pharmacyId, 'ETB'))).toBe(9_000);
    const row = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: seed.paymentId } });
    expect(row.status).toBe('CAPTURED');
  });

  it('a declined capture leaves the payment AUTHORIZED and writes no ledger rows', async () => {
    const seed = await seedAuthorizedPayment();
    gateway.nextCapture = {
      outcome: 'FAILED',
      providerRef: 'gw-declined',
      failureReason: 'Capture window expired',
      failureCode: 'expired',
    };

    await expect(capture.execute({ paymentId: seed.paymentId })).rejects.toMatchObject({
      code: ErrorCode.PAYMENT_CAPTURE_FAILED,
      httpStatus: 402,
    });

    const row = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: seed.paymentId } });
    expect(row.status).toBe('AUTHORIZED');
    expect(row.capturedAt).toBeNull();
    expect(await ctx.prisma.ledgerTransaction.count()).toBe(0);
    expect(await ctx.prisma.ledgerEntry.count()).toBe(0);
    expect(
      await ctx.prisma.auditLog.count({
        where: { resourceId: seed.paymentId, action: 'PAYMENT_CAPTURE_FAILED' },
      }),
    ).toBe(1);
    // No capture-failure event is invented.
    expect(
      await ctx.prisma.outbox.count({ where: { aggregateId: seed.paymentId } }),
    ).toBe(1); // the authorization event only
  });

  it('an ambiguous capture outcome never becomes a false FAILED and posts nothing', async () => {
    const seed = await seedAuthorizedPayment();
    gateway.nextCapture = { outcome: 'UNKNOWN', providerRef: 'gw-maybe-captured' };

    await expect(capture.execute({ paymentId: seed.paymentId })).rejects.toMatchObject({
      code: ErrorCode.DEPENDENCY_UNAVAILABLE,
    });

    const row = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: seed.paymentId } });
    expect(row.status).toBe('AUTHORIZED');
    // The reference the gateway did return is persisted for reconciliation to match on.
    expect(row.providerRef).toBe('gw-maybe-captured');
    expect(await ctx.prisma.ledgerTransaction.count()).toBe(0);
  });

  it('refuses to capture when the provider payable owner cannot be determined', async () => {
    const seed = await seedAuthorizedPayment({ withFulfillment: false });

    await expect(capture.execute({ paymentId: seed.paymentId })).rejects.toMatchObject({
      code: ErrorCode.BUSINESS_RULE_VIOLATION,
    });
    expect(gateway.captureRequests).toHaveLength(0);
    expect(await ctx.prisma.ledgerTransaction.count()).toBe(0);
  });

  it('refuses to capture a payment that is not AUTHORIZED', async () => {
    const seed = await seedAuthorizedPayment();
    await voidPayment.execute({ paymentId: seed.paymentId });

    await expect(capture.execute({ paymentId: seed.paymentId })).rejects.toMatchObject({
      code: ErrorCode.INVALID_PAYMENT_STATE_TRANSITION,
    });
    expect(await ctx.prisma.ledgerTransaction.count()).toBe(0);
  });

  // -------------------------------------------------------------------------------------------
  // Void
  // -------------------------------------------------------------------------------------------

  it('voids an authorized payment and persists VOIDED, with no ledger posting', async () => {
    const seed = await seedAuthorizedPayment();

    const result = await voidPayment.execute({
      paymentId: seed.paymentId,
      actorUserId: seed.customerUserId,
      reason: 'Customer cancelled',
    });

    expect(result.status).toBe(PaymentStatus.VOIDED);
    expect(result.replay).toBe(false);
    expect(gateway.voidRequests).toHaveLength(1);

    const row = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: seed.paymentId } });
    expect(row.status).toBe('VOIDED');
    expect(row.capturedAt).toBeNull();
    expect(row.providerRef).toBe(`gw-void-${seed.paymentId}`);

    // No money moved, so nothing is in the ledger.
    expect(await ctx.prisma.ledgerTransaction.count()).toBe(0);
    expect(await ctx.prisma.ledgerEntry.count()).toBe(0);
  });

  it('audits the void and emits no event (the design catalogues no PaymentVoided)', async () => {
    const seed = await seedAuthorizedPayment();

    await voidPayment.execute({
      paymentId: seed.paymentId,
      actorUserId: seed.customerUserId,
      reason: 'Out of stock',
    });

    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { resourceId: seed.paymentId, action: 'PAYMENT_VOIDED' },
    });
    expect(audit.actorUserId).toBe(seed.customerUserId);
    expect(audit.context).toMatchObject({
      orderId: seed.orderId,
      paymentId: seed.paymentId,
      provider: 'fake-gateway',
      outcome: 'VOIDED',
      reason: 'Out of stock',
    });

    const events = await ctx.prisma.outbox.findMany({ where: { aggregateId: seed.paymentId } });
    expect(events.map((e) => e.eventType)).toEqual(['payment.authorized']);
  });

  it('a repeated void releases the authorization at most once', async () => {
    const seed = await seedAuthorizedPayment();

    const first = await voidPayment.execute({ paymentId: seed.paymentId });
    const second = await voidPayment.execute({ paymentId: seed.paymentId });

    expect(first.replay).toBe(false);
    expect(second.replay).toBe(true);
    expect(second.status).toBe(PaymentStatus.VOIDED);
    expect(gateway.voidRequests).toHaveLength(1);
    expect(
      await ctx.prisma.auditLog.count({
        where: { resourceId: seed.paymentId, action: 'PAYMENT_VOIDED' },
      }),
    ).toBe(1);
  });

  it('normalizes an ALREADY_VOIDED gateway answer as success', async () => {
    const seed = await seedAuthorizedPayment();
    gateway.nextVoid = { outcome: 'ALREADY_VOIDED', providerRef: 'gw-already-void' };

    const result = await voidPayment.execute({ paymentId: seed.paymentId });

    expect(result.status).toBe(PaymentStatus.VOIDED);
    await expect(
      ctx.prisma.payment.findUniqueOrThrow({ where: { id: seed.paymentId } }),
    ).resolves.toMatchObject({ status: 'VOIDED' });
  });

  it('refuses to void a captured payment — that is a refund, not a void', async () => {
    const seed = await seedAuthorizedPayment();
    await capture.execute({ paymentId: seed.paymentId });

    await expect(voidPayment.execute({ paymentId: seed.paymentId })).rejects.toMatchObject({
      code: ErrorCode.PAYMENT_ALREADY_CAPTURED,
      httpStatus: 409,
    });

    const row = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: seed.paymentId } });
    expect(row.status).toBe('CAPTURED');
    expect(gateway.voidRequests).toHaveLength(0);
    // The capture posting is untouched.
    expect(await ctx.prisma.ledgerTransaction.count()).toBe(1);
  });

  it('an ambiguous void outcome leaves the payment AUTHORIZED', async () => {
    const seed = await seedAuthorizedPayment();
    gateway.nextVoid = { outcome: 'UNKNOWN', providerRef: null };

    await expect(voidPayment.execute({ paymentId: seed.paymentId })).rejects.toMatchObject({
      code: ErrorCode.DEPENDENCY_UNAVAILABLE,
    });
    await expect(
      ctx.prisma.payment.findUniqueOrThrow({ where: { id: seed.paymentId } }),
    ).resolves.toMatchObject({ status: 'AUTHORIZED' });
  });

  // -------------------------------------------------------------------------------------------
  // PCI
  // -------------------------------------------------------------------------------------------

  it('no card data reaches the payment row, the ledger, the audit trail or the outbox', async () => {
    const seed = await seedAuthorizedPayment();
    await capture.execute({ paymentId: seed.paymentId });

    const [payment, audits, events, entries] = await Promise.all([
      ctx.prisma.payment.findUniqueOrThrow({ where: { id: seed.paymentId } }),
      ctx.prisma.auditLog.findMany({ where: { resourceId: seed.paymentId } }),
      ctx.prisma.outbox.findMany({ where: { aggregateId: seed.paymentId } }),
      ctx.prisma.ledgerEntry.findMany(),
    ]);

    // No card-shaped column exists anywhere in what capture and void persist.
    const serialized = JSON.stringify({ payment, audits, events, entries }).toLowerCase();
    for (const forbidden of ['"pan"', 'cvv', 'cardnumber', 'cardholder', 'expiry']) {
      expect(serialized).not.toContain(forbidden);
    }

    // And no PAN-shaped value in the fields that actually carry provider-supplied text. The
    // audit hash chain is excluded deliberately: it is random hex, so it can contain long digit
    // runs by chance, which would make a blanket scan meaningless rather than protective.
    const providerText = JSON.stringify([
      payment.provider,
      payment.providerRef,
      payment.providerToken,
      payment.failureReason,
      audits.map((entry) => entry.context),
      events.map((event) => event.payload),
    ]);
    expect(providerText).not.toMatch(/\b(?:\d[ -]?){11,18}\d\b/);
  });
});
