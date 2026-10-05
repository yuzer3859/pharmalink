import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
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
import { createDomainEvent, DomainEvent } from '../../src/shared/events/domain-event';
import { EventBusService } from '../../src/shared/events/event-bus.service';
import { auth, body, createUserWithRole, RegisteredUser, Tokens } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

type User = RegisteredUser & Tokens;

interface Item {
  id: string;
  type: string | null;
  category: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  read: boolean;
}

const PAYMENT_TYPES = ['PAYMENT_CAPTURED', 'PAYMENT_FAILED', 'PAYMENT_REFUNDED'];
/** A decline as a misbehaving gateway might phrase it: a card number and a credential in it. */
const DIRTY_DECLINE = 'Declined for card 4111 1111 1111 1111 api_key=sk_live_SECRETVALUE';

/**
 * The shipped `MockPaymentProvider`, unmodified, except that a test may script the next
 * authorization's outcome — the mock never declines on its own, by design, and its own doc comment
 * prescribes exactly this wrapper for the failure branch.
 */
class ScriptedGateway implements IPaymentProviderPort {
  private readonly shipped = new MockPaymentProvider();
  readonly key = 'mock';
  nextAuthorize: ProviderAuthorizationResult | null = null;

  supports(method: PaymentMethod): boolean {
    return this.shipped.supports(method);
  }
  authorize(req: ProviderAuthorizationRequest): Promise<ProviderAuthorizationResult> {
    const scripted = this.nextAuthorize;
    this.nextAuthorize = null;
    return scripted ? Promise.resolve(scripted) : this.shipped.authorize(req);
  }
  capture(req: ProviderPaymentOperationRequest): Promise<ProviderCaptureResult> {
    return this.shipped.capture(req);
  }
  voidAuthorization(req: ProviderPaymentOperationRequest): Promise<ProviderVoidResult> {
    return this.shipped.voidAuthorization(req);
  }
  refund(req: ProviderRefundRequest): Promise<ProviderRefundResult> {
    return this.shipped.refund(req);
  }
}

/**
 * Module 13 Work 03 against real PostgreSQL and the real HTTP stack.
 *
 * Every payment event is caused by Module 07's own routes — `POST /payments/authorize` (a scripted
 * decline for the failure), `POST /payments/:id/capture`, `POST /payments/:id/refunds` — and
 * published by the real outbox relay; the recipients are resolved by the real Module 06 and
 * Module 07 ports. The order rows are seeded directly, as Module 07's own payment suites do:
 * Module 06's Slice-1 checkout is COD and never reaches a card payment.
 */
