import request from 'supertest';
import { AcceptJobOfferCommand } from '../../src/modules/delivery/application/commands/accept-job-offer.command';
import { AdvanceDeliveryJobCommand } from '../../src/modules/delivery/application/commands/advance-delivery-job.command';
import { CreateDriverProfileCommand } from '../../src/modules/delivery/application/commands/create-driver-profile.command';
import { DispatchDeliveryJobCommand } from '../../src/modules/delivery/application/commands/dispatch-delivery-job.command';
import { ManageDriverShiftCommand } from '../../src/modules/delivery/application/commands/manage-driver-shift.command';
import { SetDriverAvailabilityCommand } from '../../src/modules/delivery/application/commands/set-driver-availability.command';
import { UpdateDriverLocationCommand } from '../../src/modules/delivery/application/commands/update-driver-location.command';
import { DeliveryJobStatus, DriverAvailability } from '../../src/modules/delivery/domain/enums';
import { VehicleType } from '../../src/modules/delivery/domain/value-objects/vehicle.vo';
import { auth, body, createUserWithRole } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { grantOrgRole } from '../pharmacy-inventory/support';
import { createCustomer, createCustomerAddress, createPricedProduct, createStockedPharmacy } from '../orders/support';

const PDF = Buffer.from('%PDF-1.4\n% PharmaLink paper prescription\n%%EOF\n');
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Work 136 (owner decision 2026-11-17): when the pharmacist requires the original paper, one driver
 * makes a round trip — customer (collects the paper) -> pharmacy (the pharmacist checks and keeps
 * it; the medicine is prepared) -> customer. The paper gates the pharmacy arrival, the preparation
 * and the pick-up; a paper that does not match cancels the order and no medicine leaves.
 */
