import { randomUUID } from 'crypto';
import { AuthorizePaymentCommand } from '../../src/modules/payment/application/commands/authorize-payment.command';
import { CapturePaymentCommand } from '../../src/modules/payment/application/commands/capture-payment.command';
import {
  ProcessWebhookCommand,
  WebhookOutcome,
} from '../../src/modules/payment/application/commands/process-webhook.command';
import {
  IPaymentProviderRegistry,
  PAYMENT_PROVIDER_REGISTRY,
} from '../../src/modules/payment/application/ports/outbound/payment-provider.port';
import {
  IPaymentWebhookRegistry,
  PAYMENT_WEBHOOK_REGISTRY,
} from '../../src/modules/payment/application/ports/outbound/payment-webhook.port';
import { ReconciliationService } from '../../src/modules/payment/application/services/reconciliation.service';
import { PaymentMethod, PaymentStatus } from '../../src/modules/payment/domain/enums';
import { TelebirrAdapter } from '../../src/modules/payment/infrastructure/providers/telebirr/telebirr.adapter';
import { TelebirrWebhookAdapter } from '../../src/modules/payment/infrastructure/webhooks/telebirr-webhook.adapter';
import { computeHmacSignature } from '../../src/modules/payment/infrastructure/webhooks/hmac-signature';
import {
  MOCK_WEBHOOK_SECRET_KEY,
  MOCK_WEBHOOK_SIGNATURE_HEADER,
} from '../../src/modules/payment/infrastructure/webhooks/mock-webhook.adapter';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

const WEBHOOK_SECRET = 'e2e-webhook-secret-value-0123456789';

/**
 * Provider strategy wired through the real Nest container — the shipped `AppModule`, the real
 * `PaymentProviderRegistry`, the real `MockPaymentProvider` and the real `TelebirrAdapter`. No
 * provider is substituted here (unlike the other payment e2e suites), because the point is to
 * prove what the *production* wiring resolves to.
 *
 * No network call is made or possible: the mock adapter is in-process, and the Telebirr adapter
 * refuses every operation because its contract is absent from this repository.
 */
