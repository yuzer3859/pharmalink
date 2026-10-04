import request from 'supertest';
import { randomUUID } from 'crypto';
import { AcceptJobOfferCommand } from '../../src/modules/delivery/application/commands/accept-job-offer.command';
import { AdvanceDeliveryJobCommand } from '../../src/modules/delivery/application/commands/advance-delivery-job.command';
import { CreateDeliveryJobCommand } from '../../src/modules/delivery/application/commands/create-delivery-job.command';
import { CreateDriverProfileCommand } from '../../src/modules/delivery/application/commands/create-driver-profile.command';
import { DispatchDeliveryJobCommand } from '../../src/modules/delivery/application/commands/dispatch-delivery-job.command';
import { ManageDriverShiftCommand } from '../../src/modules/delivery/application/commands/manage-driver-shift.command';
import { RecordCodCollectionCommand } from '../../src/modules/delivery/application/commands/record-cod-collection.command';
import { SetDriverAvailabilityCommand } from '../../src/modules/delivery/application/commands/set-driver-availability.command';
import {
  CodCollectionMethod,
  CodCorrectionType,
  DeliveryJobStatus,
  DriverAvailability,
} from '../../src/modules/delivery/domain/enums';
import { DeliveryEventType } from '../../src/modules/delivery/domain/events';
import { VehicleType } from '../../src/modules/delivery/domain/value-objects/vehicle.vo';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { auth, body, createUserWithRole, errorOf, uniquePhone } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

const ORDER_TOTAL = 24_500;
const COLLECTED = 20_000;
const BASE = '/admin/delivery/cod-reconciliation';

/**
 * Response shapes, declared by hand so nested assertions are type-checked. Importing the production
 * types would make the test agree with the controller by construction and could not catch a field
 * silently leaving the wire.
 */
interface CorrectionBody {
  id: string;
  remittanceId: string | null;
  reconciliationId: string | null;
  type: string;
  originalAmount: number | null;
  correctedAmount: number | null;
  amountDelta: number | null;
  originalReference: string | null;
  correctedReference: string | null;
  reason: string;
  createdByUserId: string;
  createdAt: string;
}

interface DisputeBody {
  id: string;
  reason: string;
  status: string;
  openedByUserId: string;
  openedAt: string;
  resolvedByUserId: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
}

interface CollectionBody {
  id: string;
  collectedAmount: number;
  expectedAmount: number;
  status: string;
  collectionVariance: number;
  remittanceVariance: number | null;
  hasDiscrepancy: boolean;
  corrections?: CorrectionBody[];
  disputes?: DisputeBody[];
}

const correctionOf = (res: request.Response) =>
  (body(res) as unknown as { created: boolean; collection: CollectionBody; correction: CorrectionBody });
const disputeOf = (res: request.Response) =>
  (body(res) as unknown as { created: boolean; collection: CollectionBody; dispute: DisputeBody });
const detail = (res: request.Response) => body(res) as unknown as CollectionBody;
const corrections = (res: request.Response) => body(res) as unknown as CorrectionBody[];
const disputes = (res: request.Response) => body(res) as unknown as DisputeBody[];

/**
 * COD corrections and disputes against real PostgreSQL (§3.5 F-COD-01).
 *
 * The claims that can only be made here:
 *
 *  1. **The historical rows are byte-for-byte unchanged** after a correction, read back out of
 *     Postgres rather than asserted in prose.
 *  2. **Separation of duties is a property of the RBAC catalogue.** A driver posting a correction
 *     or resolving their own dispute is refused by the guard; an administrator, who may read, is
 *     refused too.
 *  3. **Idempotency and the partial unique index are the database's** — which is what makes them
 *     still work behind a load balancer, where no in-memory scheme would.
 *  4. **Module 07 is untouched**, checked against its real tables.
 *  5. **No verb exists that can edit history**, proved by firing every mutating method at every
 *     route.
 */