describe('The original paper prescription round trip (Work 136)', () => {
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

  async function onlineDriverNear(lat: number, lng: number) {
    const user = await createUserWithRole(ctx, 'DRIVER');
    await ctx.prisma.user.update({ where: { id: user.userId }, data: { primaryRole: 'DRIVER' } });
    await ctx.prisma.verificationRequest.create({ data: { userId: user.userId, type: 'DRIVER_DOCS', status: 'APPROVED', reviewedAt: new Date() } });
    await ctx.app.get(CreateDriverProfileCommand).execute({
      userId: user.userId,
      vehicleType: VehicleType.Motorcycle,
      plateNumber: `AA-${Math.floor(Math.random() * 99_999)}`,
      serviceArea: { lat, lng, radiusMeters: 20_000 },
    });
    await ctx.app.get(ManageDriverShiftCommand).start({ userId: user.userId });
    await ctx.app.get(SetDriverAvailabilityCommand).execute({ userId: user.userId, availability: DriverAvailability.ONLINE });
    await ctx.app.get(UpdateDriverLocationCommand).execute({ userId: user.userId, lat, lng });
    return user;
  }

  /** A confirmed COD order from a prescription request whose quote requires the paper; the pharmacy has accepted it. */
  async function acceptedPaperOrder() {
    const productId = await createPricedProduct(ctx, { kind: 'RX', price: 2500 });
    const pharmacy = await createStockedPharmacy(ctx, productId, 10);
    const pharmacist = as((await grantOrgRole(ctx, 'PHARMACIST', pharmacy.organizationId)).accessToken);
    const customer = await createCustomer(ctx);
    const addressId = await createCustomerAddress(ctx, customer.accessToken);
    const c = as(customer.accessToken);
    const issued = body(await c.post('/prescriptions/uploads', { contentType: 'application/pdf', bytes: PDF.length }).expect(201));
    await request(ctx.server).put(new URL((issued.upload as { url: string }).url).pathname).set('Content-Type', 'application/pdf').send(PDF).expect(200);
    const prescriptionId = body(await c.post('/prescriptions', { fileRef: issued.fileRef, fileType: 'application/pdf' }).expect(201)).id as string;
    const requestId = body(await c.post('/rx-requests', { prescriptionId, addressId, prescriptionIssueDate: today() }).expect(201)).id as string;
    await pharmacist.post(`/pharmacy/rx-requests/${requestId}/accept`).expect(200);
    await pharmacist
      .post(`/pharmacy/rx-requests/${requestId}/quote`, { lines: [{ catalogProductId: productId, quantity: 2 }], prescriptionIssueDate: today(), paperRequired: true, legibilityOk: true, validityOk: true })
      .expect(200);
    const { orderId } = body(await c.post(`/rx-requests/${requestId}/confirm`).expect(200)) as { orderId: string };
    const fulfillment = await ctx.prisma.fulfillment.findFirstOrThrow({ where: { orderId } });

    const driver = await onlineDriverNear(9.02, 38.75);
    await pharmacist.post(`/pharmacy/orders/${fulfillment.id}/accept`).expect(200);
    await ctx.drainOutbox();

    // The job exists from acceptance, so the driver can go to the customer first.
    const job = await ctx.prisma.deliveryJob.findFirstOrThrow({ where: { orderId } });
    expect(job).toMatchObject({ paperRxRequired: true, paperCollectedAt: null, goodsReadyAt: null });
    if (job.status === DeliveryJobStatus.CREATED) await ctx.app.get(DispatchDeliveryJobCommand).execute({ jobId: job.id, actorUserId: null });
    await ctx.app.get(AcceptJobOfferCommand).execute({ userId: driver.userId, jobId: job.id });
    return { pharmacy, pharmacist, customer, driver, d: as(driver.accessToken), orderId, fulfillment, jobId: job.id, productId };
  }

  it('collect the paper, the pharmacist checks it, then the medicine is prepared and picked up', async () => {
    const { pharmacy, pharmacist, d, driver, orderId, fulfillment, jobId } = await acceptedPaperOrder();
    const advance = ctx.app.get(AdvanceDeliveryJobCommand);

    // The pharmacy first, without the paper: refused.
    await expect(advance.byDriver({ userId: driver.userId, jobId, to: DeliveryJobStatus.ARRIVED_PICKUP })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    // The pharmacist cannot check a paper the driver has not brought.
    await pharmacist.post(`/pharmacy/orders/${fulfillment.id}/paper-prescription/verify`).expect(400);

    const collected = body(await d.post(`/delivery/jobs/${jobId}/paper-collected`).expect(200));
    expect(collected.paperCollectedAt).toEqual(expect.any(String));
    await d.post(`/delivery/jobs/${jobId}/paper-collected`).expect(200); // repeating it changes nothing
    await advance.byDriver({ userId: driver.userId, jobId, to: DeliveryJobStatus.ARRIVED_PICKUP });

    // Not prepared before the check, and no pick-up before the medicine is ready.
    await pharmacist.post(`/pharmacy/orders/${fulfillment.id}/prepare`).expect(400);
    await expect(advance.byDriver({ userId: driver.userId, jobId, to: DeliveryJobStatus.PICKED_UP })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    // The pharmacy view shows where the paper is; only a pharmacist checks it.
    const view = body(await pharmacist.get(`/pharmacy/orders/${fulfillment.id}`).expect(200));
    expect(view.paper).toMatchObject({ collectedAt: expect.any(String), driverAtPharmacy: true, verifiedAt: null });
    await as(pharmacy.accessToken).post(`/pharmacy/orders/${fulfillment.id}/paper-prescription/verify`).expect((res) => expect([400, 403]).toContain(res.status));

    const verified = body(await pharmacist.post(`/pharmacy/orders/${fulfillment.id}/paper-prescription/verify`).expect(200));
    expect(verified.paperRxVerifiedAt).toEqual(expect.any(String));
    await pharmacist.post(`/pharmacy/orders/${fulfillment.id}/paper-prescription/verify`).expect(400);

    for (const step of ['prepare', 'ready']) await pharmacist.post(`/pharmacy/orders/${fulfillment.id}/${step}`).expect(200);
    await ctx.drainOutbox();
    expect((await ctx.prisma.deliveryJob.findUniqueOrThrow({ where: { id: jobId } })).goodsReadyAt).not.toBeNull();
    // Still the one job: the order's readiness did not cut a second one.
    expect(await ctx.prisma.deliveryJob.count({ where: { orderId } })).toBe(1);

    await advance.byDriver({ userId: driver.userId, jobId, to: DeliveryJobStatus.PICKED_UP });
    await ctx.drainOutbox();
    expect((await ctx.prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('DISPATCHED');
  });

  it('a paper that does not match cancels the order and its delivery; no medicine leaves', async () => {
    const { pharmacist, d, driver, orderId, fulfillment, jobId, productId } = await acceptedPaperOrder();
    await d.post(`/delivery/jobs/${jobId}/paper-collected`).expect(200);
    await ctx.app.get(AdvanceDeliveryJobCommand).byDriver({ userId: driver.userId, jobId, to: DeliveryJobStatus.ARRIVED_PICKUP });

    await pharmacist.post(`/pharmacy/orders/${fulfillment.id}/paper-prescription/reject`, { reason: 'No' }).expect(400);
    const rejected = body(await pharmacist.post(`/pharmacy/orders/${fulfillment.id}/paper-prescription/reject`, { reason: 'The paper is for another patient.' }).expect(200));
    expect(rejected.status).toBe('CANCELLED');
    expect(rejected.cancelReason).toContain('The paper is for another patient.');
    expect((await ctx.prisma.inventoryListing.findFirstOrThrow({ where: { catalogProductId: productId } })).reserved).toBe(0);

    await ctx.drainOutbox();
    expect((await ctx.prisma.deliveryJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe(DeliveryJobStatus.CANCELLED);
    expect((await ctx.prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('CANCELLED');
  });

  it('an order without the paper keeps its usual flow: no job before it is ready', async () => {
    const productId = await createPricedProduct(ctx, { kind: 'OTC', price: 1000 });
    const pharmacy = await createStockedPharmacy(ctx, productId, 10);
    const customer = await createCustomer(ctx);
    const addressId = await createCustomerAddress(ctx, customer.accessToken);
    const c = as(customer.accessToken);
    await c.post('/cart/items', { catalogProductId: productId, quantity: 1 }).expect(201);
    const placed = body(await c.post('/checkout', { addressId, idempotencyKey: `paper-none-${Date.now()}` }).expect(201));
    const fulfillment = await ctx.prisma.fulfillment.findFirstOrThrow({ where: { orderId: placed.orderId as string } });
    await as(pharmacy.accessToken).post(`/pharmacy/orders/${fulfillment.id}/accept`).expect(200);
    await ctx.drainOutbox();
    expect(await ctx.prisma.deliveryJob.count({ where: { orderId: placed.orderId as string } })).toBe(0);
    await as(pharmacy.accessToken).post(`/pharmacy/orders/${fulfillment.id}/prepare`).expect(200);
  });
});
