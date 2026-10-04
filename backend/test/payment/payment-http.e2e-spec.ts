import { randomUUID } from 'crypto';
import request from 'supertest';
import { computeHmacSignature } from '../../src/modules/payment/infrastructure/webhooks/hmac-signature';
import {
  MOCK_WEBHOOK_SECRET_KEY,
  MOCK_WEBHOOK_SIGNATURE_HEADER,
} from '../../src/modules/payment/infrastructure/webhooks/mock-webhook.adapter';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { auth, body, createUserWithRole } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

const WEBHOOK_SECRET = 'e2e-http-webhook-secret-0123456789';

/**
 * Module 07's HTTP surface (§9.1, §9.2) end to end: real `AppModule`, real global guards, real
 * `ValidationPipe`, real `AllExceptionsFilter` envelope, real commands, real PostgreSQL. No
 * provider is substituted — `MockPaymentProvider` is the shipped default and performs no network
 * I/O, and the webhook adapter verifies real HMAC signatures against a configured secret, so the
 * security boundary exercised here is the one that ships.
 */
describe('Payment HTTP API (e2e)', () => {
  let ctx: TestContext;
  let previousSecret: string | undefined;

  beforeAll(async () => {
    previousSecret = process.env[MOCK_WEBHOOK_SECRET_KEY];
    process.env[MOCK_WEBHOOK_SECRET_KEY] = WEBHOOK_SECRET;
    ctx = await createTestApp();
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
   * A customer with an order in `PENDING_PAYMENT` and its single fulfillment. Module 06's own
   * Slice-1 checkout is COD and commits straight to `PAID`, and this task does not modify it, so
   * the order rows are seeded directly.
   */
  async function customerWithOrder(options: { grandTotal?: number; platformFee?: number } = {}) {
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

    return { customer, orderId: order.id, grandTotal, pharmacyId };
  }

  /** `body()` is intentionally untyped; this narrows the one field the tests thread around. */
  function idOf(data: Record<string, unknown>): string {
    return data.paymentId as string;
  }

  function authorizeBody(orderId: string) {
    return { orderId, method: 'TELEBIRR' };
  }

  /** Authorizes through the HTTP surface and returns the created payment id. */
  function authorize(
    customerToken: string,
    orderId: string,
    overrides: Record<string, unknown> = {},
    idempotencyKey = `pay-${randomUUID()}`,
  ) {
    return request(ctx.server)
      .post('/payments/authorize')
      .set(...auth(customerToken))
      .set('Idempotency-Key', idempotencyKey)
      .send({ ...authorizeBody(orderId), ...overrides });
  }

  // -------------------------------------------------------------------------------------------
  // POST /payments/authorize
  // -------------------------------------------------------------------------------------------

  it('authorizes a payment and persists it', async () => {
    const { customer, orderId, grandTotal } = await customerWithOrder();

    const response = await authorize(customer.accessToken, orderId).expect(201);
    const data = body(response);

    expect(data).toEqual({
      paymentId: expect.any(String),
      status: 'AUTHORIZED',
      providerRedirect: null,
      amount: grandTotal,
      currency: 'ETB',
      replay: false,
    });

    const row = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: idOf(data) } });
    expect(row.status).toBe('AUTHORIZED');
    expect(row.customerUserId).toBe(customer.userId);
    expect(row.amount).toBe(grandTotal);
    expect(row.provider).toBe('mock');
  });

  it('returns an async redirect without marking the payment authorized', async () => {
    const { customer, orderId } = await customerWithOrder();

    const data = body(
      await authorize(customer.accessToken, orderId, {
        returnUrl: 'https://app.example/return',
      }).expect(201),
    );

    expect(data.status).toBe('INITIATED');
    expect(data.providerRedirect).toEqual(expect.stringContaining('https://app.example/return'));
  });

  it('replays an identical authorize with the same Idempotency-Key', async () => {
    const { customer, orderId } = await customerWithOrder();
    const key = `pay-${randomUUID()}`;

    const first = body(await authorize(customer.accessToken, orderId, {}, key).expect(201));
    const second = body(await authorize(customer.accessToken, orderId, {}, key).expect(201));

    expect(idOf(second)).toBe(idOf(first));
    expect(second.replay).toBe(true);
    expect(await ctx.prisma.payment.count()).toBe(1);
  });

  it('rejects a request with no Idempotency-Key', async () => {
    const { customer, orderId } = await customerWithOrder();

    const response = await request(ctx.server)
      .post('/payments/authorize')
      .set(...auth(customer.accessToken))
      .send(authorizeBody(orderId))
      .expect(400);

    expect(response.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(response.body.error.details).toMatchObject({ field: 'Idempotency-Key' });
    expect(await ctx.prisma.payment.count()).toBe(0);
  });

  it('rejects a malformed Idempotency-Key before any payment is created', async () => {
    const { customer, orderId } = await customerWithOrder();

    await authorize(customer.accessToken, orderId, {}, 'short').expect(400);
    expect(await ctx.prisma.payment.count()).toBe(0);
  });

  it.each([
    ['a missing orderId', { orderId: undefined }],
    ['an unknown method', { method: 'BITCOIN' }],
    ['a zero amount', { amount: 0 }],
    ['a lower-case currency', { currency: 'etb' }],
    ['a non-http returnUrl', { returnUrl: 'javascript:alert(1)' }],
  ])('rejects %s with a validation envelope', async (_name, overrides) => {
    const { customer, orderId } = await customerWithOrder();

    const response = await authorize(customer.accessToken, orderId, overrides).expect(400);
    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it.each(['customerUserId', 'paymentId', 'provider', 'providerRef', 'status'])(
    'refuses a client-supplied %s field outright',
    async (field) => {
      const { customer, orderId } = await customerWithOrder();

      await authorize(customer.accessToken, orderId, { [field]: 'attacker-value' }).expect(400);
      expect(await ctx.prisma.payment.count()).toBe(0);
    },
  );

  it('rejects an amount that disagrees with the order total', async () => {
    const { customer, orderId } = await customerWithOrder({ grandTotal: 10_000 });

    const response = await authorize(customer.accessToken, orderId, { amount: 1 }).expect(400);
    expect(response.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it("does not let a customer pay another customer's order", async () => {
    const { orderId } = await customerWithOrder();
    const intruder = await createUserWithRole(ctx, 'CUSTOMER');

    const response = await authorize(intruder.accessToken, orderId).expect(404);
    expect(response.body.error.code).toBe(ErrorCode.ORDER_NOT_FOUND);
    expect(await ctx.prisma.payment.count()).toBe(0);
  });

  it('requires authentication', async () => {
    const { orderId } = await customerWithOrder();

    await request(ctx.server)
      .post('/payments/authorize')
      .set('Idempotency-Key', `pay-${randomUUID()}`)
      .send(authorizeBody(orderId))
      .expect(401);
  });

  it.each([
    ['COD', 'COD'],
    ['WALLET', 'WALLET'],
  ])('reports %s as unroutable — no gateway authorizes it', async (_name, method) => {
    const { customer, orderId } = await customerWithOrder();

    const response = await authorize(customer.accessToken, orderId, { method }).expect(400);
    expect(response.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  // -------------------------------------------------------------------------------------------
  // GET /payments/:id
  // -------------------------------------------------------------------------------------------

  it('returns a safe payment view that never includes the provider token', async () => {
    const { customer, orderId, grandTotal } = await customerWithOrder();
    const created = body(
      await authorize(customer.accessToken, orderId, { token: 'tok_opaque_secret' }).expect(201),
    );

    const response = await request(ctx.server)
      .get(`/payments/${idOf(created)}`)
      .set(...auth(customer.accessToken))
      .expect(200);
    const view = body(response);

    expect(Object.keys(view).sort()).toEqual(
      [
        'paymentId',
        'orderId',
        'amount',
        'currency',
        'method',
        'status',
        'provider',
        'providerRef',
        'authorizedAt',
        'capturedAt',
        'failureReason',
        'createdAt',
      ].sort(),
    );
    expect(view.amount).toBe(grandTotal);
    expect(view.status).toBe('AUTHORIZED');
    // The token was accepted and persisted, but must never come back out.
    expect(JSON.stringify(response.body)).not.toContain('tok_opaque_secret');
    await expect(
      ctx.prisma.payment.findUniqueOrThrow({ where: { id: idOf(created) } }),
    ).resolves.toMatchObject({ providerToken: 'tok_opaque_secret' });
  });

  it("does not reveal that another customer's payment exists", async () => {
    const { customer, orderId } = await customerWithOrder();
    const created = body(await authorize(customer.accessToken, orderId).expect(201));
    const intruder = await createUserWithRole(ctx, 'CUSTOMER');

    const found = await request(ctx.server)
      .get(`/payments/${idOf(created)}`)
      .set(...auth(intruder.accessToken))
      .expect(404);
    const missing = await request(ctx.server)
      .get(`/payments/${randomUUID()}`)
      .set(...auth(intruder.accessToken))
      .expect(404);

    // Byte-identical: existence is not observable.
    expect(found.body.error.code).toBe(missing.body.error.code);
    expect(found.body.error.message).toBe(missing.body.error.message);
  });

  // -------------------------------------------------------------------------------------------
  // Capture / void
  // -------------------------------------------------------------------------------------------

  it('captures an authorized payment and posts the ledger transaction', async () => {
    const { customer, orderId } = await customerWithOrder({
      grandTotal: 10_000,
      platformFee: 1_000,
    });
    const created = body(await authorize(customer.accessToken, orderId).expect(201));
    const finance = await createUserWithRole(ctx, 'FINANCE_OFFICER');

    const response = await request(ctx.server)
      .post(`/payments/${idOf(created)}/capture`)
      .set(...auth(finance.accessToken))
      .set('Idempotency-Key', `cap-${randomUUID()}`)
      .send({})
      .expect(200);

    expect(body(response)).toMatchObject({
      paymentId: idOf(created),
      status: 'CAPTURED',
      fee: 1_000,
      providerNet: 9_000,
      replay: false,
    });
    // Ledger internals stay out of the HTTP surface.
    expect(body(response).ledgerReference).toBeUndefined();

    const txn = await ctx.prisma.ledgerTransaction.findUniqueOrThrow({
      where: { reference: `CAPTURE-${created.paymentId}` },
      include: { entries: true },
    });
    expect(txn.entries).toHaveLength(3);
  });

  it('refuses capture from a customer — it is a finance operation', async () => {
    const { customer, orderId } = await customerWithOrder();
    const created = body(await authorize(customer.accessToken, orderId).expect(201));

    await request(ctx.server)
      .post(`/payments/${idOf(created)}/capture`)
      .set(...auth(customer.accessToken))
      .set('Idempotency-Key', `cap-${randomUUID()}`)
      .send({})
      .expect(403);

    expect(await ctx.prisma.ledgerTransaction.count()).toBe(0);
  });

  it('refuses capture of a payment that is not authorized', async () => {
    const { customer, orderId } = await customerWithOrder();
    const created = body(
      await authorize(customer.accessToken, orderId, {
        returnUrl: 'https://app.example/return',
      }).expect(201),
    );
    const finance = await createUserWithRole(ctx, 'FINANCE_OFFICER');

    const response = await request(ctx.server)
      .post(`/payments/${idOf(created)}/capture`)
      .set(...auth(finance.accessToken))
      .set('Idempotency-Key', `cap-${randomUUID()}`)
      .send({})
      .expect(409);

    expect(response.body.error.code).toBe(ErrorCode.INVALID_PAYMENT_STATE_TRANSITION);
    expect(await ctx.prisma.ledgerTransaction.count()).toBe(0);
  });

  it('rejects a capture body that tries to override the amount', async () => {
    const { customer, orderId } = await customerWithOrder();
    const created = body(await authorize(customer.accessToken, orderId).expect(201));
    const finance = await createUserWithRole(ctx, 'FINANCE_OFFICER');

    await request(ctx.server)
      .post(`/payments/${idOf(created)}/capture`)
      .set(...auth(finance.accessToken))
      .set('Idempotency-Key', `cap-${randomUUID()}`)
      .send({ amount: 1 })
      .expect(400);
  });

  it('voids an authorized payment, and refuses to void a captured one', async () => {
    const { customer, orderId } = await customerWithOrder();
    const created = body(await authorize(customer.accessToken, orderId).expect(201));
    const finance = await createUserWithRole(ctx, 'FINANCE_OFFICER');

    const voided = await request(ctx.server)
      .post(`/payments/${idOf(created)}/void`)
      .set(...auth(finance.accessToken))
      .set('Idempotency-Key', `void-${randomUUID()}`)
      .send({ reason: 'Customer cancelled' })
      .expect(200);

    expect(body(voided)).toMatchObject({ status: 'VOIDED', replay: false });
    expect(await ctx.prisma.ledgerTransaction.count()).toBe(0);

    // A second void replays; capture is now refused outright.
    const replay = await request(ctx.server)
      .post(`/payments/${idOf(created)}/void`)
      .set(...auth(finance.accessToken))
      .set('Idempotency-Key', `void-${randomUUID()}`)
      .send({})
      .expect(200);
    expect(body(replay).replay).toBe(true);
  });

  it('maps an already-captured void to PAYMENT_ALREADY_CAPTURED', async () => {
    const { customer, orderId } = await customerWithOrder();
    const created = body(await authorize(customer.accessToken, orderId).expect(201));
    const finance = await createUserWithRole(ctx, 'FINANCE_OFFICER');

    await request(ctx.server)
      .post(`/payments/${idOf(created)}/capture`)
      .set(...auth(finance.accessToken))
      .set('Idempotency-Key', `cap-${randomUUID()}`)
      .send({})
      .expect(200);

    const response = await request(ctx.server)
      .post(`/payments/${idOf(created)}/void`)
      .set(...auth(finance.accessToken))
      .set('Idempotency-Key', `void-${randomUUID()}`)
      .send({})
      .expect(409);

    expect(response.body.error.code).toBe(ErrorCode.PAYMENT_ALREADY_CAPTURED);
  });

  it('reports an unavailable gateway as a dependency failure, not a success', async () => {
    const { customer, orderId } = await customerWithOrder();
    const created = body(await authorize(customer.accessToken, orderId).expect(201));
    // Telebirr is registered but fail-closed: no authoritative provider contract exists.
    await ctx.prisma.payment.update({
      where: { id: idOf(created) },
      data: { provider: 'telebirr' },
    });
    const finance = await createUserWithRole(ctx, 'FINANCE_OFFICER');

    const response = await request(ctx.server)
      .post(`/payments/${idOf(created)}/capture`)
      .set(...auth(finance.accessToken))
      .set('Idempotency-Key', `cap-${randomUUID()}`)
      .send({})
      .expect(503);

    expect(response.body.error.code).toBe(ErrorCode.DEPENDENCY_UNAVAILABLE);
    expect(await ctx.prisma.ledgerTransaction.count()).toBe(0);
  });

  // -------------------------------------------------------------------------------------------
  // POST /webhooks/payments/:provider
  // -------------------------------------------------------------------------------------------

  function signedPost(providerRoute: string, payload: Record<string, unknown>, secret = WEBHOOK_SECRET) {
    const rawBody = JSON.stringify(payload);
    return request(ctx.server)
      .post(`/webhooks/payments/${providerRoute}`)
      .set('Content-Type', 'application/json')
      .set(MOCK_WEBHOOK_SIGNATURE_HEADER, computeHmacSignature(secret, rawBody))
      .send(rawBody);
  }

  /** Authorizes asynchronously, leaving the payment INITIATED for a callback to resolve. */
  async function pendingPayment() {
    const { customer, orderId, pharmacyId } = await customerWithOrder();
    const created = body(
      await authorize(customer.accessToken, orderId, {
        returnUrl: 'https://app.example/return',
      }).expect(201),
    );
    expect(created.status).toBe('INITIATED');
    return { paymentId: idOf(created), orderId, pharmacyId, customer };
  }

  it('accepts a correctly signed callback with no bearer token at all', async () => {
    const { paymentId } = await pendingPayment();
    const eventId = `evt-${randomUUID()}`;

    const response = await signedPost('mock', {
      id: eventId,
      type: 'payment.authorized',
      paymentId,
    }).expect(200);

    expect(response.body.data).toEqual({ received: true, outcome: 'ADVANCED' });
    await expect(
      ctx.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } }),
    ).resolves.toMatchObject({ status: 'AUTHORIZED' });
    await expect(
      ctx.prisma.providerWebhook.findFirstOrThrow({ where: { eventId } }),
    ).resolves.toMatchObject({ provider: 'mock' });
  });

  it('answers 200 to a duplicate delivery and applies it once', async () => {
    const { paymentId } = await pendingPayment();
    const eventId = `evt-${randomUUID()}`;
    const payload = { id: eventId, type: 'payment.authorized', paymentId };

    await signedPost('mock', payload).expect(200);
    const second = await signedPost('mock', payload).expect(200);

    expect(second.body.data.outcome).toBe('DUPLICATE');
    expect(await ctx.prisma.providerWebhook.count({ where: { eventId } })).toBe(1);
    expect(
      await ctx.prisma.outbox.count({
        where: { aggregateId: paymentId, eventType: 'payment.authorized' },
      }),
    ).toBe(1);
  });

  it('answers 200 to an already-applied callback', async () => {
    const { customer, orderId } = await customerWithOrder();
    // Synchronous authorization: the local command already advanced the payment.
    const created = body(await authorize(customer.accessToken, orderId).expect(201));

    const response = await signedPost('mock', {
      id: `evt-${randomUUID()}`,
      type: 'payment.authorized',
      paymentId: idOf(created),
    }).expect(200);

    expect(response.body.data.outcome).toBe('ALREADY_APPLIED');
  });

  it('answers 200 to an unclassifiable callback and leaves the payment recoverable', async () => {
    const { paymentId } = await pendingPayment();

    const response = await signedPost('mock', {
      id: `evt-${randomUUID()}`,
      type: 'payment.some_new_event',
      paymentId,
    }).expect(200);

    expect(response.body.data.outcome).toBe('DEFERRED');
    await expect(
      ctx.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } }),
    ).resolves.toMatchObject({ status: 'INITIATED', failureReason: null });
  });

  it('rejects a wrongly signed callback with 401 and writes nothing', async () => {
    const { paymentId } = await pendingPayment();

    const response = await signedPost(
      'mock',
      { id: `evt-${randomUUID()}`, type: 'payment.authorized', paymentId },
      'the-wrong-secret',
    ).expect(401);

    expect(response.body.error.code).toBe(ErrorCode.WEBHOOK_SIGNATURE_INVALID);
    expect(await ctx.prisma.providerWebhook.count()).toBe(0);
    await expect(
      ctx.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } }),
    ).resolves.toMatchObject({ status: 'INITIATED' });
  });

  it('verifies against the exact received bytes, not a re-serialization', async () => {
    const { paymentId } = await pendingPayment();
    // Signature computed over compact JSON, body sent with different whitespace: a controller
    // that re-serialized the parsed body would wrongly accept this.
    const payload = { id: `evt-${randomUUID()}`, type: 'payment.authorized', paymentId };
    const signature = computeHmacSignature(WEBHOOK_SECRET, JSON.stringify(payload));

    await request(ctx.server)
      .post('/webhooks/payments/mock')
      .set('Content-Type', 'application/json')
      .set(MOCK_WEBHOOK_SIGNATURE_HEADER, signature)
      .send(JSON.stringify(payload, null, 2))
      .expect(401);

    // The same signature over the exact bytes it was computed for is accepted.
    await signedPost('mock', payload).expect(200);
  });

  it('refuses an unintegrated provider, including Telebirr', async () => {
    for (const provider of ['telebirr', 'not-a-gateway']) {
      const response = await signedPost(provider, {
        id: `evt-${randomUUID()}`,
        type: 'payment.authorized',
      }).expect(400);
      expect(response.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
    }
    expect(await ctx.prisma.providerWebhook.count()).toBe(0);
  });

  it('never echoes the payload, the signature or a secret back to the caller', async () => {
    const { paymentId } = await pendingPayment();
    const marker = 'raw-provider-blob-marker';

    const response = await signedPost('mock', {
      id: `evt-${randomUUID()}`,
      type: 'payment.authorized',
      paymentId,
      providerInternals: marker,
    }).expect(200);

    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain(marker);
    expect(serialized).not.toContain(WEBHOOK_SECRET);
    expect(serialized).not.toContain(MOCK_WEBHOOK_SIGNATURE_HEADER);
    expect(response.body.data).toEqual({ received: true, outcome: 'ADVANCED' });

    // It is stored where the design says it belongs, and nowhere else.
    const webhook = await ctx.prisma.providerWebhook.findFirstOrThrow();
    expect(JSON.stringify(webhook.payload)).toContain(marker);
    const audits = await ctx.prisma.auditLog.findMany({ where: { resourceId: paymentId } });
    expect(JSON.stringify(audits)).not.toContain(marker);
  });
});
