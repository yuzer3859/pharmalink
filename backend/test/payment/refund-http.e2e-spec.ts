import { randomUUID } from 'crypto';
import request from 'supertest';
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
import { MockPaymentProvider } from '../../src/modules/payment/infrastructure/providers/mock-payment-provider.adapter';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { auth, body, createUserWithRole, RegisteredUser, Tokens } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

/**
 * §9.3's refund HTTP surface end to end: real `AppModule`, real global `JwtAuthGuard` +
 * `PermissionsGuard`, real `ValidationPipe`, real `AllExceptionsFilter` envelope, real
 * `RefundPaymentCommand`/`ListPaymentRefundsQuery`, real `Serializable` transactions, the real
 * immutable ledger and real PostgreSQL.
 *
 * The gateway is `MockPaymentProvider` — the shipped stand-in, unmodified, performing no network
 * I/O. `ScriptedGateway` wraps it rather than replacing it, so every ordinary refund here goes
 * through exactly the adapter that ships; only the tests that need an outcome the mock will never
 * produce on its own (an ambiguous one) script it, which is the practice `MockPaymentProvider`'s
 * own doc comment prescribes. Telebirr is never reached: it is unavailable by construction and
 * refuses every operation.
 *
 * The accounting invariants themselves — ADR-016's telescoping fee clawback, the over-refund race,
 * the ledger's balance and immutability — are already proved against real PostgreSQL by
 * `refund.e2e-spec.ts`. What is proved *here* is that the HTTP layer reaches them faithfully and
 * exposes nothing it should not.
 */
class ScriptedGateway implements IPaymentProviderPort {
  private readonly shipped = new MockPaymentProvider();
  /** The shipped key, so payments record `mock` and routing is identical to production. */
  readonly key = 'mock';
  readonly refundRequests: ProviderRefundRequest[] = [];
  /** `null` = behave exactly like `MockPaymentProvider`. */
  nextRefund: ProviderRefundResult | Error | null = null;

  supports(method: PaymentMethod): boolean {
    return this.shipped.supports(method);
  }

  authorize(req: ProviderAuthorizationRequest): Promise<ProviderAuthorizationResult> {
    return this.shipped.authorize(req);
  }

  capture(req: ProviderPaymentOperationRequest): Promise<ProviderCaptureResult> {
    return this.shipped.capture(req);
  }

  voidAuthorization(req: ProviderPaymentOperationRequest): Promise<ProviderVoidResult> {
    return this.shipped.voidAuthorization(req);
  }

  async refund(req: ProviderRefundRequest): Promise<ProviderRefundResult> {
    this.refundRequests.push(req);
    if (this.nextRefund instanceof Error) {
      throw this.nextRefund;
    }
    return this.nextRefund ?? this.shipped.refund(req);
  }
}

