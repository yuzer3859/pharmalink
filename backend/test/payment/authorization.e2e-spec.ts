import { randomUUID } from 'crypto';
import {
  AuthorizePaymentCommand,
  AuthorizePaymentInput,
} from '../../src/modules/payment/application/commands/authorize-payment.command';
import {
  IPaymentAuthorizationPort,
  PAYMENT_AUTHORIZATION_PORT,
} from '../../src/modules/payment/application/ports/inbound/payment-authorization.port';
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
import { PaymentMethod, PaymentStatus } from '../../src/modules/payment/domain/enums';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

/**
 * A gateway double that behaves like a provider at the infrastructure boundary: it implements
 * `IPaymentProviderPort`, is bound through the real DI container in place of
 * `MockPaymentProvider`, and is the ONLY thing replaced. Everything else in these tests is real —
 * real `AppModule` wiring, real `AuthorizePaymentCommand`, real Prisma repositories, real
 * `Serializable` transactions, real audit/outbox tables, real PostgreSQL.
 *
 * No external network call is made, and none could be: the double is in-process.
 */
class FakeGateway implements IPaymentProviderPort {
  readonly key = 'fake-gateway';
  readonly requests: ProviderAuthorizationRequest[] = [];
  /** Next outcome to serve. Defaults to a synchronous authorization. */
  next: ProviderAuthorizationResult | Error = { outcome: 'AUTHORIZED', providerRef: null };
  /** Set to delay the response, so a genuine concurrency window can be opened. */
  delayMs = 0;

  supports(method: PaymentMethod): boolean {
    return method !== PaymentMethod.COD && method !== PaymentMethod.WALLET;
  }

  async authorize(request: ProviderAuthorizationRequest): Promise<ProviderAuthorizationResult> {
    this.requests.push(request);
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    if (this.next instanceof Error) {
      throw this.next;
    }
    // Mirror a real gateway: the reference is derived from the payment id we committed first, so
    // re-authorizing the same payment yields the same reference rather than a second hold.
    return { ...this.next, providerRef: this.next.providerRef ?? `gw-${request.paymentId}` };
  }

  // Not exercised by the authorization suite; capture/void and refunds have their own e2e specs.
  async capture(request: ProviderPaymentOperationRequest): Promise<ProviderCaptureResult> {
    return { outcome: 'CAPTURED', providerRef: `gw-capture-${request.paymentId}` };
  }

  async voidAuthorization(request: ProviderPaymentOperationRequest): Promise<ProviderVoidResult> {
    return { outcome: 'VOIDED', providerRef: `gw-void-${request.paymentId}` };
  }

  async refund(request: ProviderRefundRequest): Promise<ProviderRefundResult> {
    return { outcome: 'REFUNDED', providerRef: `gw-refund-${request.refundId}` };
  }
}

