import request from 'supertest';
import { auth, body, errorOf } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { createActivatedPharmacy, grantOrgRole } from '../pharmacy-inventory/support';
import { createCustomer, createCustomerAddress } from './support';
import { RxRequestExpirySweeper } from '../../src/modules/orders/infrastructure/scheduling/rx-request-expiry.sweeper';

const PDF = Buffer.from('%PDF-1.4\n% PharmaLink prescription request\n%%EOF\n');
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

/**
 * Work 134 (owner decision 2026-11-17): a prescription request, ride-hailing style. Sent to every
 * eligible pharmacy near the delivery address (9.02, 38.75); the first to accept owns it; a
 * release, a lapse or a decline by all moves it on, and everyone concerned is told.
 */
describe('Prescription requests offered to nearby pharmacies (Work 134)', () => {
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

  /** An activated pharmacy with one branch at `point`, and (unless told otherwise) a pharmacist. */
  async function pharmacyAt(point: { lat: number; lng: number }, withPharmacist = true) {
    const owner = await createActivatedPharmacy(ctx);
    await as(owner.accessToken).post('/pharmacy/branches', { name: 'Branch', ...point }).expect(201);
    const pharmacist = withPharmacist ? await grantOrgRole(ctx, 'PHARMACIST', owner.organizationId) : null;
    return { owner, pharmacist, api: pharmacist ? as(pharmacist.accessToken) : null };
  }

  async function customerWithPrescription() {
    const customer = await createCustomer(ctx);
    await ctx.prisma.customerProfile.upsert({
      where: { userId: customer.userId },
      update: { fullName: 'Selam Bekele' },
      create: { userId: customer.userId, fullName: 'Selam Bekele' },
    });
    const addressId = await createCustomerAddress(ctx, customer.accessToken);
    const api = as(customer.accessToken);
    const issued = body(await api.post('/prescriptions/uploads', { contentType: 'application/pdf', bytes: PDF.length }).expect(201));
    await request(ctx.server).put(new URL((issued.upload as { url: string }).url).pathname).set('Content-Type', 'application/pdf').send(PDF).expect(200);
    const prescriptionId = body(await api.post('/prescriptions', { fileRef: issued.fileRef, fileType: 'application/pdf' }).expect(201)).id as string;
    return { customer, addressId, prescriptionId, api };
  }

  const notified = (userId: string, templateCode: string) =>
    ctx.prisma.notification.count({ where: { recipientUserId: userId, templateCode } });

  async function sent() {
    const near = await pharmacyAt({ lat: 9.025, lng: 38.752 });
    const nearer = await pharmacyAt({ lat: 9.021, lng: 38.751 });
    const far = await pharmacyAt({ lat: 9.6, lng: 39.3 }); // about 85 km away
    const noPharmacist = await pharmacyAt({ lat: 9.022, lng: 38.75 }, false);
    const c = await customerWithPrescription();
    const created = body(
      await c.api.post('/rx-requests', { prescriptionId: c.prescriptionId, addressId: c.addressId, prescriptionIssueDate: today(), note: 'Twice a day' }).expect(201),
    );
    await ctx.drainOutbox();
    return { near, nearer, far, noPharmacist, c, requestId: created.id as string, created };
  }

  it('is offered to the eligible pharmacies near the address only, and their owners and pharmacists are told at once', async () => {
    const { near, nearer, far, noPharmacist, c, requestId, created } = await sent();
    expect(created).toMatchObject({ status: 'OPEN', offeredTo: 2, stillConsidering: 2, pharmacy: null });

    for (const p of [near, nearer]) {
      expect(await notified(p.owner.userId, 'RX_REQUEST_NEW')).toBe(1);
      expect(await notified(p.pharmacist!.userId, 'RX_REQUEST_NEW')).toBe(1);
    }
    expect(await notified(far.owner.userId, 'RX_REQUEST_NEW')).toBe(0);
    expect(await notified(noPharmacist.owner.userId, 'RX_REQUEST_NEW')).toBe(0);

    // The pharmacy sees who sent it (name only) and can open the file; a pharmacy not offered it cannot.
    const list = body(await near.api!.get('/pharmacy/rx-requests').expect(200)) as { items: Array<Record<string, unknown>> };
    expect(list.items).toEqual([
      expect.objectContaining({ id: requestId, status: 'OPEN', customerName: 'Selam Bekele', note: 'Twice a day', offer: expect.objectContaining({ status: 'OPEN' }) }),
    ]);
    expect(JSON.stringify(list)).not.toMatch(/\+2519|Bole Road/);
    const link = body(await near.api!.post(`/pharmacy/rx-requests/${requestId}/file`).expect(200));
    expect(link.url).toEqual(expect.any(String));
    await far.api!.post(`/pharmacy/rx-requests/${requestId}/file`).expect(404);
    expect(body(await far.api!.get('/pharmacy/rx-requests').expect(200)).items).toEqual([]);

    // The customer's own list.
    const mine = body(await c.api.get('/rx-requests').expect(200)) as { items: unknown[] };
    expect(mine.items).toHaveLength(1);
  });

  it('first acceptance wins when two pharmacists accept at the same moment; the other is told it is taken', async () => {
    const { near, nearer, c, requestId } = await sent();

    const results = await Promise.all([near, nearer].map((p) => p.api!.post(`/pharmacy/rx-requests/${requestId}/accept`)));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    const loserResponse = results.find((r) => r.status === 409)!;
    expect(errorOf(loserResponse).code).toBe('RX_REQUEST_UNAVAILABLE');
    const winner = results[0].status === 200 ? near : nearer;
    const loser = winner === near ? nearer : near;

    const row = await ctx.prisma.rxRequest.findUniqueOrThrow({ where: { id: requestId }, include: { offers: true } });
    expect(row.status).toBe('CLAIMED');
    expect(row.claimedPharmacyId).toBe(winner.owner.pharmacyId);
    expect(row.offers.filter((o) => o.status === 'WON')).toHaveLength(1);
    expect(row.offers.find((o) => o.pharmacyId === loser.owner.pharmacyId)?.status).toBe('TAKEN');

    await ctx.drainOutbox();
    expect(await notified(c.customer.userId, 'RX_REQUEST_ACCEPTED')).toBe(1);
    expect(await notified(loser.pharmacist!.userId, 'RX_REQUEST_NO_LONGER_AVAILABLE')).toBe(1);
    expect(await notified(winner.pharmacist!.userId, 'RX_REQUEST_NO_LONGER_AVAILABLE')).toBe(0);
    expect(body(await c.api.get(`/rx-requests/${requestId}`).expect(200))).toMatchObject({ status: 'CLAIMED', pharmacy: { name: 'Test Pharmacy' } });

    // The losing pharmacy can no longer open the file or accept; a second accept by the winner is refused too.
    await loser.api!.post(`/pharmacy/rx-requests/${requestId}/file`).expect(409);
    await winner.api!.post(`/pharmacy/rx-requests/${requestId}/accept`).expect(409);
  });

  it('a release offers it to the others again; a lapsed acceptance with nobody left ends it, and the customer is told each time', async () => {
    const { near, nearer, c, requestId } = await sent();

    await near.api!.post(`/pharmacy/rx-requests/${requestId}/accept`).expect(200);
    const released = body(await near.api!.post(`/pharmacy/rx-requests/${requestId}/release`, { reason: 'Out of stock today' }).expect(200));
    expect(released).toMatchObject({ status: 'OPEN', offer: expect.objectContaining({ status: 'DECLINED' }) });
    await ctx.drainOutbox();
    expect(await notified(c.customer.userId, 'RX_REQUEST_REOPENED')).toBe(1);
    expect(await notified(nearer.pharmacist!.userId, 'RX_REQUEST_AVAILABLE_AGAIN')).toBe(1);
    // The pharmacy that let it go cannot take it back.
    await near.api!.post(`/pharmacy/rx-requests/${requestId}/accept`).expect(409);

    await nearer.api!.post(`/pharmacy/rx-requests/${requestId}/accept`).expect(200);
    await ctx.prisma.rxRequest.update({ where: { id: requestId }, data: { claimExpiresAt: new Date(Date.now() - 1000) } });
    expect(await ctx.app.get(RxRequestExpirySweeper).run()).toBe(1);

    const row = await ctx.prisma.rxRequest.findUniqueOrThrow({ where: { id: requestId }, include: { offers: true } });
    expect(row.status).toBe('NO_PHARMACY');
    expect(row.offers.find((o) => o.pharmacyId === nearer.owner.pharmacyId)?.status).toBe('LAPSED');
    await ctx.drainOutbox();
    expect(await notified(c.customer.userId, 'RX_REQUEST_ENDED')).toBe(1);
  });

  it('a lapsed acceptance with another pharmacy left reopens it to that pharmacy', async () => {
    const { near, nearer, c, requestId } = await sent();
    await near.api!.post(`/pharmacy/rx-requests/${requestId}/accept`).expect(200);
    await ctx.prisma.rxRequest.update({ where: { id: requestId }, data: { claimExpiresAt: new Date(Date.now() - 1000) } });

    expect(await ctx.app.get(RxRequestExpirySweeper).run()).toBe(1);
    expect(await ctx.app.get(RxRequestExpirySweeper).run()).toBe(0);
    const row = await ctx.prisma.rxRequest.findUniqueOrThrow({ where: { id: requestId }, include: { offers: true } });
    expect(row).toMatchObject({ status: 'OPEN', claimedPharmacyId: null });
    expect(row.offers.find((o) => o.pharmacyId === near.owner.pharmacyId)?.status).toBe('LAPSED');
    expect(row.offers.find((o) => o.pharmacyId === nearer.owner.pharmacyId)?.status).toBe('OPEN');
    await ctx.drainOutbox();
    expect(await notified(c.customer.userId, 'RX_REQUEST_REOPENED')).toBe(1);
    await nearer.api!.post(`/pharmacy/rx-requests/${requestId}/accept`).expect(200);
  });

  it('declined by every pharmacy, it ends; only a pharmacist decides', async () => {
    const { near, nearer, c, requestId } = await sent();
    // The owner sees it but is not a pharmacist.
    const ownerAccept = await as(near.owner.accessToken).post(`/pharmacy/rx-requests/${requestId}/accept`);
    expect([403, 404]).toContain(ownerAccept.status);
    await as(near.owner.accessToken).get(`/pharmacy/rx-requests/${requestId}`).expect(200);

    await near.api!.post(`/pharmacy/rx-requests/${requestId}/decline`, { reason: 'No' }).expect(400);
    await near.api!.post(`/pharmacy/rx-requests/${requestId}/decline`, { reason: 'We do not stock this' }).expect(200);
    await near.api!.post(`/pharmacy/rx-requests/${requestId}/decline`, { reason: 'We do not stock this' }).expect(409);
    expect(body(await c.api.get(`/rx-requests/${requestId}`).expect(200))).toMatchObject({ status: 'OPEN', stillConsidering: 1 });
    await nearer.api!.post(`/pharmacy/rx-requests/${requestId}/decline`, { reason: 'Closed for stocktaking' }).expect(200);

    expect(body(await c.api.get(`/rx-requests/${requestId}`).expect(200))).toMatchObject({ status: 'NO_PHARMACY', stillConsidering: 0 });
    await ctx.drainOutbox();
    expect(await notified(c.customer.userId, 'RX_REQUEST_ENDED')).toBe(1);
  });

  it('expires when nobody accepts in time, and the customer can cancel while it is open', async () => {
    const first = await sent();
    await ctx.prisma.rxRequest.update({ where: { id: first.requestId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await first.near.api!.post(`/pharmacy/rx-requests/${first.requestId}/accept`).expect(409);
    expect(await ctx.app.get(RxRequestExpirySweeper).run()).toBe(1);
    expect(body(await first.c.api.get(`/rx-requests/${first.requestId}`).expect(200))).toMatchObject({ status: 'EXPIRED' });
    await ctx.drainOutbox();
    expect(await notified(first.c.customer.userId, 'RX_REQUEST_ENDED')).toBe(1);
    expect(await notified(first.near.pharmacist!.userId, 'RX_REQUEST_NO_LONGER_AVAILABLE')).toBe(1);

    // A fresh prescription, sent and cancelled.
    const again = await customerWithPrescription();
    const created = body(await again.api.post('/rx-requests', { prescriptionId: again.prescriptionId, addressId: again.addressId, prescriptionIssueDate: today() }).expect(201));
    const cancelled = body(await again.api.post(`/rx-requests/${created.id as string}/cancel`).expect(200));
    expect(cancelled).toMatchObject({ status: 'CANCELLED' });
    await again.api.post(`/rx-requests/${created.id as string}/cancel`).expect(409);
    await first.near.api!.post(`/pharmacy/rx-requests/${created.id as string}/accept`).expect(409);
  });

  it('refuses a prescription older than the limit or dated in the future, one sent twice, and ends at once when no pharmacy is near', async () => {
    const c = await customerWithPrescription();
    const send = (date: string) => c.api.post('/rx-requests', { prescriptionId: c.prescriptionId, addressId: c.addressId, prescriptionIssueDate: date });

    expect(errorOf(await send(daysAgo(15)).expect(422)).code).toBe('PRESCRIPTION_TOO_OLD');
    expect(errorOf(await send(daysAgo(-2)).expect(422)).code).toBe('PRESCRIPTION_TOO_OLD');
    await send('not-a-date').expect(400);

    // No pharmacy near: it ends straight away, and the customer is told.
    const created = body(await send(daysAgo(14)).expect(201));
    expect(created).toMatchObject({ status: 'NO_PHARMACY', offeredTo: 0 });
    await ctx.drainOutbox();
    expect(await notified(c.customer.userId, 'RX_REQUEST_ENDED')).toBe(1);
    await send(today()).expect(400);

    // Another customer's request reads as not found.
    const other = await createCustomer(ctx);
    await as(other.accessToken).get(`/rx-requests/${created.id as string}`).expect(404);
  });
});
