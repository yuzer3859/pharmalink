import { randomUUID } from 'crypto';
import request from 'supertest';
import { PrepaidPaymentService } from '../../src/modules/orders/application/services/prepaid-payment.service';
import { UnpaidOrderReconciler } from '../../src/modules/orders/infrastructure/scheduling/unpaid-order.reconciler';
import { PaymentOutcomeHandler } from '../../src/modules/orders/interface/events/payment-outcome.handler';
import { auth, body } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { readyToCheckout, ReadyToCheckout } from './support';

/**
 * Work 95: the prepaid checkout saga (module-06 §6 steps 7–8), through the real HTTP surface and
 * the shipped test gateway (`MockPaymentProvider`; `test-decline` declines, a `returnUrl` makes it
 * a redirect). Covers the roadmap's Phase 1 criterion "saga compensation: a payment failure
 * releases the stock reservation".
 */
describe('Orders — prepaid checkout saga (Work 95, e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  function checkout(ready: ReadyToCheckout, payment?: Record<string, unknown>, idempotencyKey = randomUUID()) {
    return request(ctx.server)
      .post('/checkout')
      .set(...auth(ready.user.accessToken))
      .send({ addressId: ready.addressId, idempotencyKey, ...(payment ? { payment } : {}) });
  }

  const reservationsOf = async (orderId: string) => {
    const lines = await ctx.prisma.orderLine.findMany({ where: { orderId } });
    return ctx.prisma.stockReservation.findMany({
      where: { id: { in: lines.map((l) => l.reservationId).filter((id): id is string => id !== null) } },
    });
  };

  const pharmacyOrderIds = async (ready: ReadyToCheckout) =>
    (body(await request(ctx.server).get('/pharmacy/orders').set(...auth(ready.pharmacy.accessToken)).expect(200)).items as Array<{ orderId: string }>).map(
      (f) => f.orderId,
    );

  it('authorized: the order is PAID, records its payment, confirms its stock and tells the pharmacy', async () => {
    const ready = await readyToCheckout(ctx);
    const data = body(await checkout(ready, { method: 'TELEBIRR', token: 'tok-ok' }).expect(201));

    expect(data).toMatchObject({ status: 'PAID', isCod: false, replay: false });
    const payment = data.payment as { paymentId: string; status: string; providerRedirect: string | null };
    expect(payment).toEqual({ paymentId: expect.any(String), status: 'AUTHORIZED', providerRedirect: null });

    const order = await ctx.prisma.order.findUniqueOrThrow({ where: { id: data.orderId as string } });
    expect(order).toMatchObject({ status: 'PAID', isCod: false, paymentId: payment.paymentId });
    expect((await ctx.prisma.payment.findUniqueOrThrow({ where: { id: payment.paymentId } })).status).toBe('AUTHORIZED');
    expect((await reservationsOf(order.id)).map((r) => r.status)).toEqual(['CONFIRMED']);

    const history = await ctx.prisma.orderStatusHistory.findMany({ where: { orderId: order.id }, orderBy: { createdAt: 'asc' } });
    expect(history.map((h) => [h.toStatus, h.event])).toEqual([
      ['PENDING_PAYMENT', 'CHECKOUT_SUBMITTED'],
      ['PAID', 'PAYMENT_AUTHORIZED'],
    ]);
    const paid = await ctx.prisma.outbox.findMany({ where: { eventType: 'order.paid', aggregateId: order.id } });
    expect(paid).toHaveLength(1);
    expect((paid[0].payload as { payload: unknown }).payload).toEqual({ orderId: order.id, paymentId: payment.paymentId });
    expect(await ctx.prisma.auditLog.count({ where: { action: 'ORDER_PAID', resourceId: order.id } })).toBe(1);
    expect(await pharmacyOrderIds(ready)).toEqual([order.id]);
  });

  it('declined: the saga compensates — order CANCELLED, stock released, the decline returned with the order id', async () => {
    const ready = await readyToCheckout(ctx);
    const response = await checkout(ready, { method: 'CARD', token: 'test-decline' }).expect(402);

    expect(response.body.error.code).toBe('PAYMENT_AUTH_FAILED');
    const orderId = response.body.error.details.orderId as string;
    const order = await ctx.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order).toMatchObject({ status: 'CANCELLED', cancelReason: 'payment-failed', paymentId: null });
    expect((await reservationsOf(orderId)).map((r) => r.status)).toEqual(['RELEASED']);
    expect((await ctx.prisma.payment.findFirstOrThrow({ where: { orderId } })).status).toBe('FAILED');
    expect(await ctx.prisma.outbox.count({ where: { eventType: 'order.paid', aggregateId: orderId } })).toBe(0);
    expect(await pharmacyOrderIds(ready)).toEqual([]);
  });

  it('redirect: the order waits unseen by the pharmacy until the webhook outcome arrives, applied once', async () => {
    const ready = await readyToCheckout(ctx);
    const data = body(await checkout(ready, { method: 'TELEBIRR', returnUrl: 'https://app.test/paid' }).expect(201));
    expect(data.status).toBe('PENDING_PAYMENT');
    const payment = data.payment as { paymentId: string; status: string; providerRedirect: string };
    expect(payment.status).toBe('INITIATED');
    expect(payment.providerRedirect).toContain('https://app.test/paid');
    const orderId = data.orderId as string;
    expect((await reservationsOf(orderId)).map((r) => r.status)).toEqual(['HELD']);
    expect(await pharmacyOrderIds(ready)).toEqual([]);

    // What the gateway's webhook does in Module 07, then the event it emits.
    await ctx.prisma.payment.update({ where: { id: payment.paymentId }, data: { status: 'AUTHORIZED', authorizedAt: new Date() } });
    const handler = ctx.app.get(PaymentOutcomeHandler);
    const event = { id: randomUUID(), payload: { orderId, paymentId: payment.paymentId } } as never;
    await handler.authorized(event);
    await handler.authorized(event);

    const order = await ctx.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order).toMatchObject({ status: 'PAID', paymentId: payment.paymentId });
    expect((await reservationsOf(orderId)).map((r) => r.status)).toEqual(['CONFIRMED']);
    expect(await ctx.prisma.orderStatusHistory.count({ where: { orderId, toStatus: 'PAID' } })).toBe(1);
    expect(await pharmacyOrderIds(ready)).toEqual([orderId]);
  });

  it('redirect then a failed payment: the event compensates exactly as an in-request decline does', async () => {
    const ready = await readyToCheckout(ctx);
    const data = body(await checkout(ready, { method: 'TELEBIRR', returnUrl: 'https://app.test/paid' }).expect(201));
    const orderId = data.orderId as string;

    await ctx.app.get(PaymentOutcomeHandler).failed({ id: randomUUID(), payload: { orderId, paymentId: 'p', reason: 'x' } } as never);

    expect(await ctx.prisma.order.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({ status: 'CANCELLED', cancelReason: 'payment-failed' });
    expect((await reservationsOf(orderId)).map((r) => r.status)).toEqual(['RELEASED']);
  });

  it('authorized after the stock hold expired: the authorization is voided and the order cancelled', async () => {
    const ready = await readyToCheckout(ctx);
    const data = body(await checkout(ready, { method: 'TELEBIRR', returnUrl: 'https://app.test/paid' }).expect(201));
    const orderId = data.orderId as string;
    const paymentId = (data.payment as { paymentId: string }).paymentId;
    // What Module 04's TTL sweeper does to a hold the customer took too long to pay for.
    await ctx.prisma.stockReservation.updateMany({ where: { id: { in: (await reservationsOf(orderId)).map((r) => r.id) } }, data: { status: 'EXPIRED' } });
    await ctx.prisma.payment.update({ where: { id: paymentId }, data: { status: 'AUTHORIZED', authorizedAt: new Date() } });

    expect(await ctx.app.get(PrepaidPaymentService).onAuthorized({ orderId, paymentId })).toBe('CANCELLED');

    expect(await ctx.prisma.order.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'reservation-expired-before-payment',
      paymentId: null,
    });
    expect((await ctx.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe('VOIDED');
  });

  it('never paid: the reconciler cancels the order once the payment window has passed, and only then', async () => {
    const ready = await readyToCheckout(ctx);
    const data = body(await checkout(ready, { method: 'TELEBIRR', returnUrl: 'https://app.test/paid' }).expect(201));
    const orderId = data.orderId as string;
    const reconciler = ctx.app.get(UnpaidOrderReconciler);

    expect(await reconciler.run(new Date())).toMatchObject({ examined: 0 });
    expect(await reconciler.run(new Date(Date.now() + 21 * 60_000))).toEqual({ examined: 1, cancelled: 1, skipped: 0, failures: 0 });

    expect(await ctx.prisma.order.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'payment-not-completed-in-time',
    });
    expect((await reservationsOf(orderId)).map((r) => r.status)).toEqual(['RELEASED']);
  });

  it('a customer cancelling a paid prepaid order releases the authorization with the stock', async () => {
    const ready = await readyToCheckout(ctx);
    const data = body(await checkout(ready, { method: 'TELEBIRR' }).expect(201));
    const paymentId = (data.payment as { paymentId: string }).paymentId;

    await request(ctx.server)
      .post(`/orders/${data.orderId as string}/cancel`)
      .set(...auth(ready.user.accessToken))
      .send({ reason: 'changed my mind' })
      .expect((res) => expect([200, 201]).toContain(res.status));

    expect((await ctx.prisma.order.findUniqueOrThrow({ where: { id: data.orderId as string } })).status).toBe('CANCELLED');
    expect((await ctx.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe('VOIDED');
    expect((await reservationsOf(data.orderId as string)).map((r) => r.status)).toEqual(['RELEASED']);
  });

  it('a replayed prepaid checkout returns the same order and payment, never a second one', async () => {
    const ready = await readyToCheckout(ctx);
    const key = randomUUID();
    const first = body(await checkout(ready, { method: 'TELEBIRR' }, key).expect(201));
    const second = body(await checkout(ready, { method: 'TELEBIRR' }, key).expect(201));

    expect(second).toMatchObject({ orderId: first.orderId, status: 'PAID', replay: true });
    expect(await ctx.prisma.payment.count({ where: { orderId: first.orderId as string } })).toBe(1);
  });

  it('without a payment, checkout is cash on delivery exactly as before', async () => {
    const ready = await readyToCheckout(ctx);
    const data = body(await checkout(ready).expect(201));
    expect(data).toMatchObject({ status: 'PAID', isCod: true, payment: null });
    expect(await ctx.prisma.payment.count()).toBe(0);
  });

  it.each([{ method: 'COD' }, { method: 'WALLET' }, { method: 'TELEBIRR', returnUrl: 'javascript:alert(1)' }, { method: 'CARD', pan: '4111111111111111' }])(
    'refuses a payment body that is not a gateway prepayment: %p',
    async (payment) => {
      const ready = await readyToCheckout(ctx);
      await checkout(ready, payment).expect(400);
      expect(await ctx.prisma.order.count()).toBe(0);
    },
  );
});