describe('Payment authorization (e2e)', () => {
  let ctx: TestContext;
  let gateway: FakeGateway;
  let authorize: AuthorizePaymentCommand;
  let authorizationPort: IPaymentAuthorizationPort;

  beforeAll(async () => {
    gateway = new FakeGateway();
    ctx = await createTestApp([{ provide: PAYMENT_PROVIDER_PORT, useValue: gateway }]);
    authorize = ctx.app.get(AuthorizePaymentCommand);
    authorizationPort = ctx.app.get<IPaymentAuthorizationPort>(PAYMENT_AUTHORIZATION_PORT);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
    gateway.requests.length = 0;
    gateway.next = { outcome: 'AUTHORIZED', providerRef: null };
    gateway.delayMs = 0;
  });

  /**
   * Writes a Module 06 order directly, in `PENDING_PAYMENT` — the state BRULE-17 authorizes
   * from. Module 06's own Slice-1 checkout is COD and commits straight through to `PAID`, so it
   * cannot produce this state; this task does not modify that flow (the checkout integration is
   * a separate task), so the row is seeded here instead.
   */
  async function seedOrder(
    overrides: { customerUserId?: string; grandTotal?: number; status?: string } = {},
  ): Promise<{ orderId: string; customerUserId: string; grandTotal: number }> {
    const customerUserId = overrides.customerUserId ?? `customer-${randomUUID()}`;
    const grandTotal = overrides.grandTotal ?? 11_500;
    const order = await ctx.prisma.order.create({
      data: {
        orderNumber: `ORD-${randomUUID()}`,
        customerUserId,
        status: (overrides.status ?? 'PENDING_PAYMENT') as never,
        subtotal: grandTotal - 500,
        deliveryFee: 500,
        platformFee: 0,
        discountTotal: 0,
        grandTotal,
        currency: 'ETB',
        idempotencyKey: `checkout-${randomUUID()}`,
        isCod: false,
      },
    });
    return { orderId: order.id, customerUserId, grandTotal };
  }

  function input(
    seed: { orderId: string; customerUserId: string },
    overrides: Partial<AuthorizePaymentInput> = {},
  ): AuthorizePaymentInput {
    return {
      customerUserId: seed.customerUserId,
      orderId: seed.orderId,
      method: PaymentMethod.TELEBIRR,
      idempotencyKey: `pay-${randomUUID()}`,
      ...overrides,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Synchronous authorization
  // -------------------------------------------------------------------------------------------

  it('authorizes synchronously: persists an AUTHORIZED payment with the provider reference', async () => {
    const seed = await seedOrder();

    const result = await authorize.execute(input(seed));

    expect(result.status).toBe(PaymentStatus.AUTHORIZED);
    expect(result.providerRedirect).toBeNull();
    expect(result.replay).toBe(false);

    const row = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: result.paymentId } });
    expect(row.status).toBe('AUTHORIZED');
    expect(row.orderId).toBe(seed.orderId);
    expect(row.customerUserId).toBe(seed.customerUserId);
    expect(row.amount).toBe(seed.grandTotal);
    expect(row.currency).toBe('ETB');
    expect(row.method).toBe('TELEBIRR');
    expect(row.provider).toBe('fake-gateway');
    expect(row.providerRef).toBe(`gw-${result.paymentId}`);
    expect(row.authorizedAt).toBeInstanceOf(Date);
    expect(row.capturedAt).toBeNull();
    expect(row.failureReason).toBeNull();
  });

  it('authorizes the order total even when the caller sends a stale amount it agrees with', async () => {
    const seed = await seedOrder({ grandTotal: 42_000 });

    const result = await authorize.execute(input(seed, { amount: 42_000, currency: 'ETB' }));

    expect(result.amount).toBe(42_000);
    expect(gateway.requests[0].amount).toBe(42_000);
  });

  it('writes the audit entry and the payment.authorized outbox row in the same commit', async () => {
    const seed = await seedOrder();

    const result = await authorize.execute(input(seed));

    const audits = await ctx.prisma.auditLog.findMany({
      where: { resourceType: 'Payment', resourceId: result.paymentId },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits.map((a) => a.action)).toEqual(['PAYMENT_INITIATED', 'PAYMENT_AUTHORIZED']);
    expect(audits[0].actorUserId).toBe(seed.customerUserId);
    expect(audits[1].context).toMatchObject({
      orderId: seed.orderId,
      paymentId: result.paymentId,
      amount: seed.grandTotal,
      currency: 'ETB',
      method: 'TELEBIRR',
      outcome: 'AUTHORIZED',
    });
    // The hash chain must still be intact after a payment write.
    expect(audits[1].prevHash).toBe(audits[0].hash);

    const events = await ctx.prisma.outbox.findMany({ where: { aggregateId: result.paymentId } });
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('payment.authorized');
    expect(events[0].aggregateType).toBe('Payment');
    expect((events[0].payload as { payload: Record<string, unknown> }).payload).toEqual({
      paymentId: result.paymentId,
      orderId: seed.orderId,
    });
  });

  it('creates no ledger rows — the first money movement is at capture (§11.3)', async () => {
    const seed = await seedOrder();

    await authorize.execute(input(seed));

    expect(await ctx.prisma.ledgerTransaction.count()).toBe(0);
    expect(await ctx.prisma.ledgerEntry.count()).toBe(0);
    expect(await ctx.prisma.ledgerAccount.count()).toBe(0);
    expect(await ctx.prisma.accountBalance.count()).toBe(0);
  });

  // -------------------------------------------------------------------------------------------
  // Asynchronous / redirect authorization
  // -------------------------------------------------------------------------------------------

  it('initiates asynchronously: payment stays INITIATED and the redirect is returned', async () => {
    const seed = await seedOrder();
    gateway.next = {
      outcome: 'PENDING',
      providerRef: 'gw-pending-77',
      redirectUrl: 'https://gateway.example/hosted/abc',
    };

    const result = await authorize.execute(
      input(seed, { returnUrl: 'https://app.example/return' }),
    );

    expect(result.status).toBe(PaymentStatus.INITIATED);
    expect(result.providerRedirect).toBe('https://gateway.example/hosted/abc');

    const row = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: result.paymentId } });
    expect(row.status).toBe('INITIATED');
    expect(row.authorizedAt).toBeNull();
    // Persisted so the later webhook can be matched back to this payment.
    expect(row.providerRef).toBe('gw-pending-77');

    // Nothing is authorized yet, so no authorization event may exist.
    expect(await ctx.prisma.outbox.count({ where: { aggregateId: result.paymentId } })).toBe(0);
    const audits = await ctx.prisma.auditLog.findMany({
      where: { resourceId: result.paymentId },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits.map((a) => a.action)).toEqual([
      'PAYMENT_INITIATED',
      'PAYMENT_AUTHORIZATION_PENDING',
    ]);
  });

  // -------------------------------------------------------------------------------------------
  // Failure
  // -------------------------------------------------------------------------------------------

  it('records a declined authorization as FAILED, then reports PAYMENT_AUTH_FAILED', async () => {
    const seed = await seedOrder();
    gateway.next = {
      outcome: 'FAILED',
      providerRef: 'gw-declined-5',
      failureReason: 'Insufficient funds',
      failureCode: 'insufficient_funds',
    };

    await expect(authorize.execute(input(seed))).rejects.toMatchObject({
      code: ErrorCode.PAYMENT_AUTH_FAILED,
      httpStatus: 402,
    });

    const row = await ctx.prisma.payment.findFirstOrThrow({ where: { orderId: seed.orderId } });
    expect(row.status).toBe('FAILED');
    expect(row.failureReason).toBe('Insufficient funds');
    expect(row.providerRef).toBe('gw-declined-5');

    const events = await ctx.prisma.outbox.findMany({ where: { aggregateId: row.id } });
    expect(events.map((e) => e.eventType)).toEqual(['payment.failed']);
    expect(
      await ctx.prisma.auditLog.count({
        where: { resourceId: row.id, action: 'PAYMENT_AUTH_FAILED' },
      }),
    ).toBe(1);
    expect(await ctx.prisma.ledgerEntry.count()).toBe(0);
  });

  it('never persists a card number a misbehaving gateway put in its decline reason', async () => {
    const seed = await seedOrder();
    gateway.next = {
      outcome: 'FAILED',
      providerRef: 'gw-1',
      failureReason: 'Declined for card 4111 1111 1111 1111',
    };

    await expect(authorize.execute(input(seed))).rejects.toMatchObject({
      code: ErrorCode.PAYMENT_AUTH_FAILED,
    });

    const row = await ctx.prisma.payment.findFirstOrThrow({ where: { orderId: seed.orderId } });
    expect(row.failureReason).not.toContain('4111');
    expect(row.failureReason).toContain('[redacted]');

    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { resourceId: row.id, action: 'PAYMENT_AUTH_FAILED' },
    });
    expect(JSON.stringify(audit.context)).not.toContain('4111');
    const event = await ctx.prisma.outbox.findFirstOrThrow({ where: { aggregateId: row.id } });
    expect(JSON.stringify(event.payload)).not.toContain('4111');
  });

  it('leaves the payment INITIATED and recoverable when the gateway call itself fails', async () => {
    const seed = await seedOrder();
    gateway.next = new Error('ETIMEDOUT contacting gateway');

    await expect(authorize.execute(input(seed))).rejects.toMatchObject({
      code: ErrorCode.DEPENDENCY_UNAVAILABLE,
    });

    const row = await ctx.prisma.payment.findFirstOrThrow({ where: { orderId: seed.orderId } });
    // Not FAILED: the outcome is unknown, and the committed row + payment id are what the later
    // webhook/reconciliation task needs to resolve it against the gateway.
    expect(row.status).toBe('INITIATED');
    expect(row.failureReason).toBeNull();
    expect(gateway.requests[0].paymentId).toBe(row.id);
  });

  // -------------------------------------------------------------------------------------------
  // Ownership, eligibility, validation
  // -------------------------------------------------------------------------------------------

  it("refuses another customer's order as NOT_FOUND and writes nothing", async () => {
    const seed = await seedOrder();

    await expect(
      authorize.execute(input(seed, { customerUserId: `intruder-${randomUUID()}` })),
    ).rejects.toMatchObject({ code: ErrorCode.ORDER_NOT_FOUND });

    expect(await ctx.prisma.payment.count()).toBe(0);
    expect(gateway.requests).toHaveLength(0);
  });

  it('refuses an order that is not in a payable state', async () => {
    const seed = await seedOrder({ status: 'PAID' });

    await expect(authorize.execute(input(seed))).rejects.toMatchObject({
      code: ErrorCode.BUSINESS_RULE_VIOLATION,
    });
    expect(await ctx.prisma.payment.count()).toBe(0);
  });

  it('refuses a caller amount that disagrees with the order total', async () => {
    const seed = await seedOrder({ grandTotal: 11_500 });

    await expect(authorize.execute(input(seed, { amount: 1 }))).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
    });
    expect(await ctx.prisma.payment.count()).toBe(0);
  });

  it('refuses a method no gateway can authorize, leaving no abandoned payment row', async () => {
    const seed = await seedOrder();

    await expect(
      authorize.execute(input(seed, { method: PaymentMethod.COD })),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });

    expect(await ctx.prisma.payment.count()).toBe(0);
    expect(gateway.requests).toHaveLength(0);
  });

  it('refuses a second payment for an order that already has an active one', async () => {
    const seed = await seedOrder();
    await authorize.execute(input(seed));

    await expect(authorize.execute(input(seed))).rejects.toMatchObject({
      code: ErrorCode.CONFLICT,
    });
    expect(await ctx.prisma.payment.count({ where: { orderId: seed.orderId } })).toBe(1);
  });

  // -------------------------------------------------------------------------------------------
  // Idempotency — against the real unique constraint
  // -------------------------------------------------------------------------------------------

  it('a sequential replay returns the same payment and does not call the gateway again', async () => {
    const seed = await seedOrder();
    const request = input(seed);

    const first = await authorize.execute(request);
    const replay = await authorize.execute(request);

    expect(replay.paymentId).toBe(first.paymentId);
    expect(replay.replay).toBe(true);
    expect(replay.status).toBe(PaymentStatus.AUTHORIZED);
    expect(gateway.requests).toHaveLength(1);
    expect(await ctx.prisma.payment.count()).toBe(1);
    // No duplicate audit/outbox rows either.
    expect(await ctx.prisma.outbox.count({ where: { aggregateId: first.paymentId } })).toBe(1);
  });

  it('rejects reuse of one idempotency key for a different order', async () => {
    const seedA = await seedOrder();
    const seedB = await seedOrder({ customerUserId: seedA.customerUserId });
    const key = `pay-${randomUUID()}`;

    await authorize.execute(input(seedA, { idempotencyKey: key }));

    await expect(
      authorize.execute(input(seedB, { idempotencyKey: key })),
    ).rejects.toMatchObject({ code: ErrorCode.IDEMPOTENCY_CONFLICT });
    expect(await ctx.prisma.payment.count()).toBe(1);
  });

  it('collapses concurrent identical requests to one payment and one gateway call', async () => {
    const seed = await seedOrder();
    const request = input(seed);
    // Widen the window so both requests really are in flight at the same time.
    gateway.delayMs = 40;

    const results = await Promise.allSettled([
      authorize.execute(request),
      authorize.execute(request),
      authorize.execute(request),
    ]);

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof authorize.execute>>> =>
        r.status === 'fulfilled',
    );
    // Every request that succeeded describes the same single payment.
    expect(fulfilled.length).toBeGreaterThan(0);
    const ids = new Set(fulfilled.map((r) => r.value.paymentId));
    expect(ids.size).toBe(1);

    // The database's unique constraint is the final backstop: exactly one row exists...
    expect(await ctx.prisma.payment.count({ where: { orderId: seed.orderId } })).toBe(1);
    // ...and, crucially, the customer was only ever charged once.
    expect(gateway.requests).toHaveLength(1);
  });

  it('the exported inbound port authorizes through the same real wiring', async () => {
    const seed = await seedOrder();

    const result = await authorizationPort.authorize(input(seed));

    expect(result.status).toBe(PaymentStatus.AUTHORIZED);
    await expect(
      ctx.prisma.payment.findUniqueOrThrow({ where: { id: result.paymentId } }),
    ).resolves.toMatchObject({ status: 'AUTHORIZED' });
  });

  // -------------------------------------------------------------------------------------------
  // PCI
  // -------------------------------------------------------------------------------------------

  it('stores only an opaque provider token, and no card data reaches any table', async () => {
    const seed = await seedOrder();

    const result = await authorize.execute(
      input(seed, { method: PaymentMethod.CARD, providerToken: 'tok_opaque_from_gateway' }),
    );

    const row = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: result.paymentId } });
    expect(row.providerToken).toBe('tok_opaque_from_gateway');

    // The token is a payment-row field only — it must not have leaked into the audit trail or
    // the published event, which travel further and live longer.
    const audits = await ctx.prisma.auditLog.findMany({ where: { resourceId: result.paymentId } });
    const events = await ctx.prisma.outbox.findMany({ where: { aggregateId: result.paymentId } });
    expect(JSON.stringify(audits)).not.toContain('tok_opaque_from_gateway');
    expect(JSON.stringify(events)).not.toContain('tok_opaque_from_gateway');
  });
});
