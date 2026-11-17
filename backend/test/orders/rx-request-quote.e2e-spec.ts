import request from 'supertest';
import { auth, body, errorOf } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { grantOrgRole } from '../pharmacy-inventory/support';
import { createCustomer, createCustomerAddress, createPricedProduct, createStockedPharmacy } from './support';
import { RxRequestExpirySweeper } from '../../src/modules/orders/infrastructure/scheduling/rx-request-expiry.sweeper';

const PDF = Buffer.from('%PDF-1.4\n% PharmaLink quoted prescription\n%%EOF\n');
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

/**
 * Work 135 (owner decision 2026-11-17): the accepting pharmacy quotes from its own stock; the
 * customer confirms the quote into an order at that pharmacy, with the prescription approved on
 * it; or declines it, or lets it lapse.
 */
describe('Quoting a prescription request and confirming it into an order (Work 135)', () => {
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

  const as = (token: string) => ({
    get: (path: string) => request(ctx.server).get(path).set(...auth(token)),
    post: (path: string, payload: object = {}) => request(ctx.server).post(path).set(...auth(token)).send(payload),
  });

  /** A prescription medicine stocked 10 at a pharmacy next to the customer, its pharmacist, and an accepted request. */
  async function accepted() {
    const productId = await createPricedProduct(ctx, { kind: 'RX', price: 2500 });
    const pharmacy = await createStockedPharmacy(ctx, productId, 10);
    const pharmacist = as((await grantOrgRole(ctx, 'PHARMACIST', pharmacy.organizationId)).accessToken);
    const pharmacistUser = await ctx.prisma.userRole.findFirstOrThrow({ where: { organizationId: pharmacy.organizationId, role: { key: 'PHARMACIST' } } });

    const customer = await createCustomer(ctx);
    const addressId = await createCustomerAddress(ctx, customer.accessToken);
    const c = as(customer.accessToken);
    const issued = body(await c.post('/prescriptions/uploads', { contentType: 'application/pdf', bytes: PDF.length }).expect(201));
    await request(ctx.server).put(new URL((issued.upload as { url: string }).url).pathname).set('Content-Type', 'application/pdf').send(PDF).expect(200);
    const prescriptionId = body(await c.post('/prescriptions', { fileRef: issued.fileRef, fileType: 'application/pdf' }).expect(201)).id as string;
    const requestId = body(await c.post('/rx-requests', { prescriptionId, addressId, prescriptionIssueDate: today() }).expect(201)).id as string;
    await pharmacist.post(`/pharmacy/rx-requests/${requestId}/accept`).expect(200);
    return { productId, pharmacy, pharmacist, pharmacistUserId: pharmacistUser.userId, customer, c, prescriptionId, requestId };
  }

  const quoteBody = (productId: string, over: object = {}) => ({
    lines: [{ catalogProductId: productId, quantity: 3 }],
    prescriptionIssueDate: today(),
    legibilityOk: true,
    validityOk: true,
    note: 'Generic brand',
    ...over,
  });

  it('the holding pharmacist quotes from its stock, priced as checkout prices it; the customer sees it and is told', async () => {
    const { productId, pharmacist, customer, c, requestId } = await accepted();
    const quotePath = `/pharmacy/rx-requests/${requestId}/quote`;

    await pharmacist.post(quotePath, quoteBody(productId, { legibilityOk: false })).expect(400);
    await pharmacist.post(quotePath, quoteBody(productId, { lines: [{ catalogProductId: productId, quantity: 20 }] })).expect(400);
    expect(errorOf(await pharmacist.post(quotePath, quoteBody(productId, { prescriptionIssueDate: daysAgo(15) })).expect(422)).code).toBe('PRESCRIPTION_TOO_OLD');
    // The customer cannot confirm before there is a quote.
    await c.post(`/rx-requests/${requestId}/confirm`).expect(409);

    const quoted = body(await pharmacist.post(quotePath, quoteBody(productId)).expect(200)) as { status: string; quote: Record<string, unknown> };
    expect(quoted.status).toBe('QUOTED');
    expect(quoted.quote).toMatchObject({ subtotal: 7500, paperRequired: false, note: 'Generic brand', lines: [expect.objectContaining({ quantity: 3, unitPrice: 2500, requiresRx: true })] });
    expect(quoted.quote.grandTotal).toBe((quoted.quote.subtotal as number) + (quoted.quote.deliveryFee as number) + (quoted.quote.platformFee as number));
    // A second quote is refused: it is no longer just accepted.
    await pharmacist.post(quotePath, quoteBody(productId)).expect(409);

    const mine = body(await c.get(`/rx-requests/${requestId}`).expect(200)) as { status: string; quote: Record<string, unknown>; quoteExpiresAt: string };
    expect(mine.status).toBe('QUOTED');
    expect(mine.quote.grandTotal).toBe(quoted.quote.grandTotal);
    expect(mine.quote).not.toHaveProperty('quotedByUserId');
    expect(mine.quoteExpiresAt).toEqual(expect.any(String));
    await ctx.drainOutbox();
    expect(await ctx.prisma.notification.count({ where: { recipientUserId: customer.userId, templateCode: 'RX_REQUEST_QUOTED' } })).toBe(1);
  });

  it('confirmed with cash on delivery, it becomes a paid order at that pharmacy with the prescription approved by the quoting pharmacist', async () => {
    const { productId, pharmacy, pharmacist, pharmacistUserId, c, prescriptionId, requestId } = await accepted();
    await pharmacist.post(`/pharmacy/rx-requests/${requestId}/quote`, quoteBody(productId, { paperRequired: true })).expect(200);

    const confirmed = body(await c.post(`/rx-requests/${requestId}/confirm`).expect(200)) as { orderId: string; request: Record<string, unknown> };
    expect(confirmed.request).toMatchObject({ status: 'CONFIRMED', orderId: confirmed.orderId });
    // Confirming again answers the same order.
    expect((body(await c.post(`/rx-requests/${requestId}/confirm`).expect(200)) as { orderId: string }).orderId).toBe(confirmed.orderId);

    const order = await ctx.prisma.order.findUniqueOrThrow({ where: { id: confirmed.orderId }, include: { lines: true, fulfillments: true } });
    expect(order).toMatchObject({ status: 'PAID', isCod: true, prescriptionId, rxReviewStatus: 'APPROVED', paperRxRequired: true, subtotal: 7500 });
    expect(order.fulfillments).toEqual([expect.objectContaining({ pharmacyId: pharmacy.pharmacyId })]);
    expect(order.lines).toEqual([expect.objectContaining({ catalogProductId: productId, quantity: 3, prescriptionLineId: expect.any(String) })]);
    expect(await ctx.prisma.prescription.findUniqueOrThrow({ where: { id: prescriptionId } })).toMatchObject({ status: 'APPROVED', verifiedByUserId: pharmacistUserId });
    expect((await ctx.prisma.inventoryListing.findFirstOrThrow({ where: { catalogProductId: productId } })).reserved).toBe(3);

    // The pharmacy accepts it; with the paper required, preparing waits for the paper (Work 136).
    const fulfillmentId = order.fulfillments[0].id;
    await pharmacist.post(`/pharmacy/orders/${fulfillmentId}/accept`).expect(200);
    await pharmacist.post(`/pharmacy/orders/${fulfillmentId}/prepare`).expect(400);
  });

  it('confirmed with a prepayment, the order is paid through the test gateway in the same call', async () => {
    const { productId, pharmacist, c, requestId } = await accepted();
    await pharmacist.post(`/pharmacy/rx-requests/${requestId}/quote`, quoteBody(productId)).expect(200);

    const confirmed = body(await c.post(`/rx-requests/${requestId}/confirm`, { payment: { method: 'TELEBIRR' } }).expect(200)) as { orderId: string };
    const order = await ctx.prisma.order.findUniqueOrThrow({ where: { id: confirmed.orderId } });
    expect(order).toMatchObject({ status: 'PAID', isCod: false, rxReviewStatus: 'APPROVED', paperRxRequired: false });
  });

  it('the customer can decline the quote, or let it lapse; the pharmacy is told', async () => {
    const first = await accepted();
    await first.pharmacist.post(`/pharmacy/rx-requests/${first.requestId}/quote`, quoteBody(first.productId)).expect(200);
    expect(body(await first.c.post(`/rx-requests/${first.requestId}/decline-quote`).expect(200))).toMatchObject({ status: 'CANCELLED' });
    await first.c.post(`/rx-requests/${first.requestId}/confirm`).expect(409);
    await ctx.drainOutbox();
    const pharmacistIds = (await ctx.prisma.userRole.findMany({ where: { organizationId: first.pharmacy.organizationId, role: { key: 'PHARMACIST' } } })).map((r) => r.userId);
    expect(await ctx.prisma.notification.count({ where: { recipientUserId: { in: pharmacistIds }, templateCode: 'RX_REQUEST_NO_LONGER_AVAILABLE' } })).toBe(1);

    const second = await accepted();
    await second.pharmacist.post(`/pharmacy/rx-requests/${second.requestId}/quote`, quoteBody(second.productId)).expect(200);
    await ctx.prisma.rxRequest.update({ where: { id: second.requestId }, data: { quoteExpiresAt: new Date(Date.now() - 1000) } });
    expect(await ctx.app.get(RxRequestExpirySweeper).run()).toBe(1);
    expect(body(await second.c.get(`/rx-requests/${second.requestId}`).expect(200))).toMatchObject({ status: 'EXPIRED' });
    await second.c.post(`/rx-requests/${second.requestId}/confirm`).expect(409);
    await ctx.drainOutbox();
    expect(await ctx.prisma.notification.count({ where: { recipientUserId: second.customer.userId, templateCode: 'RX_REQUEST_ENDED' } })).toBe(1);
  });

  it('a quote is the holding pharmacy’s alone, and only within its claim', async () => {
    const { productId, pharmacy, pharmacist, requestId } = await accepted();
    // The owner is not a pharmacist; another pharmacist of another pharmacy has no claim.
    const owner = await request(ctx.server).post(`/pharmacy/rx-requests/${requestId}/quote`).set(...auth(pharmacy.accessToken)).send(quoteBody(productId));
    expect([403, 404]).toContain(owner.status);

    await ctx.prisma.rxRequest.update({ where: { id: requestId }, data: { claimExpiresAt: new Date(Date.now() - 1000) } });
    await pharmacist.post(`/pharmacy/rx-requests/${requestId}/quote`, quoteBody(productId)).expect(409);
  });
});