describe('Refund HTTP API (e2e)', () => {
  let ctx: TestContext;
  let gateway: ScriptedGateway;
  let finance: RegisteredUser & Tokens;

  beforeAll(async () => {
    gateway = new ScriptedGateway();
    ctx = await createTestApp([{ provide: PAYMENT_PROVIDER_PORT, useValue: gateway }]);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
    gateway.refundRequests.length = 0;
    gateway.nextRefund = null;
    finance = await createUserWithRole(ctx, 'FINANCE_OFFICER');
  });

  // -------------------------------------------------------------------------------------------
  // Fixtures — everything reaches the refund routes through the real HTTP surface.
  // -------------------------------------------------------------------------------------------

  /**
   * A customer whose order has been authorized and captured through §9.1's own routes, so the
   * refund reverses a capture posting `CaptureAccountingService` genuinely wrote. Module 06's
   * Slice-1 checkout is COD and commits straight to `PAID`, and this task does not touch it, so
   * the order rows themselves are seeded directly.
   */
  async function capturedPayment(
    options: { grandTotal?: number; platformFee?: number; capture?: boolean } = {},
  ) {
    const grandTotal = options.grandTotal ?? 10_000;
    const platformFee = options.platformFee ?? 1_000;
    const customer = await createUserWithRole(ctx, 'CUSTOMER');
    const pharmacyId = `pharmacy-${randomUUID()}`;

    const order = await ctx.prisma.order.create({
      data: {
        orderNumber: `ORD-${randomUUID()}`,
        customerUserId: customer.userId,
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

    return { customer, paymentId, orderId: order.id, pharmacyId, grandTotal, platformFee };
  }

  const FULL_BODY = { reason: 'customer cancellation', destination: 'ORIGINAL' };

  function postRefund(
    token: string,
    paymentId: string,
    payload: Record<string, unknown> = FULL_BODY,
    idempotencyKey: string | null = `refund-${randomUUID()}`,
  ) {
    const req = request(ctx.server)
      .post(`/payments/${paymentId}/refunds`)
      .set(...auth(token));
    if (idempotencyKey !== null) {
      req.set('Idempotency-Key', idempotencyKey);
    }
    return req.send(payload);
  }

  function getRefunds(token: string, paymentId: string) {
    return request(ctx.server)
      .get(`/payments/${paymentId}/refunds`)
      .set(...auth(token));
  }

  // ===========================================================================================
  // POST /payments/:id/refunds
  // ===========================================================================================

  it('refunds a captured payment in full and persists it', async () => {
    const { paymentId, grandTotal } = await capturedPayment();

    const data = body(
      await postRefund(finance.accessToken, paymentId, { ...FULL_BODY, amount: grandTotal }).expect(
        201,
      ),
    );

    expect(data).toMatchObject({
      paymentId,
      amount: grandTotal,
      currency: 'ETB',
      type: 'FULL',
      destination: 'ORIGINAL',
      status: 'COMPLETED',
      paymentStatus: 'REFUNDED',
      remainingRefundable: 0,
      replay: false,
    });

    const row = await ctx.prisma.refund.findUniqueOrThrow({
      where: { id: data.refundId as string },
    });
    expect(row).toMatchObject({ paymentId, amount: grandTotal, status: 'COMPLETED' });
    // The approver is the authenticated caller, never anything the body could carry.
    expect(row.approvedBy).toBe(finance.userId);
    await expect(
      ctx.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } }),
    ).resolves.toMatchObject({ status: 'REFUNDED' });
  });

  it('refunds a partial amount and leaves the payment PARTIALLY_REFUNDED', async () => {
    const { paymentId } = await capturedPayment();

    const data = body(
      await postRefund(finance.accessToken, paymentId, {
        amount: 250,
        reason: 'partial dispute',
        destination: 'WALLET',
      }).expect(201),
    );

    expect(data).toMatchObject({
      amount: 250,
      type: 'PARTIAL',
      destination: 'WALLET',
      status: 'COMPLETED',
      paymentStatus: 'PARTIALLY_REFUNDED',
      remainingRefundable: 9_750,
    });
    await expect(
      ctx.prisma.refund.findUniqueOrThrow({ where: { id: data.refundId as string } }),
    ).resolves.toMatchObject({ amount: 250, type: 'PARTIAL', destination: 'WALLET' });
  });

  it('treats an omitted amount as the full remaining refundable amount (§9.3)', async () => {
    const { paymentId, grandTotal } = await capturedPayment();
    // Take a bite out of it first, so "full" and "remaining" are different numbers.
    await postRefund(finance.accessToken, paymentId, {
      amount: 4_000,
      reason: 'first',
      destination: 'ORIGINAL',
    }).expect(201);

    const data = body(await postRefund(finance.accessToken, paymentId, FULL_BODY).expect(201));

    expect(data).toMatchObject({
      amount: grandTotal - 4_000,
      type: 'FULL',
      paymentStatus: 'REFUNDED',
      remainingRefundable: 0,
    });
  });

  it('sends an ORIGINAL refund to the gateway that took the money', async () => {
    const { paymentId } = await capturedPayment();

    const data = body(
      await postRefund(finance.accessToken, paymentId, {
        amount: 1_000,
        reason: 'original destination',
        destination: 'ORIGINAL',
      }).expect(201),
    );

    expect(gateway.refundRequests).toHaveLength(1);
    // Keyed on the refund, not the payment: several partial refunds must stay distinguishable.
    expect(gateway.refundRequests[0]).toMatchObject({ refundId: data.refundId, paymentId });
    expect(data.providerRef).toBe(`mock-refund-${data.refundId as string}`);
  });

  it('credits a WALLET refund through the ledger with no gateway call at all', async () => {
    const { paymentId } = await capturedPayment();

    const data = body(
      await postRefund(finance.accessToken, paymentId, {
        amount: 1_000,
        reason: 'to wallet',
        destination: 'WALLET',
      }).expect(201),
    );

    expect(gateway.refundRequests).toHaveLength(0);
    expect(data.providerRef).toBeNull();
    const posting = await ctx.prisma.ledgerTransaction.findUniqueOrThrow({
      where: { reference: `REFUND-${data.refundId as string}` },
      include: { entries: { include: { account: true } } },
    });
    expect(posting.entries.map((entry) => entry.account.type)).toContain('CUSTOMER_WALLET');
  });

  // -------------------------------------------------------------------------------------------
  // Idempotency-Key (§9 — every mutating money operation carries one)
  // -------------------------------------------------------------------------------------------

  it('rejects a refund with no Idempotency-Key, before anything is reserved', async () => {
    const { paymentId } = await capturedPayment();

    const response = await postRefund(finance.accessToken, paymentId, FULL_BODY, null).expect(400);

    expect(response.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(response.body.error.details).toMatchObject({ field: 'Idempotency-Key' });
    expect(await ctx.prisma.refund.count()).toBe(0);
  });

  it.each([
    ['too short', 'short'],
    ['whitespace-bearing', 'refund key with spaces'],
    ['blank', '   '],
  ])('rejects a %s Idempotency-Key before anything is reserved', async (_label, key) => {
    const { paymentId } = await capturedPayment();

    const response = await postRefund(finance.accessToken, paymentId, FULL_BODY, key).expect(400);

    expect(response.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(await ctx.prisma.refund.count()).toBe(0);
  });

  it('replays an identical refund under the same Idempotency-Key', async () => {
    const { paymentId } = await capturedPayment();
    const key = `refund-${randomUUID()}`;
    const payload = { amount: 2_000, reason: 'replay me', destination: 'ORIGINAL' };

    const first = body(await postRefund(finance.accessToken, paymentId, payload, key).expect(201));
    const second = body(await postRefund(finance.accessToken, paymentId, payload, key).expect(201));

    expect(second.refundId).toBe(first.refundId);
    expect(second.replay).toBe(true);
    // Exactly one refund, one ledger posting and one gateway call survive the replay.
    expect(await ctx.prisma.refund.count()).toBe(1);
    expect(await ctx.prisma.ledgerTransaction.count({ where: { type: 'REFUND' } })).toBe(1);
    expect(gateway.refundRequests).toHaveLength(1);
  });

  it('rejects an Idempotency-Key reused for a materially different refund', async () => {
    const { paymentId } = await capturedPayment();
    const key = `refund-${randomUUID()}`;
    await postRefund(
      finance.accessToken,
      paymentId,
      { amount: 2_000, reason: 'first', destination: 'ORIGINAL' },
      key,
    ).expect(201);

    const response = await postRefund(
      finance.accessToken,
      paymentId,
      { amount: 3_000, reason: 'different', destination: 'ORIGINAL' },
      key,
    ).expect(409);

    expect(response.body.error.code).toBe(ErrorCode.IDEMPOTENCY_CONFLICT);
    expect(await ctx.prisma.refund.count()).toBe(1);
  });

  // -------------------------------------------------------------------------------------------
  // Body validation
  // -------------------------------------------------------------------------------------------

  it.each([
    ['a zero amount', { amount: 0 }],
    ['a negative amount', { amount: -100 }],
    ['a fractional amount', { amount: 250.5 }],
    ['a non-numeric amount', { amount: 'lots' }],
    ['an unknown destination', { destination: 'BANK_ACCOUNT' }],
    ['a lower-case destination', { destination: 'wallet' }],
    ['a missing destination', { destination: undefined }],
    ['a missing reason', { reason: undefined }],
    ['an empty reason', { reason: '' }],
    ['a non-string reason', { reason: { text: 'because' } }],
    ['an over-long reason', { reason: 'x'.repeat(501) }],
  ])('rejects %s with a validation envelope and writes nothing', async (_label, overrides) => {
    const { paymentId } = await capturedPayment();

    const response = await postRefund(finance.accessToken, paymentId, {
      ...FULL_BODY,
      ...overrides,
    }).expect(400);

    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(await ctx.prisma.refund.count()).toBe(0);
  });

  it.each([
    'customerUserId',
    'paymentId',
    'refundId',
    'status',
    'approvedBy',
    'providerRef',
    'idempotencyKey',
    'initiator',
    'currency',
  ])('refuses a client-supplied %s field outright', async (field) => {
    const { paymentId } = await capturedPayment();

    await postRefund(finance.accessToken, paymentId, {
      ...FULL_BODY,
      [field]: 'attacker-value',
    }).expect(400);
    expect(await ctx.prisma.refund.count()).toBe(0);
  });

  // -------------------------------------------------------------------------------------------
  // Eligibility and the over-refund invariant (BRULE-24) as seen over HTTP
  // -------------------------------------------------------------------------------------------

  it('refuses a refund that exceeds what is still refundable', async () => {
    const { paymentId, grandTotal } = await capturedPayment();
    await postRefund(finance.accessToken, paymentId, {
      amount: 8_000,
      reason: 'first',
      destination: 'ORIGINAL',
    }).expect(201);

    const response = await postRefund(finance.accessToken, paymentId, {
      amount: grandTotal - 8_000 + 1,
      reason: 'one santim too many',
      destination: 'ORIGINAL',
    }).expect(422);

    expect(response.body.error.code).toBe(ErrorCode.REFUND_EXCEEDS_CAPTURED);
    expect(await ctx.prisma.refund.count()).toBe(1);
  });

  it('refuses to refund a payment whose funds were never captured', async () => {
    const { paymentId } = await capturedPayment({ capture: false });

    const response = await postRefund(finance.accessToken, paymentId, FULL_BODY).expect(422);

    expect(response.body.error.code).toBe(ErrorCode.REFUND_NOT_ELIGIBLE);
    expect(await ctx.prisma.refund.count()).toBe(0);
    expect(gateway.refundRequests).toHaveLength(0);
  });

  it('answers 404 for a payment that does not exist', async () => {
    const response = await postRefund(finance.accessToken, randomUUID(), FULL_BODY).expect(404);

    expect(response.body.error.code).toBe(ErrorCode.NOT_FOUND);
  });

  // -------------------------------------------------------------------------------------------
  // Authorization (§9.3 — `finance:refund:any`)
  // -------------------------------------------------------------------------------------------

  it('refuses a refund initiated by the paying customer — there is no self-service refund', async () => {
    const { customer, paymentId } = await capturedPayment();

    await postRefund(customer.accessToken, paymentId, FULL_BODY).expect(403);

    expect(await ctx.prisma.refund.count()).toBe(0);
    expect(gateway.refundRequests).toHaveLength(0);
  });

  it("refuses a refund of another customer's payment just as flatly", async () => {
    const { paymentId } = await capturedPayment();
    const intruder = await createUserWithRole(ctx, 'CUSTOMER');

    // The permission gate fires before anything is read, so a stranger cannot even learn that the
    // payment exists — the refusal is identical for a payment id that does not exist at all.
    const found = await postRefund(intruder.accessToken, paymentId, FULL_BODY).expect(403);
    const missing = await postRefund(intruder.accessToken, randomUUID(), FULL_BODY).expect(403);

    expect(found.body.error.code).toBe(missing.body.error.code);
    expect(found.body.error.message).toBe(missing.body.error.message);
    expect(await ctx.prisma.refund.count()).toBe(0);
  });

  it('refuses a refund from an admin who may capture and void but not refund', async () => {
    const { paymentId } = await capturedPayment();
    const admin = await createUserWithRole(ctx, 'ADMIN');

    const response = await postRefund(admin.accessToken, paymentId, FULL_BODY).expect(403);

    // The guard refuses first, so this is the shared `FORBIDDEN` the `PermissionsGuard` raises
    // rather than the command's own `RBAC_FORBIDDEN` — the command's code is what an in-process
    // caller (a future saga, an admin tool) sees, and both are 403 carrying no payment detail.
    expect(response.body.error.code).toBe(ErrorCode.FORBIDDEN);
    expect(await ctx.prisma.refund.count()).toBe(0);
  });

  it('requires authentication', async () => {
    const { paymentId } = await capturedPayment();

    await request(ctx.server)
      .post(`/payments/${paymentId}/refunds`)
      .set('Idempotency-Key', `refund-${randomUUID()}`)
      .send(FULL_BODY)
      .expect(401);
    expect(await ctx.prisma.refund.count()).toBe(0);
  });

  // -------------------------------------------------------------------------------------------
  // Provider outcomes
  // -------------------------------------------------------------------------------------------

  it('reports an unavailable gateway as a dependency failure, not a success', async () => {
    const { paymentId } = await capturedPayment();
    // Telebirr is registered but fail-closed: no authoritative provider contract exists.
    await ctx.prisma.payment.update({ where: { id: paymentId }, data: { provider: 'telebirr' } });

    const response = await postRefund(finance.accessToken, paymentId, FULL_BODY).expect(503);

    expect(response.body.error.code).toBe(ErrorCode.DEPENDENCY_UNAVAILABLE);
    // The reservation is committed before the gateway is reached, so the refund exists — and it
    // stays PENDING with no ledger posting, which is what makes a retry resumable.
    const refunds = await ctx.prisma.refund.findMany();
    expect(refunds).toHaveLength(1);
    expect(refunds[0].status).toBe('PENDING');
    expect(await ctx.prisma.ledgerTransaction.count({ where: { type: 'REFUND' } })).toBe(0);
  });

  it('leaves an ambiguous provider outcome PENDING rather than reporting success or failure', async () => {
    const { paymentId } = await capturedPayment();
    gateway.nextRefund = { outcome: 'UNKNOWN', providerRef: null };

    const response = await postRefund(finance.accessToken, paymentId, FULL_BODY).expect(503);

    // Not a 200 pretending it completed, and not a 500 either: the state is genuinely unresolved.
    expect(response.body.error.code).toBe(ErrorCode.DEPENDENCY_UNAVAILABLE);
    const refunds = await ctx.prisma.refund.findMany();
    expect(refunds[0]).toMatchObject({ status: 'PENDING', completedAt: null });
    // Never FAILED: a FAILED refund frees its amount, which would allow a second payout.
    expect(refunds[0].status).not.toBe('FAILED');
    expect(await ctx.prisma.ledgerTransaction.count({ where: { type: 'REFUND' } })).toBe(0);
    await expect(
      ctx.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } }),
    ).resolves.toMatchObject({ status: 'CAPTURED' });
  });

  it('sanitizes a thrown gateway error instead of surfacing it', async () => {
    const { paymentId } = await capturedPayment();
    const raw =
      'refund rejected: authorization=Bearer sk_live_supersecret api_key=ak_12345 pan 4111 1111 1111 1111';
    gateway.nextRefund = new Error(raw);

    const response = await postRefund(finance.accessToken, paymentId, FULL_BODY).expect(503);

    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain(raw);
    expect(serialized).not.toContain('sk_live_supersecret');
    expect(serialized).not.toContain('ak_12345');
    expect(serialized).not.toContain('4111');
    expect(response.body.error.code).toBe(ErrorCode.DEPENDENCY_UNAVAILABLE);
    // Nothing durable took the raw text either.
    const audits = await ctx.prisma.auditLog.findMany();
    expect(JSON.stringify(audits)).not.toContain('sk_live_supersecret');
  });

  // -------------------------------------------------------------------------------------------
  // Response shape (§7, §12, §13)
  // -------------------------------------------------------------------------------------------

  it('returns exactly the safe refund fields and no accounting internals', async () => {
    const { paymentId } = await capturedPayment();

    const response = await postRefund(finance.accessToken, paymentId, {
      amount: 3_333,
      reason: 'field check',
      destination: 'ORIGINAL',
    }).expect(201);
    const data = body(response);

    expect(Object.keys(data).sort()).toEqual(
      [
        'refundId',
        'paymentId',
        'amount',
        'currency',
        'type',
        'destination',
        'status',
        'paymentStatus',
        'providerRef',
        'remainingRefundable',
        'createdAt',
        'completedAt',
        'replay',
      ].sort(),
    );
    // ADR-016's allocation and the ledger handle stay inside Module 07 (§12).
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain('ledgerReference');
    expect(serialized).not.toContain('feeClawback');
    expect(serialized).not.toContain('providerClawback');
    expect(serialized).not.toContain('approvedBy');
    expect(serialized).not.toContain('idempotencyKey');
    expect(serialized).not.toContain(`REFUND-${data.refundId as string}`);
    // But the split was posted, and the audit trail did record it.
    await expect(
      ctx.prisma.ledgerTransaction.findUniqueOrThrow({
        where: { reference: `REFUND-${data.refundId as string}` },
      }),
    ).resolves.toBeDefined();
  });

  it('never returns the payment provider token through a refund', async () => {
    const customer = await createUserWithRole(ctx, 'CUSTOMER');
    const order = await ctx.prisma.order.create({
      data: {
        orderNumber: `ORD-${randomUUID()}`,
        customerUserId: customer.userId,
        status: 'PENDING_PAYMENT',
        subtotal: 9_000,
        deliveryFee: 0,
        platformFee: 1_000,
        discountTotal: 0,
        grandTotal: 10_000,
        currency: 'ETB',
        idempotencyKey: `checkout-${randomUUID()}`,
        isCod: false,
      },
    });
    await ctx.prisma.fulfillment.create({
      data: { orderId: order.id, pharmacyId: `pharmacy-${randomUUID()}`, branchId: 'branch-1' },
    });
    const paymentId = body(
      await request(ctx.server)
        .post('/payments/authorize')
        .set(...auth(customer.accessToken))
        .set('Idempotency-Key', `pay-${randomUUID()}`)
        .send({ orderId: order.id, method: 'TELEBIRR', token: 'tok_opaque_secret' })
        .expect(201),
    ).paymentId as string;
    await request(ctx.server)
      .post(`/payments/${paymentId}/capture`)
      .set(...auth(finance.accessToken))
      .set('Idempotency-Key', `cap-${randomUUID()}`)
      .send({})
      .expect(200);

    const created = await postRefund(finance.accessToken, paymentId, FULL_BODY).expect(201);
    const listed = await getRefunds(customer.accessToken, paymentId).expect(200);

    expect(JSON.stringify(created.body)).not.toContain('tok_opaque_secret');
    expect(JSON.stringify(listed.body)).not.toContain('tok_opaque_secret');
    // It is still where it belongs, so this is an omission and not an accident of seeding.
    await expect(
      ctx.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } }),
    ).resolves.toMatchObject({ providerToken: 'tok_opaque_secret' });
  });

  it('records the audit entries and the outbox event behind the refund', async () => {
    const { paymentId } = await capturedPayment();

    const data = body(await postRefund(finance.accessToken, paymentId, FULL_BODY).expect(201));

    const audits = await ctx.prisma.auditLog.findMany({
      where: { resourceId: data.refundId as string },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits.map((entry) => entry.action)).toEqual([
      'PAYMENT_REFUND_REQUESTED',
      'PAYMENT_REFUNDED',
    ]);
    expect(audits[1].actorUserId).toBe(finance.userId);
    expect(
      await ctx.prisma.outbox.count({
        where: { aggregateId: paymentId, eventType: 'payment.refunded' },
      }),
    ).toBe(1);
  });

  // ===========================================================================================
  // GET /payments/:id/refunds
  // ===========================================================================================

  it('lets the paying customer list their own refunds', async () => {
    const { customer, paymentId, grandTotal } = await capturedPayment();
    await postRefund(finance.accessToken, paymentId, {
      amount: 2_500,
      reason: 'listed',
      destination: 'ORIGINAL',
    }).expect(201);

    const data = body(await getRefunds(customer.accessToken, paymentId).expect(200));

    expect(data).toMatchObject({
      paymentId,
      currency: 'ETB',
      capturedAmount: grandTotal,
      totalRefunded: 2_500,
      remainingRefundable: grandTotal - 2_500,
    });
    expect(data.refunds).toHaveLength(1);
  });

  it('returns every refund with its own status, type and destination', async () => {
    const { customer, paymentId } = await capturedPayment();
    await postRefund(finance.accessToken, paymentId, {
      amount: 2_000,
      reason: 'first',
      destination: 'ORIGINAL',
    }).expect(201);
    await postRefund(finance.accessToken, paymentId, {
      amount: 3_000,
      reason: 'second',
      destination: 'WALLET',
    }).expect(201);
    // A third that the gateway leaves unresolved, so a PENDING row is genuinely in the list.
    gateway.nextRefund = { outcome: 'UNKNOWN', providerRef: null };
    await postRefund(finance.accessToken, paymentId, {
      amount: 1_000,
      reason: 'ambiguous',
      destination: 'ORIGINAL',
    }).expect(503);

    const data = body(await getRefunds(customer.accessToken, paymentId).expect(200));
    const refunds = data.refunds as Array<Record<string, unknown>>;

    expect(refunds).toHaveLength(3);
    expect(
      refunds.map((refund) => [refund.amount, refund.type, refund.destination, refund.status]),
    ).toEqual(
      expect.arrayContaining([
        [2_000, 'PARTIAL', 'ORIGINAL', 'COMPLETED'],
        [3_000, 'PARTIAL', 'WALLET', 'COMPLETED'],
        [1_000, 'PARTIAL', 'ORIGINAL', 'PENDING'],
      ]),
    );
    // The PENDING refund still reserves its amount against a further request (BRULE-24).
    expect(data.totalRefunded).toBe(6_000);
    expect(data.remainingRefundable).toBe(4_000);
  });

  it('returns only the safe refund fields', async () => {
    const { customer, paymentId } = await capturedPayment();
    const created = body(await postRefund(finance.accessToken, paymentId, FULL_BODY).expect(201));

    const response = await getRefunds(customer.accessToken, paymentId).expect(200);
    const data = body(response);
    const refund = (data.refunds as Array<Record<string, unknown>>)[0];

    expect(Object.keys(data).sort()).toEqual(
      ['paymentId', 'currency', 'capturedAmount', 'totalRefunded', 'remainingRefundable', 'refunds'].sort(),
    );
    expect(Object.keys(refund).sort()).toEqual(
      [
        'refundId',
        'paymentId',
        'amount',
        'currency',
        'type',
        'destination',
        'status',
        'providerRef',
        'reason',
        'createdAt',
        'completedAt',
      ].sort(),
    );
    expect(refund.refundId).toBe(created.refundId);
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain('approvedBy');
    expect(serialized).not.toContain('idempotencyKey');
    expect(serialized).not.toContain('ledgerReference');
    expect(serialized).not.toContain(finance.userId);
  });

  it('answers 404 for a payment that does not exist', async () => {
    const customer = await createUserWithRole(ctx, 'CUSTOMER');

    const response = await getRefunds(customer.accessToken, randomUUID()).expect(404);

    expect(response.body.error.code).toBe(ErrorCode.NOT_FOUND);
  });

  it("does not leak another customer's refunds, or that their payment exists", async () => {
    const { paymentId } = await capturedPayment();
    await postRefund(finance.accessToken, paymentId, FULL_BODY).expect(201);
    const intruder = await createUserWithRole(ctx, 'CUSTOMER');

    const found = await getRefunds(intruder.accessToken, paymentId).expect(404);
    const missing = await getRefunds(intruder.accessToken, randomUUID()).expect(404);

    // Byte-identical: existence is not observable.
    expect(found.body.error.code).toBe(missing.body.error.code);
    expect(found.body.error.message).toBe(missing.body.error.message);
    expect(JSON.stringify(found.body)).not.toContain('refundId');
  });

  it('requires authentication', async () => {
    const { paymentId } = await capturedPayment();

    await request(ctx.server).get(`/payments/${paymentId}/refunds`).expect(401);
  });
});