describe('Payment provider registry wiring (e2e)', () => {
  let ctx: TestContext;
  let registry: IPaymentProviderRegistry;
  let webhookRegistry: IPaymentWebhookRegistry;
  let authorize: AuthorizePaymentCommand;
  let capture: CapturePaymentCommand;
  let processWebhook: ProcessWebhookCommand;
  let reconciliation: ReconciliationService;
  let previousSecret: string | undefined;

  beforeAll(async () => {
    previousSecret = process.env[MOCK_WEBHOOK_SECRET_KEY];
    process.env[MOCK_WEBHOOK_SECRET_KEY] = WEBHOOK_SECRET;

    ctx = await createTestApp();
    registry = ctx.app.get<IPaymentProviderRegistry>(PAYMENT_PROVIDER_REGISTRY);
    webhookRegistry = ctx.app.get<IPaymentWebhookRegistry>(PAYMENT_WEBHOOK_REGISTRY);
    authorize = ctx.app.get(AuthorizePaymentCommand);
    capture = ctx.app.get(CapturePaymentCommand);
    processWebhook = ctx.app.get(ProcessWebhookCommand);
    reconciliation = ctx.app.get(ReconciliationService);
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

  function signed(body: Record<string, unknown>) {
    const rawBody = JSON.stringify(body);
    return {
      provider: 'mock',
      rawBody,
      headers: { [MOCK_WEBHOOK_SIGNATURE_HEADER]: computeHmacSignature(WEBHOOK_SECRET, rawBody) },
    };
  }

  async function seedOrder(options: { platformFee?: number; grandTotal?: number } = {}) {
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
    return { orderId: order.id, customerUserId, pharmacyId };
  }

  // -------------------------------------------------------------------------------------------
  // Registry wiring
  // -------------------------------------------------------------------------------------------

  it('is constructed by Nest with both adapters registered', () => {
    expect(registry).toBeDefined();
    expect(ctx.app.get(TelebirrAdapter)).toBeInstanceOf(TelebirrAdapter);
    expect(ctx.app.get(TelebirrWebhookAdapter)).toBeInstanceOf(TelebirrWebhookAdapter);
  });

  it('routes gateway methods to the mock provider, since Telebirr is unavailable', () => {
    expect(registry.availableKeys()).toEqual(['mock']);
    for (const method of [
      PaymentMethod.TELEBIRR,
      PaymentMethod.CARD,
      PaymentMethod.BANK_TRANSFER,
      PaymentMethod.CROSS_BORDER,
    ]) {
      expect(registry.forMethod(method).key).toBe('mock');
    }
  });

  it.each([PaymentMethod.COD, PaymentMethod.WALLET])(
    'refuses %s cleanly — no gateway authorizes it',
    (method) => {
      expect(() => registry.forMethod(method)).toThrow();
    },
  );

  it('refuses to resolve Telebirr by key while its integration is unavailable', () => {
    expect(() => registry.forKey('telebirr')).toThrow();
    try {
      registry.forKey('telebirr');
    } catch (error) {
      expect((error as { code: string }).code).toBe(ErrorCode.DEPENDENCY_UNAVAILABLE);
    }
  });

  it('does not register a Telebirr webhook adapter while its callback contract is missing', () => {
    // A Telebirr callback is refused as an unintegrated provider — the truthful answer — rather
    // than accepted and failed on signature, which would misreport a gap as a security event.
    expect(webhookRegistry.forProvider('telebirr')).toBeNull();
    expect(webhookRegistry.providers()).toEqual(['mock']);
  });

  // -------------------------------------------------------------------------------------------
  // The payment module keeps working end to end through the registry
  // -------------------------------------------------------------------------------------------

  it('authorizes, captures and records the resolving gateway on the payment', async () => {
    const seed = await seedOrder();

    const authorized = await authorize.execute({
      customerUserId: seed.customerUserId,
      orderId: seed.orderId,
      method: PaymentMethod.TELEBIRR,
      idempotencyKey: `pay-${randomUUID()}`,
    });

    expect(authorized.status).toBe(PaymentStatus.AUTHORIZED);
    expect(authorized.provider).toBe('mock');

    // Capture resolves the gateway from the recorded key, not by re-resolving the method.
    const captured = await capture.execute({ paymentId: authorized.paymentId });
    expect(captured.status).toBe(PaymentStatus.CAPTURED);

    const txn = await ctx.prisma.ledgerTransaction.findUniqueOrThrow({
      where: { reference: `CAPTURE-${authorized.paymentId}` },
      include: { entries: true },
    });
    expect(txn.entries).toHaveLength(3);
  });

  it('refuses to capture a payment whose recorded gateway is unavailable', async () => {
    const seed = await seedOrder();
    const authorized = await authorize.execute({
      customerUserId: seed.customerUserId,
      orderId: seed.orderId,
      method: PaymentMethod.TELEBIRR,
      idempotencyKey: `pay-${randomUUID()}`,
    });
    // Simulate a payment that was authorized through Telebirr before it went unavailable.
    await ctx.prisma.payment.update({
      where: { id: authorized.paymentId },
      data: { provider: 'telebirr' },
    });

    await expect(capture.execute({ paymentId: authorized.paymentId })).rejects.toMatchObject({
      code: ErrorCode.DEPENDENCY_UNAVAILABLE,
    });

    // Nothing was captured through a substitute gateway.
    const payment = await ctx.prisma.payment.findUniqueOrThrow({
      where: { id: authorized.paymentId },
    });
    expect(payment.status).toBe('AUTHORIZED');
    expect(await ctx.prisma.ledgerTransaction.count()).toBe(0);
  });

  // -------------------------------------------------------------------------------------------
  // Webhook regression: provider-specific syntax stays isolated (§15)
  // -------------------------------------------------------------------------------------------

  it('a provider callback drives the same business result through the provider-agnostic command', async () => {
    const seed = await seedOrder();
    const authorized = await authorize.execute({
      customerUserId: seed.customerUserId,
      orderId: seed.orderId,
      method: PaymentMethod.TELEBIRR,
      // A returnUrl makes the mock answer PENDING, leaving the payment INITIATED for a callback.
      returnUrl: 'https://app.example/return',
      idempotencyKey: `pay-${randomUUID()}`,
    });
    expect(authorized.status).toBe(PaymentStatus.INITIATED);

    const eventId = `evt-${randomUUID()}`;
    const result = await processWebhook.execute(
      signed({ id: eventId, type: 'payment.authorized', paymentId: authorized.paymentId }),
    );

    expect(result.outcome).toBe(WebhookOutcome.Advanced);
    const payment = await ctx.prisma.payment.findUniqueOrThrow({
      where: { id: authorized.paymentId },
    });
    expect(payment.status).toBe('AUTHORIZED');
    expect(
      await ctx.prisma.outbox.count({
        where: { aggregateId: authorized.paymentId, eventType: 'payment.authorized' },
      }),
    ).toBe(1);

    // Duplicate delivery stays safe regardless of which adapter normalized it.
    const replay = await processWebhook.execute(
      signed({ id: eventId, type: 'payment.authorized', paymentId: authorized.paymentId }),
    );
    expect(replay.outcome).toBe(WebhookOutcome.Duplicate);
    expect(await ctx.prisma.providerWebhook.count({ where: { eventId } })).toBe(1);
    expect(
      await ctx.prisma.outbox.count({
        where: { aggregateId: authorized.paymentId, eventType: 'payment.authorized' },
      }),
    ).toBe(1);
  });

  it('refuses a Telebirr-addressed callback as an unintegrated provider', async () => {
    await expect(
      processWebhook.execute({
        provider: 'telebirr',
        rawBody: '{"id":"evt-1"}',
        headers: {},
      }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });

    expect(await ctx.prisma.providerWebhook.count()).toBe(0);
  });

  // -------------------------------------------------------------------------------------------
  // Reconciliation regression (§16)
  // -------------------------------------------------------------------------------------------

  it('reports a stuck payment as unresolvable while no provider status adapter exists', async () => {
    const seed = await seedOrder();
    const authorized = await authorize.execute({
      customerUserId: seed.customerUserId,
      orderId: seed.orderId,
      method: PaymentMethod.TELEBIRR,
      returnUrl: 'https://app.example/return',
      idempotencyKey: `pay-${randomUUID()}`,
    });
    await ctx.prisma.payment.update({
      where: { id: authorized.paymentId },
      data: { updatedAt: new Date(Date.now() - 60 * 60_000) },
    });

    const sweep = await reconciliation.sweep({ olderThanMinutes: 15 });

    const candidate = sweep.candidates.find((c) => c.paymentId === authorized.paymentId);
    expect(candidate).toBeDefined();
    expect(candidate).toMatchObject({
      status: PaymentStatus.INITIATED,
      // No IProviderStatusPort adapter is bound: Telebirr publishes no documented status endpoint
      // in this repository, so nothing can resolve this automatically yet.
      providerLookupAvailable: false,
    });

    await expect(reconciliation.compare(authorized.paymentId)).resolves.toMatchObject({
      lookupAvailable: false,
      mismatch: false,
    });
  });
});
