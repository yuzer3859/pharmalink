import { randomUUID } from 'crypto';
import request from 'supertest';
import { AcceptJobOfferCommand } from '../../src/modules/delivery/application/commands/accept-job-offer.command';
import { AdvanceDeliveryJobCommand } from '../../src/modules/delivery/application/commands/advance-delivery-job.command';
import { CaptureProofOfDeliveryCommand } from '../../src/modules/delivery/application/commands/capture-proof-of-delivery.command';
import { CreateDriverProfileCommand } from '../../src/modules/delivery/application/commands/create-driver-profile.command';
import { DispatchDeliveryJobCommand } from '../../src/modules/delivery/application/commands/dispatch-delivery-job.command';
import { ManageDriverShiftCommand } from '../../src/modules/delivery/application/commands/manage-driver-shift.command';
import { SetDriverAvailabilityCommand } from '../../src/modules/delivery/application/commands/set-driver-availability.command';
import { UpdateDriverLocationCommand } from '../../src/modules/delivery/application/commands/update-driver-location.command';
import { DeliveryJobStatus, DriverAvailability, PodType } from '../../src/modules/delivery/domain/enums';
import { VehicleType } from '../../src/modules/delivery/domain/value-objects/vehicle.vo';
import { SearchProjectorService } from '../../src/modules/search/application/search-projector.service';
import { auth, body, createUserWithRole } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { grantOrgRole } from '../pharmacy-inventory/support';
import { readyToCheckout, ReadyToCheckout } from '../orders/support';

const FIN = '/admin/finance';
const PDF = Buffer.from('%PDF-1.4\n% PharmaLink Phase 1 prescription\n%%EOF\n');

/**
 * Work 103: the roadmap's Phase 1 exit criteria (`00-implementation-roadmap.md` §3), as one
 * automated run over the real HTTP stack, ledger, outbox and audit chain:
 *
 *  1. Happy path: search → add to cart → Rx verified by a pharmacist → checkout → pay (test gateway)
 *     → pharmacy accepts, prepares, marks ready → payment captured → delivery job dispatched to a
 *     driver → picked up → proof of delivery → delivered → statement generated → two officers
 *     approve and pay it out → the payment is SETTLED.
 *  2. Saga compensation: a declined payment releases the stock reservation.
 *  3. Ledger reconciliation: debits equal credits, the pharmacy's payable is paid out to zero, and
 *     the finance reconciliation report finds no anomaly.
 */
