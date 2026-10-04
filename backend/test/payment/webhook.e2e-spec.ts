import { randomUUID } from 'crypto';
import { AuthorizePaymentCommand } from '../../src/modules/payment/application/commands/authorize-payment.command';
import { CapturePaymentCommand } from '../../src/modules/payment/application/commands/capture-payment.command';
import {
  ProcessWebhookCommand,
  WebhookOutcome,
} from '../../src/modules/payment/application/commands/process-webhook.command';
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
import { ReconciliationService } from '../../src/modules/payment/application/services/reconciliation.service';
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
  MOCK_WEBHOOK_SIGNATURE_HEADER,
  MOCK_WEBHOOK_SECRET_KEY,
} from '../../src/modules/payment/infrastructure/webhooks/mock-webhook.adapter';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

const WEBHOOK_SECRET = 'e2e-webhook-secret-value-0123456789';

/**
 * Outbound gateway double. The *webhook* side is deliberately NOT replaced: the real
 * `MockWebhookAdapter` verifies real HMAC-SHA256 signatures against the configured secret, so the
 * security boundary these tests exercise is the one that ships. Only the outbound charge/capture
 * calls are stubbed, because those would otherwise reach a network.
 */
class FakeGateway implements IPaymentProviderPort {
  readonly key = 'mock';
  nextCapture: ProviderCaptureResult = { outcome: 'CAPTURED', providerRef: null };

  supports(method: PaymentMethod): boolean {
    return method !== PaymentMethod.COD && method !== PaymentMethod.WALLET;
  }
  async authorize(request: ProviderAuthorizationRequest): Promise<ProviderAuthorizationResult> {
    // Async/redirect: the payment stays INITIATED and only a callback can advance it — exactly
    // the recovery gap this task closes.
    return {
      outcome: 'PENDING',
      providerRef: `gw-auth-${request.paymentId}`,
      redirectUrl: 'https://gateway.example/hosted',
    };
  }
  async capture(request: ProviderPaymentOperationRequest): Promise<ProviderCaptureResult> {
    return {
      ...this.nextCapture,
      providerRef: this.nextCapture.providerRef ?? `gw-capture-${request.paymentId}`,
    };
  }
  async voidAuthorization(request: ProviderPaymentOperationRequest): Promise<ProviderVoidResult> {
    return { outcome: 'VOIDED', providerRef: `gw-void-${request.paymentId}` };
  }
  async refund(request: ProviderRefundRequest): Promise<ProviderRefundResult> {
    return { outcome: 'REFUNDED', providerRef: `gw-refund-${request.refundId}` };
  }
}