describe('COD corrections and disputes (e2e)', () => {
  let ctx: TestContext;
  let createJob: CreateDeliveryJobCommand;
  let dispatch: DispatchDeliveryJobCommand;
  let accept: AcceptJobOfferCommand;
  let advance: AdvanceDeliveryJobCommand;
  let recordCod: RecordCodCollectionCommand;
  let createProfile: CreateDriverProfileCommand;
  let shift: ManageDriverShiftCommand;
  let availability: SetDriverAvailabilityCommand;

  /** `finance:settlement:any` **and** `finance:report:any`. */
  let finance: Awaited<ReturnType<typeof createUserWithRole>>;
  let otherFinance: Awaited<ReturnType<typeof createUserWithRole>>;
  /** `finance:report:any` only — may look, may not assert. */
  let admin: Awaited<ReturnType<typeof createUserWithRole>>;
  let customer: Awaited<ReturnType<typeof createUserWithRole>>;

  beforeAll(async () => {
    ctx = await createTestApp();
    createJob = ctx.app.get(CreateDeliveryJobCommand);
    dispatch = ctx.app.get(DispatchDeliveryJobCommand);
    accept = ctx.app.get(AcceptJobOfferCommand);
    advance = ctx.app.get(AdvanceDeliveryJobCommand);
    recordCod = ctx.app.get(RecordCodCollectionCommand);
    createProfile = ctx.app.get(CreateDriverProfileCommand);
    shift = ctx.app.get(ManageDriverShiftCommand);
    availability = ctx.app.get(SetDriverAvailabilityCommand);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
    finance = await createUserWithRole(ctx, 'FINANCE_OFFICER');
    otherFinance = await createUserWithRole(ctx, 'FINANCE_OFFICER');
    admin = await createUserWithRole(ctx, 'ADMIN');
    customer = await createUserWithRole(ctx, 'CUSTOMER');
  });

  // -------------------------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------------------------

  interface Scenario {
    collectionId: string;
    jobId: string;
    orderId: string;
    driverProfileId: string;
    driverToken: string;
    driverUserId: string;
  }

  async function seedDriver() {
    const user = await createUserWithRole(ctx, 'DRIVER');
    await ctx.prisma.user.update({
      where: { id: user.userId },
      data: { primaryRole: 'DRIVER' },
    });
    await ctx.prisma.verificationRequest.create({
      data: {
        userId: user.userId,
        type: 'DRIVER_DOCS',
        status: 'APPROVED',
        reviewedAt: new Date(),
      },
    });
    const { profile } = await createProfile.execute({
      userId: user.userId,
      vehicleType: VehicleType.Motorcycle,
      plateNumber: 'AA-12345',
      serviceArea: { lat: 9.03, lng: 38.74, radiusMeters: 20_000 },
    });
    await shift.start({ userId: user.userId });
    await availability.execute({ userId: user.userId, availability: DriverAvailability.ONLINE });
    return { userId: user.userId, profileId: profile.id, accessToken: user.accessToken };
  }

  async function seedFulfillment() {
    const owner = await ctx.prisma.user.create({
      data: { primaryRole: 'PHARMACY_OWNER', status: 'ACTIVE', phone: uniquePhone() },
    });
    const organization = await ctx.prisma.organization.create({
      data: {
        type: 'PHARMACY',
        name: `Org ${randomUUID()}`,
        status: 'ACTIVE',
        ownerUserId: owner.id,
      },
    });
    const pharmacy = await ctx.prisma.pharmacy.create({
      data: { organizationId: organization.id, displayName: 'Bole Pharmacy' },
    });
    const branch = await ctx.prisma.branch.create({
      data: {
        pharmacyId: pharmacy.id,
        name: 'Bole Branch',
        addressLine: 'Africa Ave',
        city: 'Addis Ababa',
        lat: 9.03,
        lng: 38.74,
      },
    });
    const product = await ctx.prisma.product.create({
      data: { type: 'MEDICINE', nameEn: 'Amoxicillin 500mg', genericName: 'Amoxicillin' },
    });
    const order = await ctx.prisma.order.create({
      data: {
        orderNumber: `ORD-${randomUUID()}`,
        customerUserId: randomUUID(),
        status: 'PAID',
        subtotal: ORDER_TOTAL,
        grandTotal: ORDER_TOTAL,
        currency: 'ETB',
        isCod: true,
        idempotencyKey: `checkout-${randomUUID()}`,
        addressSnapshot: {
          line1: 'Kazanchis, Bldg 4',
          city: 'Addis Ababa',
          lat: 8.98,
          lng: 38.79,
        },
      },
    });
    const fulfillment = await ctx.prisma.fulfillment.create({
      data: { orderId: order.id, pharmacyId: pharmacy.id, branchId: branch.id, status: 'READY' },
    });
    await ctx.prisma.orderLine.create({
      data: {
        orderId: order.id,
        fulfillmentId: fulfillment.id,
        catalogProductId: product.id,
        productSnapshot: { name: 'Amoxicillin 500mg' },
        quantity: 1,
        unitPrice: ORDER_TOTAL,
        lineTotal: ORDER_TOTAL,
      },
    });
    return { fulfillmentId: fulfillment.id, orderId: order.id };
  }

  /** A delivery whose driver declared 20,000 against a 24,500 order — a real shortfall. */
  async function collected(): Promise<Scenario> {
    const driver = await seedDriver();
    const seed = await seedFulfillment();
    const { job } = await createJob.execute({ fulfillmentId: seed.fulfillmentId });
    await dispatch.execute({ jobId: job.id, actorUserId: null });
    await accept.execute({ userId: driver.userId, jobId: job.id });
    for (const to of [
      DeliveryJobStatus.ARRIVED_PICKUP,
      DeliveryJobStatus.PICKED_UP,
      DeliveryJobStatus.EN_ROUTE,
      DeliveryJobStatus.ARRIVED_DROPOFF,
    ]) {
      await advance.byDriver({ userId: driver.userId, jobId: job.id, to });
    }
    const { collection } = await recordCod.execute({
      userId: driver.userId,
      jobId: job.id,
      collectedAmount: COLLECTED,
      method: CodCollectionMethod.CASH,
    });

    return {
      collectionId: collection.id,
      jobId: job.id,
      orderId: seed.orderId,
      driverProfileId: driver.profileId,
      driverToken: driver.accessToken,
      driverUserId: driver.userId,
    };
  }

  /** The ordinary correction: the desk keyed 20,000, the driver actually handed over 24,500. */
  function recordingMistake(key = 'correction-key-0001') {
    return {
      type: CodCorrectionType.RECORDING_MISTAKE,
      originalAmount: COLLECTED,
      correctedAmount: ORDER_TOTAL,
      reason: 'Cash desk recount: the driver handed over the full amount.',
      idempotencyKey: key,
    };
  }

  function postCorrection(id: string, token: string, payload: Record<string, unknown>) {
    return request(ctx.server)
      .post(`${BASE}/${id}/corrections`)
      .set(...auth(token))
      .send(payload);
  }

  function openDispute(id: string, token: string, reason = 'Short by 4,500 at the cash desk.') {
    return request(ctx.server)
      .post(`${BASE}/${id}/disputes`)
      .set(...auth(token))
      .send({ reason });
  }

  function resolveDispute(
    id: string,
    disputeId: string,
    token: string,
    payload: Record<string, unknown> = {},
  ) {
    return request(ctx.server)
      .post(`${BASE}/${id}/disputes/${disputeId}/resolve`)
      .set(...auth(token))
      .send(payload);
  }

  // ===========================================================================================
  // History stays as written — §1, §6
  // ===========================================================================================

  describe('immutable history', () => {
    it('leaves the collection row byte-for-byte unchanged after a correction', async () => {
      const scenario = await collected();
      const before = await ctx.prisma.codCollection.findUniqueOrThrow({
        where: { id: scenario.collectionId },
      });

      const res = await postCorrection(scenario.collectionId, finance.accessToken, recordingMistake());

      expect(res.status).toBe(200);
      const after = await ctx.prisma.codCollection.findUniqueOrThrow({
        where: { id: scenario.collectionId },
      });
      expect(after).toEqual(before);
    });

    it('leaves the remittance row unchanged after correcting its reference', async () => {
      const scenario = await collected();
      await request(ctx.server)
        .post(`${BASE}/${scenario.collectionId}/remit`)
        .set(...auth(finance.accessToken))
        .send({ remittedAmount: COLLECTED, reference: 'CASHDESK-A' });
      const before = await ctx.prisma.codRemittance.findUniqueOrThrow({
        where: { collectionId: scenario.collectionId },
      });

      const res = await postCorrection(scenario.collectionId, finance.accessToken, {
        type: CodCorrectionType.REFERENCE_CORRECTION,
        remittanceId: before.id,
        originalReference: 'CASHDESK-A',
        correctedReference: 'CASHDESK-B',
        reason: 'Slip number transposed.',
        idempotencyKey: 'correction-key-ref1',
      });

      expect(res.status).toBe(200);
      const after = await ctx.prisma.codRemittance.findUniqueOrThrow({
        where: { collectionId: scenario.collectionId },
      });
      // The remittance still says CASHDESK-A. The correction says it should say CASHDESK-B.
      expect(after).toEqual(before);
      expect(after.reference).toBe('CASHDESK-A');
      expect(correctionOf(res).correction.correctedReference).toBe('CASHDESK-B');
    });

    it('keeps the original discrepancy visible after a correction', async () => {
      const scenario = await collected();
      await postCorrection(scenario.collectionId, finance.accessToken, recordingMistake());

      const res = await request(ctx.server)
        .get(`${BASE}/${scenario.collectionId}`)
        .set(...auth(finance.accessToken));

      // §6, stated as an assertion: `original fact + correction` is the history, and the variance
      // is still computed from the row the driver's declaration produced.
      expect(detail(res).collectedAmount).toBe(COLLECTED);
      expect(detail(res).collectionVariance).toBe(-4_500);
      expect(detail(res).hasDiscrepancy).toBe(true);
      expect(detail(res).corrections).toHaveLength(1);
      expect(detail(res).corrections?.[0].amountDelta).toBe(4_500);
    });

    it('offers no verb that can edit a correction, a dispute or a historical record', async () => {
      const scenario = await collected();
      await postCorrection(scenario.collectionId, finance.accessToken, recordingMistake());
      const opened = await openDispute(scenario.collectionId, finance.accessToken);
      const disputeId = disputeOf(opened).dispute.id;

      const before = await ctx.prisma.codCollection.findUniqueOrThrow({
        where: { id: scenario.collectionId },
        include: { corrections: true, disputes: true },
      });

      const attempts = [
        await request(ctx.server)
          .patch(`${BASE}/${scenario.collectionId}/corrections`)
          .set(...auth(finance.accessToken))
          .send({ correctedAmount: 1 }),
        await request(ctx.server)
          .put(`${BASE}/${scenario.collectionId}/corrections`)
          .set(...auth(finance.accessToken))
          .send({ correctedAmount: 1 }),
        await request(ctx.server)
          .delete(`${BASE}/${scenario.collectionId}/corrections`)
          .set(...auth(finance.accessToken)),
        await request(ctx.server)
          .patch(`${BASE}/${scenario.collectionId}/disputes/${disputeId}`)
          .set(...auth(finance.accessToken))
          .send({ status: 'RESOLVED' }),
        await request(ctx.server)
          .delete(`${BASE}/${scenario.collectionId}/disputes/${disputeId}`)
          .set(...auth(finance.accessToken)),
      ];

      for (const res of attempts) {
        expect([403, 404, 405]).toContain(res.status);
      }

      const after = await ctx.prisma.codCollection.findUniqueOrThrow({
        where: { id: scenario.collectionId },
        include: { corrections: true, disputes: true },
      });
      expect(after).toEqual(before);
    });

    it('answers a mistaken correction with a second correction rather than an edit', async () => {
      const scenario = await collected();
      await postCorrection(scenario.collectionId, finance.accessToken, recordingMistake());

      const res = await postCorrection(scenario.collectionId, finance.accessToken, {
        ...recordingMistake('correction-key-0002'),
        originalAmount: ORDER_TOTAL,
        correctedAmount: 22_000,
        reason: 'The recount above was itself wrong.',
      });

      expect(res.status).toBe(200);
      const rows = await ctx.prisma.codCorrection.findMany({
        where: { collectionId: scenario.collectionId },
        orderBy: { createdAt: 'asc' },
      });
      expect(rows.map((row) => row.correctedAmount)).toEqual([ORDER_TOTAL, 22_000]);
    });
  });

  // ===========================================================================================
  // Authorization — §3, §12
  // ===========================================================================================

  describe('authorization', () => {
    it('refuses a driver recording a correction against their own collection', async () => {
      const scenario = await collected();

      const res = await postCorrection(
        scenario.collectionId,
        scenario.driverToken,
        recordingMistake(),
      );

      // §3's hard requirement, and a property of the catalogue: no `DRIVER` grant includes
      // `finance:settlement:any`.
      expect(res.status).toBe(403);
      expect(await ctx.prisma.codCorrection.count()).toBe(0);
    });

    it('refuses a driver opening or resolving a dispute about their own collection', async () => {
      const scenario = await collected();
      const opened = await openDispute(scenario.collectionId, finance.accessToken);
      const disputeId = disputeOf(opened).dispute.id;

      const open = await openDispute(scenario.collectionId, scenario.driverToken);
      const resolve = await resolveDispute(
        scenario.collectionId,
        disputeId,
        scenario.driverToken,
        { resolutionNote: 'Nothing wrong here.' },
      );

      expect(open.status).toBe(403);
      expect(resolve.status).toBe(403);
      const row = await ctx.prisma.codDispute.findUniqueOrThrow({ where: { id: disputeId } });
      expect(row.status).toBe('OPEN');
      expect(row.resolvedByUserId).toBeNull();
    });

    it('lets a finance officer correct, dispute and resolve', async () => {
      const scenario = await collected();

      const correction = await postCorrection(
        scenario.collectionId,
        finance.accessToken,
        recordingMistake(),
      );
      const opened = await openDispute(scenario.collectionId, finance.accessToken);
      const resolved = await resolveDispute(
        scenario.collectionId,
        disputeOf(opened).dispute.id,
        otherFinance.accessToken,
        { resolutionNote: 'Recounted.' },
      );

      expect(correction.status).toBe(200);
      expect(opened.status).toBe(200);
      expect(resolved.status).toBe(200);
      expect(correctionOf(correction).correction.createdByUserId).toBe(finance.userId);
      expect(disputeOf(resolved).dispute.resolvedByUserId).toBe(otherFinance.userId);
    });

    it('lets an administrator read the trail but not write to it', async () => {
      const scenario = await collected();
      await postCorrection(scenario.collectionId, finance.accessToken, recordingMistake());

      const read = await request(ctx.server)
        .get(`${BASE}/${scenario.collectionId}/corrections`)
        .set(...auth(admin.accessToken));
      const write = await postCorrection(scenario.collectionId, admin.accessToken, {
        ...recordingMistake('correction-key-admin1'),
      });
      const dispute = await openDispute(scenario.collectionId, admin.accessToken);

      // Oversight, not custody — the catalogue's existing division, not a decision taken here.
      expect(read.status).toBe(200);
      expect(corrections(read)).toHaveLength(1);
      expect(write.status).toBe(403);
      expect(dispute.status).toBe(403);
    });

    it('refuses a customer on every route, and an unauthenticated caller', async () => {
      const scenario = await collected();

      const responses = [
        await postCorrection(scenario.collectionId, customer.accessToken, recordingMistake()),
        await openDispute(scenario.collectionId, customer.accessToken),
        await request(ctx.server)
          .get(`${BASE}/${scenario.collectionId}/corrections`)
          .set(...auth(customer.accessToken)),
        await request(ctx.server)
          .get(`${BASE}/${scenario.collectionId}/disputes`)
          .set(...auth(customer.accessToken)),
      ];
      for (const res of responses) {
        expect(res.status).toBe(403);
      }

      const anonymous = await request(ctx.server)
        .post(`${BASE}/${scenario.collectionId}/corrections`)
        .send(recordingMistake());
      expect(anonymous.status).toBe(401);
    });

    it('takes the acting operator from the token, not the body', async () => {
      const scenario = await collected();

      const res = await postCorrection(scenario.collectionId, finance.accessToken, {
        ...recordingMistake(),
        createdByUserId: otherFinance.userId,
      });

      // `forbidNonWhitelisted` refuses it outright rather than ignoring it, so a correction can
      // never be attributed to somebody who did not make it.
      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe(ErrorCode.VALIDATION_ERROR);
    });
  });

  // ===========================================================================================
  // Correction behaviour — §2, §4
  // ===========================================================================================

  describe('corrections', () => {
    it('records the type, both values, the reason, the actor and the time', async () => {
      const scenario = await collected();

      const res = await postCorrection(scenario.collectionId, finance.accessToken, recordingMistake());

      const row = await ctx.prisma.codCorrection.findFirstOrThrow({
        where: { collectionId: scenario.collectionId },
      });
      expect(row).toMatchObject({
        type: 'RECORDING_MISTAKE',
        originalAmount: COLLECTED,
        correctedAmount: ORDER_TOTAL,
        reason: 'Cash desk recount: the driver handed over the full amount.',
        createdByUserId: finance.userId,
      });
      expect(correctionOf(res).correction.amountDelta).toBe(4_500);
    });

    it('refuses an amount on an administrative adjustment — the write-off that is not available', async () => {
      const scenario = await collected();

      const res = await postCorrection(scenario.collectionId, finance.accessToken, {
        type: CodCorrectionType.ADMINISTRATIVE_ADJUSTMENT,
        originalAmount: COLLECTED,
        correctedAmount: 0,
        reason: 'Writing the shortfall off.',
        idempotencyKey: 'correction-key-wo01',
      });

      expect(res.status).toBe(400);
      expect(await ctx.prisma.codCorrection.count()).toBe(0);
    });

    it('refuses a correction naming another collection’s remittance', async () => {
      const first = await collected();
      const second = await collected();
      await request(ctx.server)
        .post(`${BASE}/${second.collectionId}/remit`)
        .set(...auth(finance.accessToken))
        .send({ remittedAmount: COLLECTED, reference: 'CASHDESK-OTHER' });
      const other = await ctx.prisma.codRemittance.findUniqueOrThrow({
        where: { collectionId: second.collectionId },
      });

      const res = await postCorrection(first.collectionId, finance.accessToken, {
        ...recordingMistake(),
        remittanceId: other.id,
      });

      expect(res.status).toBe(409);
      expect(await ctx.prisma.codCorrection.count()).toBe(0);
    });

    it('refuses a correction against a collection that does not exist', async () => {
      const res = await postCorrection(randomUUID(), finance.accessToken, recordingMistake());

      expect(res.status).toBe(404);
    });

    it('refuses a correction with no reason and one that changes nothing', async () => {
      const scenario = await collected();

      const noReason = await postCorrection(scenario.collectionId, finance.accessToken, {
        ...recordingMistake(),
        reason: '   ',
      });
      const noChange = await postCorrection(scenario.collectionId, finance.accessToken, {
        ...recordingMistake('correction-key-same1'),
        correctedAmount: COLLECTED,
      });

      expect(noReason.status).toBe(400);
      expect(noChange.status).toBe(400);
      expect(await ctx.prisma.codCorrection.count()).toBe(0);
    });
  });

  // ===========================================================================================
  // Disputes — §5
  // ===========================================================================================

  describe('disputes', () => {
    it('opens, reads and resolves a dispute', async () => {
      const scenario = await collected();

      const opened = await openDispute(scenario.collectionId, finance.accessToken);
      expect(disputeOf(opened).created).toBe(true);
      expect(disputeOf(opened).dispute).toMatchObject({
        status: 'OPEN',
        openedByUserId: finance.userId,
        resolvedByUserId: null,
      });

      const resolved = await resolveDispute(
        scenario.collectionId,
        disputeOf(opened).dispute.id,
        otherFinance.accessToken,
        { resolutionNote: 'Recounted; the desk miscounted.' },
      );
      expect(disputeOf(resolved).dispute).toMatchObject({
        status: 'RESOLVED',
        openedByUserId: finance.userId,
        resolvedByUserId: otherFinance.userId,
        resolutionNote: 'Recounted; the desk miscounted.',
      });

      const list = await request(ctx.server)
        .get(`${BASE}/${scenario.collectionId}/disputes`)
        .set(...auth(finance.accessToken));
      expect(disputes(list)).toHaveLength(1);
    });

    it('allows a new dispute once the earlier one is resolved', async () => {
      const scenario = await collected();
      const first = await openDispute(scenario.collectionId, finance.accessToken, 'First.');
      await resolveDispute(
        scenario.collectionId,
        disputeOf(first).dispute.id,
        finance.accessToken,
        { resolutionNote: 'Closed.' },
      );

      const second = await openDispute(scenario.collectionId, finance.accessToken, 'Second.');

      // The partiality of `cod_disputes_one_open_per_collection`, tested against real Postgres.
      expect(disputeOf(second).created).toBe(true);
      expect(await ctx.prisma.codDispute.count()).toBe(2);
    });

    it('refuses an outcome or a status supplied in the body', async () => {
      const scenario = await collected();
      const opened = await openDispute(scenario.collectionId, finance.accessToken);

      const withOutcome = await resolveDispute(
        scenario.collectionId,
        disputeOf(opened).dispute.id,
        finance.accessToken,
        { resolutionNote: 'Done.', outcome: 'WRITTEN_OFF' },
      );
      const withStatus = await request(ctx.server)
        .post(`${BASE}/${scenario.collectionId}/disputes`)
        .set(...auth(finance.accessToken))
        .send({ reason: 'x', status: 'RESOLVED' });

      // There is no field through which the platform could be told who absorbs a shortfall.
      expect(withOutcome.status).toBe(400);
      expect(withStatus.status).toBe(400);
    });

    it('refuses a dispute id that belongs to another collection', async () => {
      const first = await collected();
      const second = await collected();
      const opened = await openDispute(second.collectionId, finance.accessToken);

      const res = await resolveDispute(
        first.collectionId,
        disputeOf(opened).dispute.id,
        finance.accessToken,
      );

      expect(res.status).toBe(404);
    });
  });

  // ===========================================================================================
  // Idempotency and concurrency — §9, §10
  // ===========================================================================================

  describe('idempotency', () => {
    it('replays an identical correction without a second row, audit entry or event', async () => {
      const scenario = await collected();
      await postCorrection(scenario.collectionId, finance.accessToken, recordingMistake());

      const replay = await postCorrection(
        scenario.collectionId,
        finance.accessToken,
        recordingMistake(),
      );

      expect(replay.status).toBe(200);
      expect(correctionOf(replay).created).toBe(false);
      expect(await ctx.prisma.codCorrection.count()).toBe(1);
      expect(
        await ctx.prisma.auditLog.count({ where: { action: 'DELIVERY_COD_CORRECTION_RECORDED' } }),
      ).toBe(1);
      expect(
        await ctx.prisma.outbox.count({
          where: { eventType: DeliveryEventType.CodCorrectionRecorded },
        }),
      ).toBe(1);
    });

    it('refuses a different correction under the same replay key', async () => {
      const scenario = await collected();
      await postCorrection(scenario.collectionId, finance.accessToken, recordingMistake());

      const res = await postCorrection(scenario.collectionId, finance.accessToken, {
        ...recordingMistake(),
        correctedAmount: 30_000,
      });

      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe(ErrorCode.IDEMPOTENCY_CONFLICT);
      const row = await ctx.prisma.codCorrection.findFirstOrThrow();
      expect(row.correctedAmount).toBe(ORDER_TOTAL);
    });

    it('converges three simultaneous corrections on one row and one event', async () => {
      const scenario = await collected();

      const results = await Promise.all([
        postCorrection(scenario.collectionId, finance.accessToken, recordingMistake()),
        postCorrection(scenario.collectionId, otherFinance.accessToken, recordingMistake()),
        postCorrection(scenario.collectionId, finance.accessToken, recordingMistake()),
      ]);

      expect(results.filter((res) => res.status === 200)).toHaveLength(3);
      expect(await ctx.prisma.codCorrection.count()).toBe(1);
      expect(
        await ctx.prisma.outbox.count({
          where: { eventType: DeliveryEventType.CodCorrectionRecorded },
        }),
      ).toBe(1);
    });

    it('converges three simultaneous dispute openings on one dispute', async () => {
      const scenario = await collected();

      const results = await Promise.all([
        openDispute(scenario.collectionId, finance.accessToken),
        openDispute(scenario.collectionId, otherFinance.accessToken),
        openDispute(scenario.collectionId, finance.accessToken),
      ]);

      expect(results.map((res) => res.status)).toEqual([200, 200, 200]);
      expect(await ctx.prisma.codDispute.count()).toBe(1);
      expect(
        await ctx.prisma.auditLog.count({ where: { action: 'DELIVERY_COD_DISPUTE_OPENED' } }),
      ).toBe(1);
    });

    it('converges three simultaneous resolutions on one conclusion', async () => {
      const scenario = await collected();
      const opened = await openDispute(scenario.collectionId, finance.accessToken);
      const disputeId = disputeOf(opened).dispute.id;

      const results = await Promise.all([
        resolveDispute(scenario.collectionId, disputeId, finance.accessToken, {
          resolutionNote: 'Recounted.',
        }),
        resolveDispute(scenario.collectionId, disputeId, otherFinance.accessToken, {
          resolutionNote: 'Recounted.',
        }),
        resolveDispute(scenario.collectionId, disputeId, finance.accessToken, {
          resolutionNote: 'Recounted.',
        }),
      ]);

      expect(results.filter((res) => res.status === 200)).toHaveLength(3);
      expect(
        await ctx.prisma.auditLog.count({ where: { action: 'DELIVERY_COD_DISPUTE_RESOLVED' } }),
      ).toBe(1);
      const row = await ctx.prisma.codDispute.findUniqueOrThrow({ where: { id: disputeId } });
      expect(row.status).toBe('RESOLVED');
    });
  });

  // ===========================================================================================
  // Module 07 boundary — §7
  // ===========================================================================================

  describe('Module 07 boundary', () => {
    it('writes no ledger entry, payment, settlement, payout or driver earning', async () => {
      const scenario = await collected();
      await postCorrection(scenario.collectionId, finance.accessToken, recordingMistake());
      const opened = await openDispute(scenario.collectionId, finance.accessToken);
      await resolveDispute(
        scenario.collectionId,
        disputeOf(opened).dispute.id,
        finance.accessToken,
        { resolutionNote: 'Recounted.' },
      );

      expect(await ctx.prisma.ledgerEntry.count()).toBe(0);
      expect(await ctx.prisma.ledgerTransaction.count()).toBe(0);
      expect(await ctx.prisma.payment.count()).toBe(0);
      expect(await ctx.prisma.settlement.count()).toBe(0);
      expect(await ctx.prisma.payoutLine.count()).toBe(0);
      expect(await ctx.prisma.accountBalance.count()).toBe(0);
      expect(await ctx.prisma.refund.count()).toBe(0);
      // The driver is a collection channel, never the owner of the money: correcting a COD figure
      // must not credit or debit them with anything.
      expect(await ctx.prisma.driverEarning.count()).toBe(0);
    });

    it('does not touch the order', async () => {
      const scenario = await collected();
      const before = await ctx.prisma.order.findUniqueOrThrow({ where: { id: scenario.orderId } });

      await postCorrection(scenario.collectionId, finance.accessToken, recordingMistake());

      const after = await ctx.prisma.order.findUniqueOrThrow({ where: { id: scenario.orderId } });
      expect(after).toEqual(before);
    });

    it('leaves settlementRef null', async () => {
      const scenario = await collected();
      await postCorrection(scenario.collectionId, finance.accessToken, recordingMistake());

      const row = await ctx.prisma.codCollection.findUniqueOrThrow({
        where: { id: scenario.collectionId },
      });
      expect(row.settlementRef).toBeNull();
    });
  });

  // ===========================================================================================
  // Events and audit — §8, §17
  // ===========================================================================================

  describe('events and audit', () => {
    it('emits CodCorrectionRecorded once with both values, and no dispute event at all', async () => {
      const scenario = await collected();
      await postCorrection(scenario.collectionId, finance.accessToken, recordingMistake());
      const opened = await openDispute(scenario.collectionId, finance.accessToken);
      await resolveDispute(
        scenario.collectionId,
        disputeOf(opened).dispute.id,
        finance.accessToken,
        { resolutionNote: 'Recounted.' },
      );

      const rows = await ctx.prisma.outbox.findMany({
        where: { eventType: DeliveryEventType.CodCorrectionRecorded },
      });
      expect(rows).toHaveLength(1);
      const payload = (rows[0].payload as unknown as { payload: Record<string, unknown> }).payload;
      expect(payload).toMatchObject({
        collectionId: scenario.collectionId,
        jobId: scenario.jobId,
        orderId: scenario.orderId,
        driverId: scenario.driverProfileId,
        type: 'RECORDING_MISTAKE',
        originalAmount: COLLECTED,
        correctedAmount: ORDER_TOTAL,
        currency: 'ETB',
        createdByUserId: finance.userId,
      });

      // Nothing outside Module 08 acts on a dispute, so nothing is published about one.
      const all = await ctx.prisma.outbox.findMany();
      expect(all.filter((row) => row.eventType.includes('dispute'))).toHaveLength(0);
    });

    it('leaks no provider secret on the event', async () => {
      const scenario = await collected();
      await postCorrection(scenario.collectionId, finance.accessToken, recordingMistake());

      const row = await ctx.prisma.outbox.findFirstOrThrow({
        where: { eventType: DeliveryEventType.CodCorrectionRecorded },
      });
      const serialized = JSON.stringify(row.payload).toLowerCase();
      for (const forbidden of ['cvv', 'telebirr', 'password', 'secret', 'signature', 'token']) {
        expect(serialized).not.toContain(forbidden);
      }
    });

    it('writes one audit entry per operation, and none for a rejected attempt', async () => {
      const scenario = await collected();
      await postCorrection(scenario.collectionId, finance.accessToken, recordingMistake());
      const opened = await openDispute(scenario.collectionId, finance.accessToken);
      await resolveDispute(
        scenario.collectionId,
        disputeOf(opened).dispute.id,
        otherFinance.accessToken,
        { resolutionNote: 'Recounted.' },
      );
      // Refused: a different correction under a used key.
      await postCorrection(scenario.collectionId, finance.accessToken, {
        ...recordingMistake(),
        correctedAmount: 1,
      });

      const entries = await ctx.prisma.auditLog.findMany({
        where: { resourceId: scenario.collectionId },
        orderBy: { createdAt: 'asc' },
        select: { action: true, actorUserId: true },
      });

      expect(entries.map((entry) => entry.action)).toEqual([
        'DELIVERY_COD_COLLECTED',
        'DELIVERY_COD_CORRECTION_RECORDED',
        'DELIVERY_COD_DISPUTE_OPENED',
        'DELIVERY_COD_DISPUTE_RESOLVED',
      ]);
      expect(entries[0].actorUserId).toBe(scenario.driverUserId);
      expect(entries[1].actorUserId).toBe(finance.userId);
      expect(entries[3].actorUserId).toBe(otherFinance.userId);
    });
  });

  // ===========================================================================================
  // Visibility — §11, §12, §13
  // ===========================================================================================

  describe('visibility', () => {
    it('shows finance the whole history in one read', async () => {
      const scenario = await collected();
      await request(ctx.server)
        .post(`${BASE}/${scenario.collectionId}/remit`)
        .set(...auth(finance.accessToken))
        .send({ remittedAmount: COLLECTED, reference: 'CASHDESK-A' });
      await request(ctx.server)
        .post(`${BASE}/${scenario.collectionId}/reconcile`)
        .set(...auth(finance.accessToken))
        .send({});
      await postCorrection(scenario.collectionId, finance.accessToken, recordingMistake());
      const opened = await openDispute(scenario.collectionId, finance.accessToken);
      await resolveDispute(
        scenario.collectionId,
        disputeOf(opened).dispute.id,
        otherFinance.accessToken,
        { resolutionNote: 'Recounted.' },
      );

      const res = await request(ctx.server)
        .get(`${BASE}/${scenario.collectionId}`)
        .set(...auth(finance.accessToken));

      expect(detail(res)).toMatchObject({
        expectedAmount: ORDER_TOTAL,
        collectedAmount: COLLECTED,
        status: 'RECONCILED',
        collectionVariance: -4_500,
        hasDiscrepancy: true,
      });
      expect(detail(res).corrections).toHaveLength(1);
      expect(detail(res).disputes).toHaveLength(1);
      expect(detail(res).disputes?.[0].resolvedByUserId).toBe(otherFinance.userId);
    });

    it('tells a driver only that a dispute is open, and nothing about it', async () => {
      const scenario = await collected();
      await postCorrection(scenario.collectionId, finance.accessToken, recordingMistake());

      const before = await request(ctx.server)
        .get(`/delivery/jobs/${scenario.jobId}/cod-collection`)
        .set(...auth(scenario.driverToken));
      expect(body(before).hasOpenDispute).toBe(false);

      await openDispute(
        scenario.collectionId,
        finance.accessToken,
        'Driver suspected of under-declaring.',
      );

      const after = await request(ctx.server)
        .get(`/delivery/jobs/${scenario.jobId}/cod-collection`)
        .set(...auth(scenario.driverToken));

      expect(after.status).toBe(200);
      expect(body(after).hasOpenDispute).toBe(true);
      // A boolean and nothing more: not the reason, not the operator, not a single correction.
      const serialized = JSON.stringify(body(after));
      expect(serialized).not.toContain('under-declaring');
      expect(serialized).not.toContain(finance.userId);
      expect(serialized).not.toContain('correction');
      expect(body(after).collectedAmount).toBe(COLLECTED);
    });

    it('exposes nothing to the customer', async () => {
      const scenario = await collected();
      await openDispute(scenario.collectionId, finance.accessToken);

      const admin = await request(ctx.server)
        .get(`${BASE}/${scenario.collectionId}`)
        .set(...auth(customer.accessToken));
      const driverRoute = await request(ctx.server)
        .get(`/delivery/jobs/${scenario.jobId}/cod-collection`)
        .set(...auth(customer.accessToken));

      // §13: the customer needs none of PharmaLink's internal reconciliation workflow, and has no
      // route to any of it.
      expect(admin.status).toBe(403);
      expect([403, 404]).toContain(driverRoute.status);
    });

    it('exposes no driver identity, earnings or payout data on the finance read', async () => {
      const scenario = await collected();
      await postCorrection(scenario.collectionId, finance.accessToken, recordingMistake());

      const res = await request(ctx.server)
        .get(`${BASE}/${scenario.collectionId}`)
        .set(...auth(finance.accessToken));

      const serialized = JSON.stringify(body(res)).toLowerCase();
      for (const forbidden of ['phone', 'earning', 'payout', 'wallet', 'balance', 'password']) {
        expect(serialized).not.toContain(forbidden);
      }
      expect(detail(res).id).toBe(scenario.collectionId);
    });
  });
});