describe('Phase 1 marketplace, end to end (Work 103)', () => {
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

  // ------------------------------------------------------------------------------------------
  // Actors
  // ------------------------------------------------------------------------------------------

  async function onlineDriverNear(lat: number, lng: number): Promise<{ userId: string; accessToken: string }> {
    const user = await createUserWithRole(ctx, 'DRIVER');
    await ctx.prisma.user.update({ where: { id: user.userId }, data: { primaryRole: 'DRIVER' } });
    // Driver documents approved (Module 01); the verification flow itself is Work 80's walk.
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
    return { userId: user.userId, accessToken: user.accessToken };
  }

  const as = (token: string) => ({
    get: (path: string) => request(ctx.server).get(path).set(...auth(token)),
    post: (path: string, payload: object = {}) => request(ctx.server).post(path).set(...auth(token)).send(payload),
  });

  async function prescriptionApprovedFor(shop: ReadyToCheckout): Promise<string> {
    const customer = as(shop.user.accessToken);
    const issued = body(await customer.post('/prescriptions/uploads', { contentType: 'application/pdf', bytes: PDF.length }).expect(201));
    const upload = issued.upload as { url: string };
    await request(ctx.server).put(new URL(upload.url).pathname).set('Content-Type', 'application/pdf').send(PDF).expect(200);
    const rx = body(await customer.post('/prescriptions', { fileRef: issued.fileRef, fileType: 'application/pdf', doctorName: 'Abebe' }).expect(201));
    const rxId = rx.id as string;

    // Work 109 (verify before paying): opening checkout routes the prescription to the pharmacy the
    // quote ranked first, the one that then fills the order.
    const routed = body(await customer.post('/checkout/quote', { addressId: shop.addressId }).expect(200));
    expect(routed.prescriptionReview).toMatchObject({ prescriptionId: rxId, status: 'PENDING_VERIFICATION', verifyingOrganizationId: shop.pharmacy.organizationId, routedNow: true });
    const again = body(await customer.post('/checkout/quote', { addressId: shop.addressId }).expect(200));
    expect(again.prescriptionReview).toMatchObject({ prescriptionId: rxId, routedNow: false });
    const pharmacist = await grantOrgRole(ctx, 'PHARMACIST', shop.pharmacy.organizationId);
    // The pharmacist sees what the customer asks for, to approve lines against it.
    const review = body(await as(pharmacist.accessToken).get(`/pharmacy/verification/${rxId}`).expect(200));
    expect(review.requestedItems).toEqual([expect.objectContaining({ catalogProductId: shop.catalogProductId, quantity: expect.any(Number) })]);
    const queue = body(await as(pharmacist.accessToken).get('/pharmacy/verification/queue').expect(200)) as { items: Array<{ id: string }> };
    expect(queue.items.map((i) => i.id)).toContain(rxId);
    await as(pharmacist.accessToken).post(`/pharmacy/verification/${rxId}/file`).expect(200);
    await as(pharmacist.accessToken)
      .post(`/pharmacy/verification/${rxId}/approve`, {
        lines: [{ catalogProductId: shop.catalogProductId, approvedQuantity: 10, refillsAllowed: 0, isSingleUse: false }],
        legibilityOk: true,
        validityOk: true,
      })
      .expect(200);
    return rxId;
  }

  async function settleAndPayOut(pharmacyId: string): Promise<{ settlementId: string; netPayable: number }> {
    const maker = await createUserWithRole(ctx, 'FINANCE_OFFICER');
    const checker = await createUserWithRole(ctx, 'FINANCE_OFFICER');
    const ask = (path: string, payload: object = {}) =>
      request(ctx.server).post(path).set(...auth(maker.accessToken)).set('Idempotency-Key', randomUUID()).send(payload);
    const approve = async (asked: request.Response) => {
      expect(body(asked).outcome).toBe('MAKER_CHECKER_PENDING');
      const approvalId = (body(asked).approval as { id: string }).id;
      return request(ctx.server).post(`/admin/approvals/${approvalId}/decide`).set(...auth(checker.accessToken)).send({ decision: 'APPROVE' }).expect(200);
    };

    const run = body(
      await request(ctx.server)
        .post(`${FIN}/settlements/run`)
        .set(...auth(maker.accessToken))
        .send({ pharmacyId, periodStart: '2020-01-01T00:00:00.000Z', periodEnd: new Date().toISOString() })
        .expect(200),
    ).settlement as { settlementId: string; netPayable: number };

    await approve(await ask(`${FIN}/settlements/${run.settlementId}/approve`).expect(202));
    const beneficiary = body(
      await request(ctx.server)
        .post(`${FIN}/pharmacies/${pharmacyId}/payout-beneficiaries`)
        .set(...auth(maker.accessToken))
        .send({ rail: 'BANK_TRANSFER', accountName: 'Phase One Pharmacy PLC', bankCode: 'CBE', accountIdentifier: '1000123456789' })
        .expect(201),
    ).id as string;
    await approve(await ask(`${FIN}/payout-beneficiaries/${beneficiary}/verify`).expect(202));
    const paid = await approve(await ask(`${FIN}/settlements/${run.settlementId}/pay`).expect(202));
    expect(body(paid)).toMatchObject({ status: 'APPROVED', executionResult: { status: 'PAID' } });
    return run;
  }

  // ------------------------------------------------------------------------------------------
  // 1. The happy path
  // ------------------------------------------------------------------------------------------

  it('browse → cart → Rx verify → checkout → pay → assign driver → deliver → PoD → settle', async () => {
    const shop = await readyToCheckout(ctx, { kind: 'RX', quantity: 2 });
    const customer = as(shop.user.accessToken);

    // Browse: the product is found by search, with the pharmacy that has it.
    await ctx.app.get(SearchProjectorService).reindexAll();
    const hits = body(await request(ctx.server).get('/search/medicines?q=ibu&lat=9.02&lng=38.75').expect(200)).items as Array<{
      productId: string;
      availability: { pharmacyCount: number };
    }>;
    expect(hits.find((h) => h.productId === shop.catalogProductId)?.availability.pharmacyCount).toBe(1);

    // Rx gate: blocked without a prescription, open once a pharmacist approves one.
    const blocked = body(await customer.post('/checkout/quote', { addressId: shop.addressId }).expect(200));
    expect((blocked.rxGateResult as { allowed: boolean }).allowed).toBe(false);
    await prescriptionApprovedFor(shop);
    const quote = body(await customer.post('/checkout/quote', { addressId: shop.addressId }).expect(200));
    expect((quote.rxGateResult as { allowed: boolean }).allowed).toBe(true);

    // Checkout and pay through the test gateway.
    const placed = body(
      await customer.post('/checkout', { addressId: shop.addressId, idempotencyKey: randomUUID(), payment: { method: 'TELEBIRR', token: 'tok-phase1' } }).expect(201),
    );
    expect(placed).toMatchObject({ status: 'PAID', isCod: false, payment: { status: 'AUTHORIZED' } });
    const orderId = placed.orderId as string;
    const paymentId = (placed.payment as { paymentId: string }).paymentId;

    // The pharmacy accepts, prepares and marks it ready.
    const driver = await onlineDriverNear(9.02, 38.75);
    const fulfillment = await ctx.prisma.fulfillment.findFirstOrThrow({ where: { orderId } });
    // Work 109: the pharmacy whose pharmacist approved the prescription fills the order.
    expect(fulfillment.pharmacyId).toBe(shop.pharmacy.pharmacyId);
    for (const step of ['accept', 'prepare', 'ready']) {
      await as(shop.pharmacy.accessToken).post(`/pharmacy/orders/${fulfillment.id}/${step}`).expect(200);
    }
    await ctx.drainOutbox();

    // Capture at fulfilment; a delivery job exists.
    expect((await ctx.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe('CAPTURED');
    const job = await ctx.prisma.deliveryJob.findFirstOrThrow({ where: { orderId } });
    if (job.status === DeliveryJobStatus.CREATED) await ctx.app.get(DispatchDeliveryJobCommand).execute({ jobId: job.id, actorUserId: null });

    // The driver accepts, picks up, delivers, and records proof of delivery.
    await ctx.app.get(AcceptJobOfferCommand).execute({ userId: driver.userId, jobId: job.id });
    const advance = ctx.app.get(AdvanceDeliveryJobCommand);
    for (const to of [DeliveryJobStatus.ARRIVED_PICKUP, DeliveryJobStatus.PICKED_UP, DeliveryJobStatus.EN_ROUTE, DeliveryJobStatus.ARRIVED_DROPOFF]) {
      await advance.byDriver({ userId: driver.userId, jobId: job.id, to });
    }
    await ctx.app.get(CaptureProofOfDeliveryCommand).execute({
      userId: driver.userId,
      jobId: job.id,
      type: PodType.CONFIRMATION,
      recipientName: 'Selam Bekele',
      recipientConfirmed: true,
    });
    await advance.byDriver({ userId: driver.userId, jobId: job.id, to: DeliveryJobStatus.DELIVERED });
    await ctx.drainOutbox();

    const delivered = await ctx.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(['DELIVERED', 'COMPLETED']).toContain(delivered.status);
    const pod = body(await customer.get(`/delivery/jobs/${job.id}/proof-of-delivery`).expect(200));
    expect(pod).toMatchObject({ type: 'CONFIRMATION', recipientName: 'Selam Bekele' });

    // Settle: the statement pays the pharmacy what the capture accrued; the payment is SETTLED.
    const capture = await ctx.prisma.ledgerTransaction.findUniqueOrThrow({ where: { reference: `CAPTURE-${paymentId}` }, include: { entries: { include: { account: true } } } });
    const providerCredit = capture.entries.find((e) => e.account.type === 'PROVIDER_PAYABLE' && e.direction === 'CREDIT')!.amount;
    const statement = await settleAndPayOut(shop.pharmacy.pharmacyId);
    expect(statement.netPayable).toBe(providerCredit);
    expect((await ctx.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe('SETTLED');

    // Ledger reconciliation.
    const totals = await ctx.prisma.ledgerEntry.groupBy({ by: ['direction'], _sum: { amount: true } });
    const sum = (d: string) => totals.find((t) => t.direction === d)?._sum.amount ?? 0;
    expect(sum('DEBIT')).toBe(sum('CREDIT'));
    const payable = await ctx.prisma.ledgerAccount.findFirstOrThrow({ where: { type: 'PROVIDER_PAYABLE', ownerId: shop.pharmacy.pharmacyId } });
    const payableEntries = await ctx.prisma.ledgerEntry.findMany({ where: { accountId: payable.id } });
    const balance = payableEntries.reduce((b, e) => b + (e.direction === 'CREDIT' ? e.amount : -e.amount), 0);
    expect(balance).toBe(0);
    const officer = await createUserWithRole(ctx, 'FINANCE_OFFICER');
    const report = body(await as(officer.accessToken).get(`${FIN}/reconciliation`).expect(200));
    expect(report).toMatchObject({ status: 'CLEAN', discrepancyCount: 0, discrepancies: [] });

    // Every step left its audit trail.
    for (const action of ['ORDER_PLACED', 'ORDER_PAID', 'PRESCRIPTION_FILE_PREVIEWED', 'SETTLEMENT_PAID']) {
      expect(await ctx.prisma.auditLog.count({ where: { action } })).toBeGreaterThan(0);
    }
  });

  // ------------------------------------------------------------------------------------------
  // 2. Saga compensation
  // ------------------------------------------------------------------------------------------

  it('a payment failure releases the stock reservation (saga compensation)', async () => {
    const shop = await readyToCheckout(ctx, { kind: 'OTC', quantity: 3, stock: 10 });
    const listing = await ctx.prisma.inventoryListing.findFirstOrThrow({ where: { catalogProductId: shop.catalogProductId } });

    const res = await as(shop.user.accessToken)
      .post('/checkout', { addressId: shop.addressId, idempotencyKey: randomUUID(), payment: { method: 'CARD', token: 'test-decline' } })
      .expect(402);
    const orderId = res.body.error.details.orderId as string;

    expect((await ctx.prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('CANCELLED');
    const lines = await ctx.prisma.orderLine.findMany({ where: { orderId } });
    const reservations = await ctx.prisma.stockReservation.findMany({ where: { id: { in: lines.map((l) => l.reservationId!).filter(Boolean) } } });
    expect(reservations.map((r) => r.status)).toEqual(['RELEASED']);
    const after = await ctx.prisma.inventoryListing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(after.reserved).toBe(listing.reserved);
    expect(after.sellable).toBe(listing.sellable);

    // The released stock can be bought again at once.
    const retry = await ctx.prisma.cart.create({ data: { customerUserId: shop.user.userId, status: 'ACTIVE' } });
    await ctx.prisma.cartItem.create({ data: { cartId: retry.id, catalogProductId: shop.catalogProductId, quantity: 10, indicativePrice: 2500 } });
    await as(shop.user.accessToken).post('/checkout', { addressId: shop.addressId, idempotencyKey: randomUUID() }).expect(201);
  });
});

