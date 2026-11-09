import request from 'supertest';
import { auth, body } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { createActivatedPharmacy } from '../pharmacy-inventory/support';
import { placeOrder, PlacedOrder } from './support';

interface Dashboard {
  orders: {
    byStatus: Array<{ status: string; count: number }>;
    newLast24h: number;
    deliveredRevenue30d: number;
    currency: string;
    last7Days: Array<{ date: string; orders: number; deliveredRevenue: number }>;
  };
  stock: { listings: number; enabledListings: number; outOfStock: number; lowStock: number; batchesExpiringSoon: number; batchesExpired: number };
}

/**
 * Work 115: `GET /pharmacy/dashboard`, the caller's pharmacies' orders, revenue and stock health,
 * scoped like the pharmacy order list.
 */
describe('Pharmacy dashboard (Work 115, e2e)', () => {
  let ctx: TestContext;
  let placed: PlacedOrder;

  beforeAll(async () => {
    ctx = await createTestApp();
    await ctx.reset();
    placed = await placeOrder(ctx, { quantity: 2, stock: 5 });
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  const dashboard = async (token: string) =>
    body(await request(ctx.server).get('/pharmacy/dashboard').set(...auth(token)).expect(200)) as unknown as Dashboard;

  it('counts the pharmacy’s orders by status, the last 24 hours and the last 7 days', async () => {
    const d = await dashboard(placed.pharmacy.accessToken);
    expect(d.orders.byStatus).toEqual([{ status: 'PENDING', count: 1 }]);
    expect(d.orders.newLast24h).toBe(1);
    expect(d.orders.last7Days).toHaveLength(7);
    expect(d.orders.last7Days[6]).toMatchObject({ date: new Date().toISOString().slice(0, 10), orders: 1 });
    expect(d.orders.deliveredRevenue30d).toBe(0);
  });

  it('follows the order to READY, and counts delivered revenue', async () => {
    for (const action of ['accept', 'prepare', 'ready']) {
      await request(ctx.server).post(`/pharmacy/orders/${placed.fulfillmentId}/${action}`).set(...auth(placed.pharmacy.accessToken)).expect(200);
    }
    expect((await dashboard(placed.pharmacy.accessToken)).orders.byStatus).toEqual([{ status: 'READY', count: 1 }]);

    // Delivery itself is Module 08's walk; here the fulfilment is marked delivered to read the revenue.
    await ctx.prisma.fulfillment.update({ where: { id: placed.fulfillmentId }, data: { status: 'DELIVERED' } });
    const lines = await ctx.prisma.orderLine.findMany({ where: { fulfillmentId: placed.fulfillmentId } });
    const expected = lines.reduce((sum, l) => sum + l.lineTotal, 0);
    const d = await dashboard(placed.pharmacy.accessToken);
    expect(expected).toBeGreaterThan(0);
    expect(d.orders.deliveredRevenue30d).toBe(expected);
    expect(d.orders.last7Days[6].deliveredRevenue).toBe(expected);
  });

  it('reports stock health: low stock, and batches expiring soon or expired', async () => {
    // 5 stocked, 2 reserved or dispatched by the order: below the low-stock threshold of 10.
    let d = await dashboard(placed.pharmacy.accessToken);
    expect(d.stock).toMatchObject({ listings: 1, enabledListings: 1, outOfStock: 0, lowStock: 1, batchesExpired: 0 });

    const listing = await ctx.prisma.inventoryListing.findFirstOrThrow({ where: { pharmacyId: placed.pharmacy.pharmacyId } });
    const batch = await ctx.prisma.stockBatch.findFirstOrThrow({ where: { listingId: listing.id } });
    await ctx.prisma.stockBatch.update({ where: { id: batch.id }, data: { expiryDate: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000) } });
    d = await dashboard(placed.pharmacy.accessToken);
    expect(d.stock.batchesExpiringSoon).toBe(1);

    await ctx.prisma.stockBatch.update({ where: { id: batch.id }, data: { expiryDate: new Date(Date.now() - 24 * 60 * 60 * 1000) } });
    d = await dashboard(placed.pharmacy.accessToken);
    expect(d.stock).toMatchObject({ batchesExpiringSoon: 0, batchesExpired: 1 });
  });

  it('another pharmacy sees only its own (nothing), and a customer is refused', async () => {
    const other = await createActivatedPharmacy(ctx);
    const d = await dashboard(other.accessToken);
    expect(d.orders.byStatus).toEqual([]);
    expect(d.orders.newLast24h).toBe(0);
    expect(d.stock.listings).toBe(0);
    await request(ctx.server).get('/pharmacy/dashboard').set(...auth(placed.customer.accessToken)).expect(403);
  });
});