describe('Payment webhooks and reconciliation (e2e)', () => {
  let ctx: TestContext;
  let gateway: FakeGateway;
  let authorize: AuthorizePaymentCommand;
  let capture: CapturePaymentCommand;
  let processWebhook: ProcessWebhookCommand;
  let reconciliation: ReconciliationService;
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
    reconciliation = ctx.app.get(ReconciliationService);
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

  /** Signs a body with the real HMAC scheme the adapter verifies. */
  function signed(body: Record<string, unknown>): RawWebhookDelivery {
    const rawBody = JSON.stringify(body);
    return {
      provider: 'mock',
      rawBody,
      headers: { [MOCK_WEBHOOK_SIGNATURE_HEADER]: computeHmacSignature(WEBHOOK_SECRET, rawBody) },
    };
  }

  /**
   * Seeds a Module 06 order with its single fulfillment and authorizes a payment through the real
   * command. The stub gateway answers `PENDING`, so the payment lands in `INITIATED` — the state
   * a callback exists to resolve.
   */
  async function seedPendingPayment(options: { platformFee?: number; grandTotal?: number } = {}) {
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
    await ctx.prisma.fulfillment.create({
      data: { orderId: order.id, pharmacyId, branchId: `branch-${randomUUID()}` },
    });

    const result = await authorize.execute({
      customerUserId,
      orderId: order.id,
      method: PaymentMethod.TELEBIRR,
      idempotencyKey: `pay-${randomUUID()}`,
    });
    expect(result.status).toBe(PaymentStatus.INITIATED);

    return { paymentId: result.paymentId, orderId: order.id, pharmacyId, customerUserId };
  }

  async function balanceOf(ref: AccountRef): Promise<number> {
    const account = await ledger.resolveAccount(ref);
    return (await ledger.balanceOf(account.id)).amountMinor;
  }

  // -------------------------------------------------------------------------------------------
  // Authorization callbacks
  // -------------------------------------------------------------------------------------------

  it('an authorization-success callback advances INITIATED -> AUTHORIZED and records the webhook', async () => {
    const seed = await seedPendingPayment();
    const eventId = `evt-${randomUUID()}`;

    const result = await processWebhook.execute(
      signed({
        id: eventId,
        type: 'payment.authorized',
        paymentId: seed.paymentId,
        providerRef: 'gw-confirmed-1',
      }),
    );

    expect(result.outcome).toBe(WebhookOutcome.Advanced);
    expect(result.accepted).toBe(true);

    const payment = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: seed.paymentId } });
    expect(payment.status).toBe('AUTHORIZED');
    expect(payment.providerRef).toBe('gw-confirmed-1');
    expect(payment.authorizedAt).toBeInstanceOf(Date);

    const webhook = await ctx.prisma.providerWebhook.findUniqueOrThrow({
      where: { provider_eventId: { provider: 'mock', eventId } },
    });
    expect(webhook.processedAt).toBeInstanceOf(Date);
    expect(webhook.payload).toMatchObject({ id: eventId, type: 'payment.authorized' });

    // No money moved.
    expect(await ctx.prisma.ledgerTransaction.count()).toBe(0);
    expect(await ctx.prisma.ledgerEntry.count()).toBe(0);
  });

  it('writes the audit entry and the catalogued outbox event for an authorization callback', async () => {
    const seed = await seedPendingPayment();

    await processWebhook.execute(
      signed({ id: `evt-${randomUUID()}`, type: 'payment.authorized', paymentId: seed.paymentId }),
    );

    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { resourceId: seed.paymentId, action: 'PAYMENT_AUTHORIZED' },
    });
    expect(audit.context).toMatchObject({
      paymentId: seed.paymentId,
      orderId: seed.orderId,
      source: 'webhook',
      provider: 'mock',
      outcome: 'AUTHORIZED',
    });

    const events = await ctx.prisma.outbox.findMany({
      where: { aggregateId: seed.paymentId, eventType: 'payment.authorized' },
    });
    expect(events).toHaveLength(1);
    expect((events[0].payload as { payload: Record<string, unknown> }).payload).toEqual({
      paymentId: seed.paymentId,
      orderId: seed.orderId,
    });
  });

  it('an authorization-failure callback advances INITIATED -> FAILED with a sanitized reason', async () => {
    const seed = await seedPendingPayment();

    const result = await processWebhook.execute(
      signed({
        id: `evt-${randomUUID()}`,
        type: 'payment.failed',
        paymentId: seed.paymentId,
        reason: 'Declined for card 4111 1111 1111 1111',
        code: 'do_not_honor',
      }),
    );

    expect(result.status).toBe(PaymentStatus.FAILED);
    const payment = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: seed.paymentId } });
    expect(payment.status).toBe('FAILED');
    expect(payment.failureReason).not.toContain('4111');
    expect(payment.failureReason).toContain('[redacted]');

    const events = await ctx.prisma.outbox.findMany({
      where: { aggregateId: seed.paymentId, eventType: 'payment.failed' },
    });
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0].payload)).not.toContain('4111');
    expect(await ctx.prisma.ledgerEntry.count()).toBe(0);
  });

  // -------------------------------------------------------------------------------------------
  // Capture callbacks
  // -------------------------------------------------------------------------------------------

  it('a capture callback advances AUTHORIZED -> CAPTURED and posts the balanced three-leg transaction', async () => {
    const seed = await seedPendingPayment({ grandTotal: 10_000, platformFee: 1_000 });
    await processWebhook.execute(
      signed({ id: `evt-${randomUUID()}`, type: 'payment.authorized', paymentId: seed.paymentId }),
    );

    const result = await processWebhook.execute(
      signed({
        id: `evt-${randomUUID()}`,
        type: 'payment.captured',
        paymentId: seed.paymentId,
        providerRef: 'gw-captured-1',
      }),
    );

    expect(result.outcome).toBe(WebhookOutcome.Advanced);
    const payment = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: seed.paymentId } });
    expect(payment.status).toBe('CAPTURED');
    expect(payment.capturedAt).toBeInstanceOf(Date);

    const txn = await ctx.prisma.ledgerTransaction.findUniqueOrThrow({
      where: { reference: `CAPTURE-${seed.paymentId}` },
      include: { entries: { include: { account: true } } },
    });
    expect(txn.entries).toHaveLength(3);
    const leg = (type: LedgerAccountType) => txn.entries.find((e) => e.account.type === type);
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
    expect(leg(LedgerAccountType.PROVIDER_PAYABLE)?.account.ownerId).toBe(seed.pharmacyId);

    const sum = (d: LedgerDirection) =>
      txn.entries.filter((e) => e.direction === d).reduce((t, e) => t + e.amount, 0);
    expect(sum(LedgerDirection.DEBIT)).toBe(sum(LedgerDirection.CREDIT));
    expect(await balanceOf(AccountRef.providerPayable(seed.pharmacyId, 'ETB'))).toBe(9_000);

    const events = await ctx.prisma.outbox.findMany({
      where: { aggregateId: seed.paymentId, eventType: 'payment.captured' },
    });
    expect(events).toHaveLength(1);
  });

  // -------------------------------------------------------------------------------------------
  // Deduplication, concurrency and races
  // -------------------------------------------------------------------------------------------

  it('a duplicate delivery is a no-op: one webhook row, one event, one audit', async () => {
    const seed = await seedPendingPayment();
    const eventId = `evt-${randomUUID()}`;
    const delivery = signed({
      id: eventId,
      type: 'payment.authorized',
      paymentId: seed.paymentId,
    });

    const first = await processWebhook.execute(delivery);
    const second = await processWebhook.execute(delivery);

    expect(first.outcome).toBe(WebhookOutcome.Advanced);
    expect(second.outcome).toBe(WebhookOutcome.Duplicate);
    expect(second.accepted).toBe(true);

    expect(await ctx.prisma.providerWebhook.count({ where: { eventId } })).toBe(1);
    expect(
      await ctx.prisma.outbox.count({
        where: { aggregateId: seed.paymentId, eventType: 'payment.authorized' },
      }),
    ).toBe(1);
    expect(
      await ctx.prisma.auditLog.count({
        where: { resourceId: seed.paymentId, action: 'PAYMENT_AUTHORIZED' },
      }),
    ).toBe(1);
  });

  it('concurrent deliveries of one event produce exactly one effect', async () => {
    const seed = await seedPendingPayment();
    const eventId = `evt-${randomUUID()}`;
    const delivery = signed({
      id: eventId,
      type: 'payment.authorized',
      paymentId: seed.paymentId,
    });

    const results = await Promise.allSettled([
      processWebhook.execute(delivery),
      processWebhook.execute(delivery),
      processWebhook.execute(delivery),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThan(0);

    // The (provider, eventId) unique index is the final guard.
    expect(await ctx.prisma.providerWebhook.count({ where: { eventId } })).toBe(1);
    expect(
      await ctx.prisma.outbox.count({
        where: { aggregateId: seed.paymentId, eventType: 'payment.authorized' },
      }),
    ).toBe(1);
    const payment = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: seed.paymentId } });
    expect(payment.status).toBe('AUTHORIZED');
  });

  it('the same event id from a different provider is a different event', async () => {
    const eventId = `evt-${randomUUID()}`;
    await ctx.prisma.providerWebhook.create({
      data: { provider: 'other-gateway', eventId, payload: {}, processedAt: new Date() },
    });

    const seed = await seedPendingPayment();
    const result = await processWebhook.execute(
      signed({ id: eventId, type: 'payment.authorized', paymentId: seed.paymentId }),
    );

    expect(result.outcome).toBe(WebhookOutcome.Advanced);
    expect(await ctx.prisma.providerWebhook.count({ where: { eventId } })).toBe(2);
  });

  it('enforces (provider, eventId) uniqueness at the database level', async () => {
    const eventId = `evt-${randomUUID()}`;
    await ctx.prisma.providerWebhook.create({
      data: { provider: 'mock', eventId, payload: {} },
    });
    await expect(
      ctx.prisma.providerWebhook.create({ data: { provider: 'mock', eventId, payload: {} } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('a capture callback racing a committed local capture posts no second transaction', async () => {
    const seed = await seedPendingPayment();
    await processWebhook.execute(
      signed({ id: `evt-${randomUUID()}`, type: 'payment.authorized', paymentId: seed.paymentId }),
    );
    // The local command wins the race.
    await capture.execute({ paymentId: seed.paymentId });

    const result = await processWebhook.execute(
      signed({ id: `evt-${randomUUID()}`, type: 'payment.captured', paymentId: seed.paymentId }),
    );

    expect(result.outcome).toBe(WebhookOutcome.AlreadyApplied);
    expect(await ctx.prisma.ledgerTransaction.count()).toBe(1);
    expect(await ctx.prisma.ledgerEntry.count()).toBe(3);
    expect(
      await ctx.prisma.outbox.count({
        where: { aggregateId: seed.paymentId, eventType: 'payment.captured' },
      }),
    ).toBe(1);
    expect(await balanceOf(AccountRef.providerPayable(seed.pharmacyId, 'ETB'))).toBe(9_000);
  });

  it('an authorization callback arriving after the payment already captured changes nothing', async () => {
    const seed = await seedPendingPayment();
    await processWebhook.execute(
      signed({ id: `evt-${randomUUID()}`, type: 'payment.authorized', paymentId: seed.paymentId }),
    );
    await capture.execute({ paymentId: seed.paymentId });

    const result = await processWebhook.execute(
      signed({ id: `evt-${randomUUID()}`, type: 'payment.authorized', paymentId: seed.paymentId }),
    );

    expect(result.outcome).toBe(WebhookOutcome.AlreadyApplied);
    const payment = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: seed.paymentId } });
    expect(payment.status).toBe('CAPTURED');
    expect(
      await ctx.prisma.outbox.count({
        where: { aggregateId: seed.paymentId, eventType: 'payment.authorized' },
      }),
    ).toBe(1);
  });

  // -------------------------------------------------------------------------------------------
  // Signature, unknown outcomes and failure handling
  // -------------------------------------------------------------------------------------------

  it('rejects an unsigned or tampered delivery and records nothing', async () => {
    const seed = await seedPendingPayment();
    const delivery = signed({
      id: `evt-${randomUUID()}`,
      type: 'payment.authorized',
      paymentId: seed.paymentId,
    });

    await expect(
      processWebhook.execute({ ...delivery, headers: { [MOCK_WEBHOOK_SIGNATURE_HEADER]: 'nope' } }),
    ).rejects.toMatchObject({ code: ErrorCode.WEBHOOK_SIGNATURE_INVALID, httpStatus: 401 });

    expect(await ctx.prisma.providerWebhook.count()).toBe(0);
    const payment = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: seed.paymentId } });
    expect(payment.status).toBe('INITIATED');

    // Audited as a security event, with no signature or body in the context.
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'PAYMENT_WEBHOOK_SIGNATURE_INVALID' },
    });
    expect(audit.context).toEqual({ provider: 'mock' });
  });

  it('refuses a callback for an unintegrated provider', async () => {
    const delivery = signed({ id: `evt-${randomUUID()}`, type: 'payment.authorized' });
    await expect(
      processWebhook.execute({ ...delivery, provider: 'telebirr' }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    expect(await ctx.prisma.providerWebhook.count()).toBe(0);
  });

  it('an unclassifiable callback is recorded and deferred, never marked FAILED', async () => {
    const seed = await seedPendingPayment();

    const result = await processWebhook.execute(
      signed({
        id: `evt-${randomUUID()}`,
        type: 'payment.something_new',
        paymentId: seed.paymentId,
      }),
    );

    expect(result.outcome).toBe(WebhookOutcome.Deferred);
    expect(result.accepted).toBe(true);
    const payment = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: seed.paymentId } });
    expect(payment.status).toBe('INITIATED');
    expect(payment.failureReason).toBeNull();
    expect(await ctx.prisma.ledgerEntry.count()).toBe(0);
    expect(await ctx.prisma.providerWebhook.count()).toBe(1);
    expect(
      await ctx.prisma.auditLog.count({ where: { action: 'PAYMENT_WEBHOOK_DEFERRED' } }),
    ).toBe(1);
  });

  it('a contradictory callback is rejected and preserved unprocessed for reconciliation', async () => {
    const seed = await seedPendingPayment();
    await processWebhook.execute(
      signed({ id: `evt-${randomUUID()}`, type: 'payment.authorized', paymentId: seed.paymentId }),
    );
    await capture.execute({ paymentId: seed.paymentId });

    // Authorization *failed*, for money already captured.
    const eventId = `evt-${randomUUID()}`;
    await expect(
      processWebhook.execute(
        signed({ id: eventId, type: 'payment.failed', paymentId: seed.paymentId }),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_PAYMENT_STATE_TRANSITION });

    const payment = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: seed.paymentId } });
    expect(payment.status).toBe('CAPTURED');
    // The whole business transaction rolled back, and the delivery survives unprocessed.
    const webhook = await ctx.prisma.providerWebhook.findUniqueOrThrow({
      where: { provider_eventId: { provider: 'mock', eventId } },
    });
    expect(webhook.processedAt).toBeNull();
    expect(await ctx.prisma.ledgerTransaction.count()).toBe(1);
  });

  it('stores the raw payload only in provider_webhooks, never in audit or outbox', async () => {
    const seed = await seedPendingPayment();
    const marker = 'raw-provider-blob-marker';

    await processWebhook.execute(
      signed({
        id: `evt-${randomUUID()}`,
        type: 'payment.authorized',
        paymentId: seed.paymentId,
        providerInternals: marker,
      }),
    );

    const webhook = await ctx.prisma.providerWebhook.findFirstOrThrow();
    expect(JSON.stringify(webhook.payload)).toContain(marker);

    const audits = await ctx.prisma.auditLog.findMany({ where: { resourceId: seed.paymentId } });
    const events = await ctx.prisma.outbox.findMany({ where: { aggregateId: seed.paymentId } });
    expect(JSON.stringify(audits)).not.toContain(marker);
    expect(JSON.stringify(events)).not.toContain(marker);
    // And no signature ever lands anywhere.
    expect(JSON.stringify({ audits, events, webhook })).not.toContain(
      MOCK_WEBHOOK_SIGNATURE_HEADER,
    );
  });

  // -------------------------------------------------------------------------------------------
  // Reconciliation foundation
  // -------------------------------------------------------------------------------------------

  it('finds a stuck INITIATED payment as a reconciliation candidate', async () => {
    const seed = await seedPendingPayment();
    // Age the payment past the staleness threshold.
    await ctx.prisma.payment.update({
      where: { id: seed.paymentId },
      data: { updatedAt: new Date(Date.now() - 60 * 60_000) },
    });

    const sweep = await reconciliation.sweep({ olderThanMinutes: 15 });

    const candidate = sweep.candidates.find((c) => c.paymentId === seed.paymentId);
    expect(candidate).toBeDefined();
    expect(candidate).toMatchObject({
      orderId: seed.orderId,
      status: PaymentStatus.INITIATED,
      provider: 'mock',
      providerRef: `gw-auth-${seed.paymentId}`,
      // No IProviderStatusPort adapter is bound yet, so nothing can resolve it automatically.
      providerLookupAvailable: false,
    });
    expect(candidate!.stuckForMinutes).toBeGreaterThanOrEqual(59);
    expect(sweep.unresolvableCount).toBeGreaterThanOrEqual(1);

    expect(
      await ctx.prisma.auditLog.count({ where: { action: 'PAYMENT_RECONCILIATION_SWEEP' } }),
    ).toBe(1);
  });

  it('stops reporting a payment once a callback has resolved it', async () => {
    const seed = await seedPendingPayment();
    await ctx.prisma.payment.update({
      where: { id: seed.paymentId },
      data: { updatedAt: new Date(Date.now() - 60 * 60_000) },
    });

    await processWebhook.execute(
      signed({ id: `evt-${randomUUID()}`, type: 'payment.failed', paymentId: seed.paymentId }),
    );

    const sweep = await reconciliation.sweep({ olderThanMinutes: 15 });
    expect(sweep.candidates.find((c) => c.paymentId === seed.paymentId)).toBeUndefined();
  });

  it('surfaces callbacks that were recorded but never completed', async () => {
    await ctx.prisma.providerWebhook.create({
      data: { provider: 'mock', eventId: `evt-${randomUUID()}`, payload: { a: 1 } },
    });

    const sweep = await reconciliation.sweep();

    expect(sweep.unprocessedWebhooks).toHaveLength(1);
    expect(sweep.unprocessedWebhooks[0].provider).toBe('mock');
  });
});
