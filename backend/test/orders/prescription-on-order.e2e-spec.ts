import { randomUUID } from 'crypto';
import request from 'supertest';
import { auth, body } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { grantOrgRole } from '../pharmacy-inventory/support';
import { readyToCheckout, ReadyToCheckout } from './support';

const PDF = Buffer.from('%PDF-1.4\n% PharmaLink order prescription\n%%EOF\n');

/**
 * Work 129 (owner decision 2026-11-16): the prescription travels with the order. The customer
 * attaches it at checkout; the filling pharmacy's pharmacist reviews it on the order and approves
 * or rejects it there. Cash-on-delivery orders are covered here; the prepaid path (pay after the
 * approval) is the Phase 1 marketplace run.
 */
describe('A prescription on the order (Work 129)', () => {
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

  async function uploaded(shop: ReadyToCheckout): Promise<string> {
    const customer = as(shop.user.accessToken);
    const issued = body(await customer.post('/prescriptions/uploads', { contentType: 'application/pdf', bytes: PDF.length }).expect(201));
    await request(ctx.server).put(new URL((issued.upload as { url: string }).url).pathname).set('Content-Type', 'application/pdf').send(PDF).expect(200);
    return body(await customer.post('/prescriptions', { fileRef: issued.fileRef, fileType: 'application/pdf' }).expect(201)).id as string;
  }

  /** A COD order of 3 prescription units with its prescription attached, and the pharmacy's fulfilment. */
  async function placed() {
    const shop = await readyToCheckout(ctx, { kind: 'RX', quantity: 3, stock: 10 });
    const rxId = await uploaded(shop);
    const order = body(
      await as(shop.user.accessToken).post('/checkout', { addressId: shop.addressId, idempotencyKey: randomUUID(), prescriptionId: rxId }).expect(201),
    );
    const fulfillment = await ctx.prisma.fulfillment.findFirstOrThrow({ where: { orderId: order.orderId as string } });
    const pharmacist = await grantOrgRole(ctx, 'PHARMACIST', shop.pharmacy.organizationId);
    return { shop, rxId, order, orderId: order.orderId as string, fulfillment, pharmacist: as(pharmacist.accessToken) };
  }

  const listingOf = (shop: ReadyToCheckout) => ctx.prisma.inventoryListing.findFirstOrThrow({ where: { catalogProductId: shop.catalogProductId } });

  it('a COD order waits for the review with its stock held, then is paid when the pharmacist approves', async () => {
    const { shop, rxId, order, orderId, fulfillment, pharmacist } = await placed();
    expect(order).toMatchObject({ status: 'PENDING_PAYMENT', isCod: true, rxReviewStatus: 'PENDING' });
    expect((await listingOf(shop)).reserved).toBe(3);
    expect(await ctx.prisma.prescription.findUniqueOrThrow({ where: { id: rxId } })).toMatchObject({
      status: 'PENDING_VERIFICATION',
      verifyingPharmacyId: shop.pharmacy.organizationId,
    });

    // The customer sees the order waiting for the pharmacist.
    const mine = body(await as(shop.user.accessToken).get(`/orders/${orderId}`).expect(200)) as { order: Record<string, unknown> };
    expect(mine.order).toMatchObject({ status: 'PENDING_PAYMENT', rxReviewStatus: 'PENDING', prescriptionId: rxId });

    // An attestation left unticked is refused; the owner (no PHARMACIST role) cannot decide.
    await pharmacist.post(`/pharmacy/orders/${fulfillment.id}/prescription/approve`, { legibilityOk: true, validityOk: false }).expect(400);
    await as(shop.pharmacy.accessToken).post(`/pharmacy/orders/${fulfillment.id}/prescription/approve`, { legibilityOk: true, validityOk: true }).expect(403);

    const approved = body(await pharmacist.post(`/pharmacy/orders/${fulfillment.id}/prescription/approve`, { legibilityOk: true, validityOk: true }).expect(200));
    expect(approved).toMatchObject({ status: 'PAID', rxReviewStatus: 'APPROVED' });
    // Approved for exactly what was ordered, and each Rx line points at its approved line.
    const lines = await ctx.prisma.prescriptionLine.findMany({ where: { prescriptionId: rxId } });
    expect(lines).toEqual([expect.objectContaining({ catalogProductId: shop.catalogProductId, prescribedQuantity: 3, remainingDispensable: 3 })]);
    const orderLine = await ctx.prisma.orderLine.findFirstOrThrow({ where: { orderId } });
    expect(orderLine.prescriptionLineId).toBe(lines[0].id);

    // The pharmacy fills it as any paid order; preparing dispenses against the approval.
    for (const step of ['accept', 'prepare']) {
      await pharmacist.post(`/pharmacy/orders/${fulfillment.id}/${step}`).expect(200);
    }
    expect((await ctx.prisma.prescriptionLine.findUniqueOrThrow({ where: { id: lines[0].id } })).remainingDispensable).toBe(0);
    // A second approval changes nothing.
    await pharmacist.post(`/pharmacy/orders/${fulfillment.id}/prescription/approve`, { legibilityOk: true, validityOk: true }).expect(400);
  });

  it('a rejected prescription cancels the order, releases the stock, and tells the customer why', async () => {
    const { shop, rxId, fulfillment, pharmacist } = await placed();

    await pharmacist.post(`/pharmacy/orders/${fulfillment.id}/prescription/reject`, { reason: 'No' }).expect(400);
    const rejected = body(
      await pharmacist.post(`/pharmacy/orders/${fulfillment.id}/prescription/reject`, { reason: 'The prescription is not legible.' }).expect(200),
    );
    expect(rejected).toMatchObject({ status: 'CANCELLED', rxReviewStatus: 'REJECTED' });
    expect(rejected.cancelReason).toContain('The prescription is not legible.');
    expect((await ctx.prisma.prescription.findUniqueOrThrow({ where: { id: rxId } })).status).toBe('REJECTED');
    expect((await listingOf(shop)).reserved).toBe(0);
  });

  it('the pharmacy cannot decline an order waiting for its review, and a prescription goes on one order only', async () => {
    const { shop, rxId, fulfillment, pharmacist } = await placed();

    await pharmacist.post(`/pharmacy/orders/${fulfillment.id}/decline`, { reason: 'Out of stock today' }).expect(400);

    await ctx.prisma.cart.create({
      data: { customerUserId: shop.user.userId, status: 'ACTIVE', items: { create: { catalogProductId: shop.catalogProductId, quantity: 1, indicativePrice: 2500 } } },
    });
    await as(shop.user.accessToken).post('/checkout', { addressId: shop.addressId, idempotencyKey: randomUUID(), prescriptionId: rxId }).expect(400);
  });
});
