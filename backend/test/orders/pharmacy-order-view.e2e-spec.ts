import request from 'supertest';
import { auth, body, errorOf } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { placeOrder, PlacedOrder } from './support';

/**
 * Work 107: the pharmacy portal's order read. `GET /pharmacy/orders` items keep every earlier
 * fulfilment field and gain the order header and lines; `GET /pharmacy/orders/:fulfillmentId` reads
 * one, scoped to the caller's pharmacies, with no customer contact data.
 */
describe('Pharmacy order view (Work 107, e2e)', () => {
  let ctx: TestContext;
  let placed: PlacedOrder;
  let other: PlacedOrder;

  beforeAll(async () => {
    ctx = await createTestApp();
    await ctx.reset();
    placed = await placeOrder(ctx, { quantity: 2 });
    other = await placeOrder(ctx);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  const asPharmacy = (p: PlacedOrder) => ({
    get: (path: string) => request(ctx.server).get(path).set(...auth(p.pharmacy.accessToken)),
  });

  it('the list carries the order header and the lines, and keeps the earlier fulfilment fields', async () => {
    const page = body(await asPharmacy(placed).get('/pharmacy/orders').expect(200)) as { items: Array<Record<string, unknown>>; total: number };
    expect(page.total).toBe(1);
    const item = page.items[0] as {
      id: string;
      orderId: string;
      status: string;
      deliveryJobId: string | null;
      order: { orderNumber: string; status: string; isCod: boolean; grandTotal: number; currency: string };
      lines: Array<{ catalogProductId: string; quantity: number; unitPrice: number; lineTotal: number; requiresRx: boolean }>;
      requiresRx: boolean;
    };
    expect(item).toMatchObject({ id: placed.fulfillmentId, orderId: placed.orderId, status: 'PENDING', deliveryJobId: null, requiresRx: false });
    const order = await ctx.prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } });
    expect(item.order).toMatchObject({ orderNumber: order.orderNumber, status: order.status, isCod: order.isCod, grandTotal: order.grandTotal, currency: 'ETB' });
    expect(item.lines).toHaveLength(1);
    expect(item.lines[0]).toMatchObject({ catalogProductId: placed.catalogProductId, quantity: 2, requiresRx: false });
    expect(item.lines[0].lineTotal).toBe(item.lines[0].unitPrice * 2);
  });

  it('reads one fulfilment, with no customer contact data', async () => {
    const one = body(await asPharmacy(placed).get(`/pharmacy/orders/${placed.fulfillmentId}`).expect(200)) as Record<string, unknown>;
    expect(one).toMatchObject({ id: placed.fulfillmentId, orderId: placed.orderId });
    const text = JSON.stringify(one);
    for (const field of ['customerUserId', 'recipientName', 'recipientPhone', 'addressLine', 'email', 'phone']) {
      expect(text).not.toContain(`"${field}"`);
    }
  });

  it("another pharmacy's fulfilment reads as not found", async () => {
    const res = await asPharmacy(placed).get(`/pharmacy/orders/${other.fulfillmentId}`).expect(404);
    expect(errorOf(res).code).toBe('NOT_FOUND');
    await asPharmacy(placed).get('/pharmacy/orders/00000000-0000-4000-8000-000000000000').expect(404);
  });

  it('follows the fulfilment through accept, prepare and ready', async () => {
    for (const action of ['accept', 'prepare', 'ready']) {
      await request(ctx.server).post(`/pharmacy/orders/${placed.fulfillmentId}/${action}`).set(...auth(placed.pharmacy.accessToken)).expect(200);
    }
    const one = body(await asPharmacy(placed).get(`/pharmacy/orders/${placed.fulfillmentId}`).expect(200)) as { status: string; readyAt: string | null; order: { status: string } };
    expect(one.status).toBe('READY');
    expect(one.readyAt).not.toBeNull();
    expect(one.order.status).toBe('READY');
  });

  it('a customer cannot read the pharmacy route', async () => {
    await request(ctx.server).get(`/pharmacy/orders/${placed.fulfillmentId}`).set(...auth(placed.customer.accessToken)).expect(403);
  });
});
