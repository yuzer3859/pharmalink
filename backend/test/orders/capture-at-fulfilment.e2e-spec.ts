import { randomUUID } from 'crypto';
import request from 'supertest';
import { PaymentCaptureReconciler } from '../../src/modules/orders/infrastructure/scheduling/payment-capture.reconciler';
import { auth, body } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { readyToCheckout, ReadyToCheckout } from './support';

/**
 * Work 96: capture at fulfilment (module-07 §11.3). A prepaid order's payment is captured when the
 * pharmacy marks it ready, through the order's own `order.ready` event, and the capture
 * reconciler retries one that did not happen. Covers Phase 1 audit gap G2.
 */
describe('Orders — capture at fulfilment (Work 96, e2e)', () => {
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

  async function paidOrder(prepaid: boolean): Promise<{ ready: ReadyToCheckout; orderId: string; fulfillmentId: string; paymentId: string | null }> {
    const ready = await readyToCheckout(ctx);
    const data = body(
      await request(ctx.server)
        .post('/checkout')
        .set(...auth(ready.user.accessToken))
        .send({ addressId: ready.addressId, idempotencyKey: randomUUID(), ...(prepaid ? { payment: { method: 'TELEBIRR' } } : {}) })
        .expect(201),
    );
    const orderId = data.orderId as string;
    const fulfillment = await ctx.prisma.fulfillment.findFirstOrThrow({ where: { orderId } });
    return { ready, orderId, fulfillmentId: fulfillment.id, paymentId: (data.payment as { paymentId: string } | null)?.paymentId ?? null };
  }

  async function markReady(ready: ReadyToCheckout, fulfillmentId: string): Promise<void> {
    for (const action of ['accept', 'prepare', 'ready']) {
      await request(ctx.server).post(`/pharmacy/orders/${fulfillmentId}/${action}`).set(...auth(ready.pharmacy.accessToken)).expect(200);
    }
  }

  const captureTx = (paymentId: string) => ctx.prisma.ledgerTransaction.findMany({ where: { reference: `CAPTURE-${paymentId}` } });

  it('captures the payment when the order becomes ready, posts CAPTURE once, and records it on the order', async () => {
    const { ready, orderId, fulfillmentId, paymentId } = await paidOrder(true);
    await ctx.drainOutbox();
    expect((await ctx.prisma.payment.findUniqueOrThrow({ where: { id: paymentId! } })).status).toBe('AUTHORIZED');

    await markReady(ready, fulfillmentId);
    await ctx.drainOutbox();

    const payment = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: paymentId! } });
    expect(payment.status).toBe('CAPTURED');
    expect(payment.capturedAt).not.toBeNull();
    expect(await captureTx(paymentId!)).toHaveLength(1);
    expect((await ctx.prisma.order.findUniqueOrThrow({ where: { id: orderId } })).paymentCapturedAt).not.toBeNull();

    // Nothing left for the reconciler, and a second pass changes nothing.
    expect(await ctx.app.get(PaymentCaptureReconciler).run()).toEqual({ examined: 0, captured: 0, alreadyCaptured: 0, failures: 0 });
    expect(await captureTx(paymentId!)).toHaveLength(1);
  });

  it('the reconciler captures a ready order whose capture never ran, exactly once', async () => {
    const { ready, orderId, fulfillmentId, paymentId } = await paidOrder(true);
    await markReady(ready, fulfillmentId);
    // `order.ready` not delivered (the relay never ran): only the reconciler can capture it.
    await ctx.prisma.outbox.deleteMany({ where: { eventType: 'order.ready', aggregateId: orderId } });

    const reconciler = ctx.app.get(PaymentCaptureReconciler);
    expect(await reconciler.run()).toEqual({ examined: 1, captured: 1, alreadyCaptured: 0, failures: 0 });
    expect(await reconciler.run()).toEqual({ examined: 0, captured: 0, alreadyCaptured: 0, failures: 0 });
    expect((await ctx.prisma.payment.findUniqueOrThrow({ where: { id: paymentId! } })).status).toBe('CAPTURED');
    expect(await captureTx(paymentId!)).toHaveLength(1);
  });

  it('does not capture before the order is ready', async () => {
    const { paymentId } = await paidOrder(true);
    expect(await ctx.app.get(PaymentCaptureReconciler).run()).toMatchObject({ examined: 0 });
    expect((await ctx.prisma.payment.findUniqueOrThrow({ where: { id: paymentId! } })).status).toBe('AUTHORIZED');
  });

  it('a cash-on-delivery order has nothing to capture', async () => {
    const { ready, orderId, fulfillmentId } = await paidOrder(false);
    await markReady(ready, fulfillmentId);
    await ctx.drainOutbox();
    expect(await ctx.prisma.payment.count()).toBe(0);
    expect((await ctx.prisma.order.findUniqueOrThrow({ where: { id: orderId } })).paymentCapturedAt).toBeNull();
    expect(await ctx.app.get(PaymentCaptureReconciler).run()).toMatchObject({ examined: 0 });
  });
});