describe('Payment notifications (e2e)', () => {
  let ctx: TestContext;
  let gateway: ScriptedGateway;
  let finance: User;
  let customerA: User;
  let customerB: User;

  beforeAll(async () => {
    gateway = new ScriptedGateway();
    ctx = await createTestApp([{ provide: PAYMENT_PROVIDER_PORT, useValue: gateway }]);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
    gateway.nextAuthorize = null;
    finance = await createUserWithRole(ctx, 'FINANCE_OFFICER');
    customerA = await createUserWithRole(ctx, 'CUSTOMER');
    customerB = await createUserWithRole(ctx, 'CUSTOMER');
    // Registration/setup events first, so each test drains only what it causes.
    await ctx.drainOutbox();
  });

  // -------------------------------------------------------------------------------------------
  // Helpers — Module 07's own routes
  // -------------------------------------------------------------------------------------------

  async function seedOrder(customer: User, grandTotal = 10_000): Promise<string> {
    const order = await ctx.prisma.order.create({
      data: {
        orderNumber: `ORD-${randomUUID()}`,
        customerUserId: customer.userId,
        status: 'PENDING_PAYMENT',
        subtotal: grandTotal - 1_000,
        deliveryFee: 0,
        platformFee: 1_000,
        discountTotal: 0,
        grandTotal,
        currency: 'ETB',
        idempotencyKey: `checkout-${randomUUID()}`,
        isCod: false,
      },
    });
    await ctx.prisma.fulfillment.create({
      data: { orderId: order.id, pharmacyId: `pharmacy-${randomUUID()}`, branchId: `branch-${randomUUID()}` },
    });
    return order.id;
  }

  const authorizeReq = (customer: User, orderId: string) =>
    request(ctx.server)
      .post('/payments/authorize')
      .set(...auth(customer.accessToken))
      .set('Idempotency-Key', `pay-${randomUUID()}`)
      .send({ orderId, method: 'TELEBIRR' });

  async function capturedPayment(customer: User): Promise<{ orderId: string; paymentId: string }> {
    const orderId = await seedOrder(customer);
    const paymentId = body(await authorizeReq(customer, orderId).expect(201)).paymentId as string;
    await request(ctx.server)
      .post(`/payments/${paymentId}/capture`)
      .set(...auth(finance.accessToken))
      .set('Idempotency-Key', `cap-${randomUUID()}`)
      .send({})
      .expect(200);
    return { orderId, paymentId };
  }

  async function refundPayment(paymentId: string, amount?: number) {
    await request(ctx.server)
      .post(`/payments/${paymentId}/refunds`)
      .set(...auth(finance.accessToken))
      .set('Idempotency-Key', `refund-${randomUUID()}`)
      .send({ reason: 'customer cancellation', destination: 'ORIGINAL', ...(amount ? { amount } : {}) })
      .expect(201);
  }

  const inbox = async (token: string, query: Record<string, unknown> = {}) =>
    (body(await request(ctx.server).get('/notifications').query(query).set(...auth(token)).expect(200)) as { items: Item[] })
      .items;
  const paymentItems = async (token: string) => (await inbox(token)).filter((i) => PAYMENT_TYPES.includes(i.type ?? ''));

  async function envelopeOf(eventType: string, paymentId: string): Promise<DomainEvent> {
    const row = await ctx.prisma.outbox.findFirstOrThrow({ where: { eventType, aggregateId: paymentId } });
    return row.payload as unknown as DomainEvent;
  }

  // ===========================================================================================
  // 1. Each event, caused through Module 07
  // ===========================================================================================

  describe('events', () => {
    it('payment.captured → customer A, once, resolved through the order; customer B gets nothing', async () => {
      const { orderId, paymentId } = await capturedPayment(customerA);
      await ctx.drainOutbox();

      expect(await paymentItems(customerA.accessToken)).toEqual([
        expect.objectContaining({
          type: 'PAYMENT_CAPTURED',
          category: 'TRANSACTIONAL',
          title: 'Payment completed',
          body: 'Your payment for your order has been completed.',
          data: { paymentId, orderId },
          read: false,
        }),
      ]);
      expect(await inbox(customerB.accessToken)).toEqual([]);

      const stored = await ctx.prisma.notification.findFirstOrThrow({ where: { templateCode: 'PAYMENT_CAPTURED' } });
      expect(stored).toMatchObject({ recipientUserId: customerA.userId, channel: 'IN_APP', status: 'SENT', eventType: 'payment.captured' });
      expect(stored.dedupeKey).toBe(`${(await envelopeOf('payment.captured', paymentId)).id}:${customerA.userId}`);
    });

    it('payment.failed → customer A, in Amharic, with only the sanitized reason, never the card or credential', async () => {
      await request(ctx.server).patch('/users/me').set(...auth(customerA.accessToken)).send({ preferredLanguage: 'am' }).expect(200);
      const orderId = await seedOrder(customerA);
      gateway.nextAuthorize = { outcome: 'FAILED', providerRef: 'gw-declined-raw-ref', failureReason: DIRTY_DECLINE };
      await authorizeReq(customerA, orderId).expect(402);
      await ctx.drainOutbox();

      const payment = await ctx.prisma.payment.findFirstOrThrow({ where: { orderId } });
      const [n] = await paymentItems(customerA.accessToken);
      expect(n).toMatchObject({
        type: 'PAYMENT_FAILED',
        title: 'ክፍያው አልተሳካም',
        body: 'ክፍያዎን ማጠናቀቅ አልተቻለም።',
        data: { paymentId: payment.id, orderId, reason: payment.failureReason },
      });
      expect(await inbox(customerB.accessToken)).toEqual([]);

      const stored = JSON.stringify(await ctx.prisma.notification.findFirstOrThrow({ where: { templateCode: 'PAYMENT_FAILED' } }));
      // Multi-character fragments only: a bare '4111' could occur by chance inside a random UUID.
      for (const forbidden of ['4111 1111', '1111 1111', 'sk_live', 'SECRETVALUE', 'gw-declined-raw-ref', 'providerRef', 'providerToken']) {
        expect({ forbidden, found: stored.includes(forbidden) }).toEqual({ forbidden, found: false });
      }
    });

    it('payment.refunded → customer A, resolved through the payment, with the refunded amount and currency', async () => {
      const { orderId, paymentId } = await capturedPayment(customerA);
      await refundPayment(paymentId, 2_550);
      await ctx.drainOutbox();

      const refunds = (await paymentItems(customerA.accessToken)).filter((i) => i.type === 'PAYMENT_REFUNDED');
      expect(refunds).toEqual([
        expect.objectContaining({
          title: 'Refund completed',
          body: 'A refund of 25.50 ETB has been completed for your payment.',
          data: { paymentId, orderId, amount: 2_550, currency: 'ETB' },
        }),
      ]);
      expect(await inbox(customerB.accessToken)).toEqual([]);
    });

    it('a captured or failed event for an unknown order, and a refund for an unknown payment, write nothing', async () => {
      const bus = ctx.app.get(EventBusService);
      const before = await ctx.prisma.notification.count();
      for (const [type, payload] of [
        ['payment.captured', { paymentId: randomUUID(), orderId: randomUUID(), fee: 100 }],
        ['payment.failed', { paymentId: randomUUID(), orderId: randomUUID(), reason: 'x' }],
        ['payment.refunded', { paymentId: randomUUID(), amount: 100 }],
      ] as const) {
        await bus.publish(createDomainEvent({ type, aggregateType: 'Payment', aggregateId: payload.paymentId, payload }));
      }
      expect(await ctx.prisma.notification.count()).toBe(before);
    });
  });

  // ===========================================================================================
  // 2. Idempotency, inbox, privacy, audit
  // ===========================================================================================

  describe('idempotency', () => {
    it.each(['payment.captured', 'payment.refunded'])('a redelivered or concurrently delivered %s writes one notification', async (eventType) => {
      const { paymentId } = await capturedPayment(customerA);
      if (eventType === 'payment.refunded') await refundPayment(paymentId);
      await ctx.drainOutbox();

      for (let i = 0; i < 2; i += 1) {
        await ctx.prisma.outbox.updateMany({ where: { eventType, aggregateId: paymentId }, data: { publishedAt: null } });
        await ctx.drainOutbox();
      }
      const event = await envelopeOf(eventType, paymentId);
      await Promise.all(Array.from({ length: 5 }, () => ctx.app.get(EventBusService).publish(event)));

      const code = eventType === 'payment.captured' ? 'PAYMENT_CAPTURED' : 'PAYMENT_REFUNDED';
      expect(await ctx.prisma.notification.count({ where: { templateCode: code } })).toBe(1);
    });
  });

  describe('inbox', () => {
    it('appears through GET /notifications and is marked READ through Work 01’s route, only by its owner', async () => {
      await capturedPayment(customerA);
      await ctx.drainOutbox();
      const [captured] = await paymentItems(customerA.accessToken);

      await request(ctx.server).post(`/notifications/${captured.id}/read`).set(...auth(customerB.accessToken)).send({}).expect(404);
      const read = body(
        await request(ctx.server).post(`/notifications/${captured.id}/read`).set(...auth(customerA.accessToken)).send({}).expect(200),
      );
      expect(read).toMatchObject({ id: captured.id, type: 'PAYMENT_CAPTURED', read: true });
      expect((await ctx.prisma.notification.findUniqueOrThrow({ where: { id: captured.id } })).status).toBe('READ');
    });

    it('stores and serves no provider token, provider reference, fee, method or ledger figure', async () => {
      const { paymentId } = await capturedPayment(customerA);
      await refundPayment(paymentId);
      await ctx.drainOutbox();
      const payment = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
      const stored = JSON.stringify(await ctx.prisma.notification.findMany({ where: { templateCode: { in: PAYMENT_TYPES } } }));
      const served = JSON.stringify(await paymentItems(customerA.accessToken));
      // `fee` is checked as a data key, not a substring: three hex letters can occur inside a UUID.
      const rows = await ctx.prisma.notification.findMany({ where: { templateCode: { in: PAYMENT_TYPES } } });
      for (const row of rows) expect(Object.keys(row.payload as object)).not.toContain('fee');
      const forbidden = ['providerToken', 'providerRef', 'TELEBIRR', 'method', 'ledger', 'idempotencyKey', customerA.phone];
      if (payment.providerRef) forbidden.push(payment.providerRef);
      if (payment.providerToken) forbidden.push(payment.providerToken);
      for (const f of forbidden) {
        expect({ f, stored: stored.includes(f), served: served.includes(f) }).toEqual({ f, stored: false, served: false });
      }
      expect(served).not.toContain(customerA.userId);
    });

    it('creating and reading payment notifications appends no audit entry of Module 13’s', async () => {
      const { paymentId } = await capturedPayment(customerA);
      await refundPayment(paymentId);
      const beforeDrain = await ctx.prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } });
      await ctx.drainOutbox();
      expect(await ctx.prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } })).toEqual(beforeDrain);

      const items = await paymentItems(customerA.accessToken);
      await request(ctx.server).get('/notifications/unread-count').set(...auth(customerA.accessToken)).expect(200);
      await request(ctx.server).post(`/notifications/${items[0].id}/read`).set(...auth(customerA.accessToken)).send({}).expect(200);
      await request(ctx.server).post('/notifications/read-all').set(...auth(customerA.accessToken)).send({}).expect(200);
      expect(await ctx.prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } })).toEqual(beforeDrain);
    });
  });

  // ===========================================================================================
  // 3. Boundaries
  // ===========================================================================================

  describe('boundaries', () => {
    const moduleRoot = join(__dirname, '..', '..', 'src', 'modules', 'notifications');
    const files = (): string[] => {
      const out: string[] = [];
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          if (statSync(full).isDirectory()) walk(full);
          else if (full.endsWith('.ts') && !full.endsWith('.spec.ts')) out.push(full);
        }
      };
      walk(moduleRoot);
      return out;
    };

    it('Module 13 never touches Module 07 persistence, repositories, entities, commands, queries or infrastructure', () => {
      for (const file of files()) {
        const source = readFileSync(file, 'utf8');
        for (const forbidden of [
          'prisma.payment',
          'prisma.refund',
          'prisma.ledger',
          'prisma.wallet',
          'PAYMENT_REPOSITORY',
          'REFUND_REPOSITORY',
          'payment/domain/entities',
          'payment/domain/repositories',
          'payment/domain/enums',
          'payment/infrastructure/',
          'payment/application/commands/',
          'payment/application/queries/',
          'payment/application/ports/outbound',
          'finance-oversight.port',
        ]) {
          expect({ file, forbidden, found: source.includes(forbidden) }).toEqual({ file, forbidden, found: false });
        }
      }
    });

    it('Module 13 reaches Module 07 only through the payment-recipient port, the event contract and PaymentModule', () => {
      const imports = new Set<string>();
      for (const file of files()) {
        for (const m of readFileSync(file, 'utf8').matchAll(/from '(?:\.\.\/)+(payment\/[^']*)'/g)) imports.add(m[1]);
      }
      expect([...imports].sort()).toEqual([
        'payment/application/ports/inbound/payment-recipient-read.port',
        'payment/domain/events',
        'payment/payment.module',
      ]);
    });
  });
});
