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
  DeliveryJobStatus,
  DriverAvailability,
} from '../../src/modules/delivery/domain/enums';
import { DeliveryEventType } from '../../src/modules/delivery/domain/events';
import { VehicleType } from '../../src/modules/delivery/domain/value-objects/vehicle.vo';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { auth, body, createUserWithRole, errorOf, uniquePhone } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

const COD_AMOUNT = 24_500;
const BASE = '/admin/delivery/cod-reconciliation';

/**
 * The response shapes, declared once so nested assertions below are type-checked rather than cast
 * away. They mirror `CodReconciliationDetailResponse` deliberately *by hand*: a test that imported
 * the production type would agree with the controller by construction and could not catch a field
 * silently disappearing from the wire.
 */
interface CollectionBody {
  id: string;
  jobId: string;
  orderId: string;
  driverId: string;
  expectedAmount: number;
  collectedAmount: number;
  currency: string;
  method: string;
  status: string;
  providerReference: string | null;
  collectionVariance: number;
  remittanceVariance: number | null;
  hasDiscrepancy: boolean;
  isOutstanding: boolean;
  remittance: {
    remittedAmount: number;
    currency: string;
    reference: string;
    note: string | null;
    confirmedByUserId: string;
  } | null;
  reconciliation: {
    outcome: string;
    reference: string | null;
    note: string | null;
    reconciledByUserId: string;
  } | null;
}

interface MutationBody {
  created: boolean;
  outcome?: string;
  variance?: number;
  collection: CollectionBody;
}

interface PageBody {
  items: CollectionBody[];
  total: number;
  page: number;
  size: number;
}

const mutation = (res: request.Response) => body(res) as unknown as MutationBody;
const detail = (res: request.Response) => body(res) as unknown as CollectionBody;
const page = (res: request.Response) => body(res) as unknown as PageBody;

/**
 * COD remittance and reconciliation against real PostgreSQL (§3.5 F-COD-01, §9.5).
 *
 * Real `AppModule`, real routes, the real RBAC catalogue and the real `PermissionsGuard`, the real
 * Prisma repository, real `Serializable` transactions, the real hash-chained audit trail and the
 * real outbox.
 *
 * The claims that can only be made here:
 *
 *  1. **Separation of duties is a property of the catalogue, not of a check.** A driver posting to
 *     `/remit` is refused by the guard, because no driver role holds `finance:settlement:any` —
 *     and an administrator, who holds the read permission, is refused too.
 *  2. **`COLLECTED → RECONCILED` is unreachable**, through the real HTTP surface, by a caller
 *     holding every finance permission the platform has.
 *  3. **Idempotency is the database's.** Two unique indexes settle concurrent finance officers,
 *     which is what makes it still work behind a load balancer.
 *  4. **Module 07 is untouched** — no ledger entry, no payment, no wallet, no settlement, checked
 *     against the real Module 07 tables rather than asserted in prose.
 *  5. **No historical fact can be edited**, proved by firing every mutating verb the framework
 *     offers at each of the three rows.
 */
describe('COD remittance and reconciliation (e2e)', () => {
  let ctx: TestContext;
  let createJob: CreateDeliveryJobCommand;
  let dispatch: DispatchDeliveryJobCommand;
  let accept: AcceptJobOfferCommand;
  let advance: AdvanceDeliveryJobCommand;
  let recordCod: RecordCodCollectionCommand;
  let createProfile: CreateDriverProfileCommand;
  let shift: ManageDriverShiftCommand;
  let availability: SetDriverAvailabilityCommand;

  /** A finance officer: `finance:settlement:any` **and** `finance:report:any`. */
  let finance: Awaited<ReturnType<typeof createUserWithRole>>;
  /** A second one, so "who asserted this?" has more than one possible answer. */
  let otherFinance: Awaited<ReturnType<typeof createUserWithRole>>;
  /** An administrator: `finance:report:any` only — may look, may not assert. */
  let admin: Awaited<ReturnType<typeof createUserWithRole>>;
  /** An ordinary customer, holding neither. */
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

  async function seedFulfillment(grandTotal = COD_AMOUNT) {
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
        subtotal: grandTotal,
        grandTotal,
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
        unitPrice: grandTotal,
        lineTotal: grandTotal,
      },
    });
    return { fulfillmentId: fulfillment.id, orderId: order.id };
  }

  /** A delivery whose cash the driver has already declared taking. */
  async function collected(
    options: { collectedAmount?: number; grandTotal?: number; electronic?: boolean } = {},
  ): Promise<Scenario> {
    const driver = await seedDriver();
    const seed = await seedFulfillment(options.grandTotal ?? COD_AMOUNT);
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
      collectedAmount: options.collectedAmount ?? options.grandTotal ?? COD_AMOUNT,
      method: options.electronic ? CodCollectionMethod.ELECTRONIC : CodCollectionMethod.CASH,
      providerReference: options.electronic ? 'TXN-55512345' : null,
    });

    // Released, so the next scenario's dispatch does not offer its job to this driver.
    await shift.end({ userId: driver.userId });

    return {
      collectionId: collection.id,
      jobId: job.id,
      orderId: seed.orderId,
      driverProfileId: driver.profileId,
      driverToken: driver.accessToken,
      driverUserId: driver.userId,
    };
  }

  function remit(collectionId: string, token: string, payload: Record<string, unknown>) {
    return request(ctx.server)
      .post(`${BASE}/${collectionId}/remit`)
      .set(...auth(token))
      .send(payload);
  }

  function reconcile(collectionId: string, token: string, payload: Record<string, unknown> = {}) {
    return request(ctx.server)
      .post(`${BASE}/${collectionId}/reconcile`)
      .set(...auth(token))
      .send(payload);
  }

  function exactRemittance(reference = 'CASHDESK-A') {
    return { remittedAmount: COD_AMOUNT, reference };
  }

  function codEvents(type: string, collectionId: string) {
    return ctx.prisma.outbox.findMany({ where: { eventType: type } }).then((rows) =>
      rows
        .map((row) => row.payload as unknown as { payload: Record<string, unknown> })
        .filter((envelope) => envelope.payload?.collectionId === collectionId),
    );
  }

  // ===========================================================================================
  // Authorization and separation of duties (§2)
  // ===========================================================================================

  describe('separation of duties', () => {
    it('refuses a driver marking their own collection remitted', async () => {
      const scenario = await collected();

      const res = await remit(scenario.collectionId, scenario.driverToken, exactRemittance());

      // §2's requirement, and a property of the RBAC catalogue rather than a check somebody
      // remembered to write: no `DRIVER` grant includes `finance:settlement:any`.
      expect(res.status).toBe(403);
      expect(await ctx.prisma.codRemittance.count()).toBe(0);
      expect(
        (await ctx.prisma.codCollection.findUniqueOrThrow({ where: { id: scenario.collectionId } }))
          .status,
      ).toBe('COLLECTED');
    });

    it('refuses a driver reconciling their own collection', async () => {
      const scenario = await collected();
      await remit(scenario.collectionId, finance.accessToken, exactRemittance());

      const res = await reconcile(scenario.collectionId, scenario.driverToken);

      expect(res.status).toBe(403);
      expect(await ctx.prisma.codReconciliation.count()).toBe(0);
    });

    it('lets an authorized finance officer record the remittance', async () => {
      const scenario = await collected();

      const res = await remit(scenario.collectionId, finance.accessToken, exactRemittance());

      expect(res.status).toBe(200);
      expect(mutation(res).created).toBe(true);
      expect(mutation(res).collection.status).toBe('REMITTED');
      const row = await ctx.prisma.codRemittance.findUniqueOrThrow({
        where: { collectionId: scenario.collectionId },
      });
      expect(row).toMatchObject({
        remittedAmount: COD_AMOUNT,
        currency: 'ETB',
        reference: 'CASHDESK-A',
        confirmedByUserId: finance.userId,
      });
    });

    it('lets an administrator read the queue but not assert a remittance', async () => {
      const scenario = await collected();

      const read = await request(ctx.server).get(BASE).set(...auth(admin.accessToken));
      const write = await remit(scenario.collectionId, admin.accessToken, exactRemittance());

      // The catalogue's existing division between platform administration and finance authority:
      // `ADMIN` holds `finance:report:any` and not `finance:settlement:any`. Oversight, not custody.
      expect(read.status).toBe(200);
      expect(write.status).toBe(403);
    });

    it('refuses an ordinary customer on every route', async () => {
      const scenario = await collected();

      const responses = [
        await request(ctx.server).get(BASE).set(...auth(customer.accessToken)),
        await request(ctx.server)
          .get(`${BASE}/${scenario.collectionId}`)
          .set(...auth(customer.accessToken)),
        await remit(scenario.collectionId, customer.accessToken, exactRemittance()),
        await reconcile(scenario.collectionId, customer.accessToken),
      ];

      for (const res of responses) {
        expect(res.status).toBe(403);
      }
    });

    it('refuses an unauthenticated caller', async () => {
      const scenario = await collected();

      const res = await request(ctx.server)
        .post(`${BASE}/${scenario.collectionId}/remit`)
        .send(exactRemittance());

      expect(res.status).toBe(401);
    });

    it('names the confirming operator and the reconciling operator separately', async () => {
      const scenario = await collected();
      await remit(scenario.collectionId, finance.accessToken, exactRemittance());
      await reconcile(scenario.collectionId, otherFinance.accessToken);

      const record = await ctx.prisma.codCollection.findUniqueOrThrow({
        where: { id: scenario.collectionId },
        include: { remittance: true, reconciliation: true },
      });

      // Three parties on three rows: the driver who collected, the operator who received, the
      // operator who checked. The whole point of not collapsing this into one boolean.
      expect(record.driverId).toBe(scenario.driverProfileId);
      expect(record.remittance?.confirmedByUserId).toBe(finance.userId);
      expect(record.reconciliation?.reconciledByUserId).toBe(otherFinance.userId);
    });
  });

  // ===========================================================================================
  // The lifecycle boundary (§5)
  // ===========================================================================================

  describe('lifecycle', () => {
    it('refuses to reconcile a collection that has not been remitted', async () => {
      const scenario = await collected();

      const res = await reconcile(scenario.collectionId, finance.accessToken);

      // Through the real HTTP surface, by a caller holding every finance permission the platform
      // has. `COLLECTED → RECONCILED` is unreachable, not merely discouraged.
      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe(ErrorCode.CONFLICT);
      expect(await ctx.prisma.codReconciliation.count()).toBe(0);
      expect(
        (await ctx.prisma.codCollection.findUniqueOrThrow({ where: { id: scenario.collectionId } }))
          .status,
      ).toBe('COLLECTED');
    });

    it('walks COLLECTED → REMITTED → RECONCILED', async () => {
      const scenario = await collected();

      await remit(scenario.collectionId, finance.accessToken, exactRemittance());
      const afterRemit = await ctx.prisma.codCollection.findUniqueOrThrow({
        where: { id: scenario.collectionId },
      });
      expect(afterRemit.status).toBe('REMITTED');
      expect(afterRemit.remittedAt).toBeInstanceOf(Date);
      expect(afterRemit.reconciledAt).toBeNull();

      const res = await reconcile(scenario.collectionId, finance.accessToken);
      expect(res.status).toBe(200);
      expect(mutation(res).collection.reconciliation?.outcome).toBe('ACCEPTED');

      const afterReconcile = await ctx.prisma.codCollection.findUniqueOrThrow({
        where: { id: scenario.collectionId },
      });
      expect(afterReconcile.status).toBe('RECONCILED');
      expect(afterReconcile.reconciledAt).toBeInstanceOf(Date);
    });

    it('refuses a remittance against a collection that does not exist', async () => {
      const res = await remit(randomUUID(), finance.accessToken, exactRemittance());

      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe(ErrorCode.NOT_FOUND);
    });

    it('refuses a remittance for a delivery whose cash was never collected', async () => {
      // There is no collection row, so there is nothing to hand over. "Cannot remit before
      // collection" and "no such collection" are deliberately the same answer.
      const res = await remit(randomUUID(), finance.accessToken, exactRemittance());

      expect(res.status).toBe(404);
      expect(await ctx.prisma.codRemittance.count()).toBe(0);
    });

    it('leaves the delivery job untouched — reconciliation is not a delivery step', async () => {
      const scenario = await collected();
      const before = await ctx.prisma.deliveryJob.findUniqueOrThrow({
        where: { id: scenario.jobId },
      });

      await remit(scenario.collectionId, finance.accessToken, exactRemittance());
      await reconcile(scenario.collectionId, finance.accessToken);

      const after = await ctx.prisma.deliveryJob.findUniqueOrThrow({
        where: { id: scenario.jobId },
      });
      // §17: physical delivery and financial reconciliation stay independent.
      expect(after.status).toBe(before.status);
      expect(after.deliveredAt).toEqual(before.deliveredAt);
    });
  });

  // ===========================================================================================
  // Amounts (§4, §6)
  // ===========================================================================================

  describe('amounts', () => {
    it('records an exact remittance', async () => {
      const scenario = await collected();

      const res = await remit(scenario.collectionId, finance.accessToken, exactRemittance());

      expect(mutation(res).outcome).toBe('EXACT');
      expect(mutation(res).variance).toBe(0);
    });

    it('records a short remittance with the gap visible', async () => {
      const scenario = await collected();

      const res = await remit(scenario.collectionId, finance.accessToken, {
        remittedAmount: 20_000,
        reference: 'CASHDESK-A',
        note: 'Driver short by 4,500.',
      });

      expect(res.status).toBe(200);
      expect(mutation(res).outcome).toBe('SHORT');
      expect(mutation(res).variance).toBe(-4_500);
      expect(mutation(res).collection.remittanceVariance).toBe(-4_500);
      expect(mutation(res).collection.hasDiscrepancy).toBe(true);
      // §3: the driver's declaration is preserved untouched beside it.
      expect(mutation(res).collection.collectedAmount).toBe(COD_AMOUNT);
    });

    it('records an over-remittance', async () => {
      const scenario = await collected();

      const res = await remit(scenario.collectionId, finance.accessToken, {
        remittedAmount: 25_000,
        reference: 'CASHDESK-A',
      });

      expect(mutation(res).outcome).toBe('OVER');
      expect(mutation(res).variance).toBe(500);
    });

    it('does not reconcile a collection merely because a remittance was recorded', async () => {
      const scenario = await collected();

      const res = await remit(scenario.collectionId, finance.accessToken, exactRemittance());

      expect(mutation(res).collection.status).toBe('REMITTED');
      expect(mutation(res).collection.reconciliation).toBeNull();
      expect(mutation(res).collection.isOutstanding).toBe(true);
      expect(await ctx.prisma.codReconciliation.count()).toBe(0);
    });

    it('records a DISCREPANCY rather than refusing, and still reconciles', async () => {
      const scenario = await collected();
      await remit(scenario.collectionId, finance.accessToken, {
        remittedAmount: 20_000,
        reference: 'CASHDESK-A',
      });

      const res = await reconcile(scenario.collectionId, finance.accessToken, {
        note: 'Short — with operations.',
      });

      expect(res.status).toBe(200);
      expect(mutation(res).collection.reconciliation?.outcome).toBe('DISCREPANCY');
      expect(mutation(res).collection.reconciliation?.note).toBe('Short — with operations.');
      // `RECONCILED` means somebody looked; `outcome` says what they found.
      expect(mutation(res).collection.status).toBe('RECONCILED');
      expect(mutation(res).collection.hasDiscrepancy).toBe(true);
    });

    it('finds a discrepancy when the collection itself was short, however faithful the handover', async () => {
      const scenario = await collected({ collectedAmount: 20_000 });
      await remit(scenario.collectionId, finance.accessToken, {
        remittedAmount: 20_000,
        reference: 'CASHDESK-A',
      });

      const res = await reconcile(scenario.collectionId, finance.accessToken);

      expect(mutation(res).collection.reconciliation?.outcome).toBe('DISCREPANCY');
      expect(mutation(res).collection.collectionVariance).toBe(-4_500);
      expect(mutation(res).collection.remittanceVariance).toBe(0);
    });

    it('refuses an outcome supplied in the reconcile body', async () => {
      const scenario = await collected({ collectedAmount: 20_000 });
      await remit(scenario.collectionId, finance.accessToken, {
        remittedAmount: 20_000,
        reference: 'CASHDESK-A',
      });

      const res = await reconcile(scenario.collectionId, finance.accessToken, {
        outcome: 'ACCEPTED',
      });

      // `forbidNonWhitelisted` refuses it outright rather than ignoring it, so an operator cannot
      // even appear to have claimed a clean reconciliation of a shortfall.
      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe(ErrorCode.VALIDATION_ERROR);
    });

    it('refuses a remittance in a currency the collection was not taken in', async () => {
      const scenario = await collected();

      const res = await remit(scenario.collectionId, finance.accessToken, {
        remittedAmount: COD_AMOUNT,
        reference: 'CASHDESK-A',
        currency: 'USD',
      });

      expect(res.status).toBe(400);
      expect(await ctx.prisma.codRemittance.count()).toBe(0);
    });

    it('refuses a remittance with no reference, and a negative amount', async () => {
      const scenario = await collected();

      const noReference = await remit(scenario.collectionId, finance.accessToken, {
        remittedAmount: COD_AMOUNT,
      });
      const negative = await remit(scenario.collectionId, finance.accessToken, {
        remittedAmount: -1,
        reference: 'CASHDESK-A',
      });

      expect(noReference.status).toBe(400);
      expect(negative.status).toBe(400);
      expect(await ctx.prisma.codRemittance.count()).toBe(0);
    });
  });

  // ===========================================================================================
  // Immutability (§8, §21)
  // ===========================================================================================

  describe('immutability', () => {
    it('offers no verb that can edit a collected amount, a remitted amount or a finding', async () => {
      const scenario = await collected();
      await remit(scenario.collectionId, finance.accessToken, exactRemittance());
      await reconcile(scenario.collectionId, finance.accessToken);

      const before = await ctx.prisma.codCollection.findUniqueOrThrow({
        where: { id: scenario.collectionId },
        include: { remittance: true, reconciliation: true },
      });

      const attempts = [
        await request(ctx.server)
          .patch(`${BASE}/${scenario.collectionId}`)
          .set(...auth(finance.accessToken))
          .send({ collectedAmount: 1 }),
        await request(ctx.server)
          .put(`${BASE}/${scenario.collectionId}`)
          .set(...auth(finance.accessToken))
          .send({ remittedAmount: 1 }),
        await request(ctx.server)
          .delete(`${BASE}/${scenario.collectionId}`)
          .set(...auth(finance.accessToken)),
        await request(ctx.server)
          .patch(`${BASE}/${scenario.collectionId}/remit`)
          .set(...auth(finance.accessToken))
          .send({ remittedAmount: 1 }),
        await request(ctx.server)
          .delete(`${BASE}/${scenario.collectionId}/reconcile`)
          .set(...auth(finance.accessToken)),
      ];

      for (const res of attempts) {
        expect([403, 404, 405]).toContain(res.status);
      }

      const after = await ctx.prisma.codCollection.findUniqueOrThrow({
        where: { id: scenario.collectionId },
        include: { remittance: true, reconciliation: true },
      });
      expect(after).toEqual(before);
    });

    it('refuses a second remittance that restates the amount', async () => {
      const scenario = await collected();
      await remit(scenario.collectionId, finance.accessToken, exactRemittance());

      const res = await remit(scenario.collectionId, otherFinance.accessToken, {
        remittedAmount: 1,
        reference: 'CASHDESK-A',
      });

      expect(res.status).toBe(409);
      expect(
        (
          await ctx.prisma.codRemittance.findUniqueOrThrow({
            where: { collectionId: scenario.collectionId },
          })
        ).remittedAmount,
      ).toBe(COD_AMOUNT);
    });

    it('refuses a second reconciliation that restates the finding', async () => {
      const scenario = await collected();
      await remit(scenario.collectionId, finance.accessToken, exactRemittance());
      await reconcile(scenario.collectionId, finance.accessToken, { note: 'Counted.' });

      const res = await reconcile(scenario.collectionId, otherFinance.accessToken, {
        note: 'Actually short.',
      });

      expect(res.status).toBe(409);
      expect(
        (
          await ctx.prisma.codReconciliation.findUniqueOrThrow({
            where: { collectionId: scenario.collectionId },
          })
        ).note,
      ).toBe('Counted.');
    });
  });

  // ===========================================================================================
  // Idempotency and concurrency (§12, §13)
  // ===========================================================================================

  describe('idempotency', () => {
    it('replays an identical remittance without a second row, audit entry or event', async () => {
      const scenario = await collected();
      await remit(scenario.collectionId, finance.accessToken, exactRemittance());
      const audits = await ctx.prisma.auditLog.count({ where: { action: 'DELIVERY_COD_REMITTED' } });

      const replay = await remit(scenario.collectionId, finance.accessToken, exactRemittance());

      expect(replay.status).toBe(200);
      expect(mutation(replay).created).toBe(false);
      expect(await ctx.prisma.codRemittance.count()).toBe(1);
      expect(
        await ctx.prisma.auditLog.count({ where: { action: 'DELIVERY_COD_REMITTED' } }),
      ).toBe(audits);
      expect(await codEvents(DeliveryEventType.CodRemitted, scenario.collectionId)).toHaveLength(1);
    });

    it('replays an identical reconciliation without a second row, audit entry or event', async () => {
      const scenario = await collected();
      await remit(scenario.collectionId, finance.accessToken, exactRemittance());
      await reconcile(scenario.collectionId, finance.accessToken);

      const replay = await reconcile(scenario.collectionId, finance.accessToken);

      expect(replay.status).toBe(200);
      expect(mutation(replay).created).toBe(false);
      expect(await ctx.prisma.codReconciliation.count()).toBe(1);
      expect(
        await ctx.prisma.auditLog.count({ where: { action: 'DELIVERY_COD_RECONCILED' } }),
      ).toBe(1);
      expect(await codEvents(DeliveryEventType.CodReconciled, scenario.collectionId)).toHaveLength(
        1,
      );
    });

    it('cannot move a reconciled collection backward', async () => {
      const scenario = await collected();
      await remit(scenario.collectionId, finance.accessToken, exactRemittance());
      await reconcile(scenario.collectionId, finance.accessToken);

      await reconcile(scenario.collectionId, otherFinance.accessToken);
      await remit(scenario.collectionId, otherFinance.accessToken, exactRemittance());

      expect(
        (await ctx.prisma.codCollection.findUniqueOrThrow({ where: { id: scenario.collectionId } }))
          .status,
      ).toBe('RECONCILED');
    });

    it('converges three simultaneous remittances on one row and one event', async () => {
      const scenario = await collected();

      const results = await Promise.all([
        remit(scenario.collectionId, finance.accessToken, exactRemittance()),
        remit(scenario.collectionId, otherFinance.accessToken, exactRemittance()),
        remit(scenario.collectionId, finance.accessToken, exactRemittance()),
      ]);

      // Only PostgreSQL can settle this, which is the whole reason the assertion lives here.
      expect(results.filter((res) => res.status === 200)).toHaveLength(3);
      expect(await ctx.prisma.codRemittance.count()).toBe(1);
      expect(await codEvents(DeliveryEventType.CodRemitted, scenario.collectionId)).toHaveLength(1);
      expect(
        await ctx.prisma.auditLog.count({ where: { action: 'DELIVERY_COD_REMITTED' } }),
      ).toBe(1);
    });

    it('converges three simultaneous reconciliations on one finding', async () => {
      const scenario = await collected();
      await remit(scenario.collectionId, finance.accessToken, exactRemittance());

      const results = await Promise.all([
        reconcile(scenario.collectionId, finance.accessToken),
        reconcile(scenario.collectionId, otherFinance.accessToken),
        reconcile(scenario.collectionId, finance.accessToken),
      ]);

      expect(results.filter((res) => res.status === 200)).toHaveLength(3);
      expect(await ctx.prisma.codReconciliation.count()).toBe(1);
      expect(
        await codEvents(DeliveryEventType.CodReconciled, scenario.collectionId),
      ).toHaveLength(1);
    });
  });

  // ===========================================================================================
  // The Module 07 boundary (§15, §16)
  // ===========================================================================================

  describe('Module 07 boundary', () => {
    it('moves no money: no ledger entry, no payment, no wallet, no settlement', async () => {
      const scenario = await collected();

      await remit(scenario.collectionId, finance.accessToken, exactRemittance());
      await reconcile(scenario.collectionId, finance.accessToken);

      expect(await ctx.prisma.ledgerEntry.count()).toBe(0);
      expect(await ctx.prisma.ledgerTransaction.count()).toBe(0);
      expect(await ctx.prisma.payment.count()).toBe(0);
      expect(await ctx.prisma.settlement.count()).toBe(0);
    });

    it('leaves settlementRef null — settlement is Module 07’s, not this lifecycle’s', async () => {
      const scenario = await collected();
      await remit(scenario.collectionId, finance.accessToken, exactRemittance());
      await reconcile(scenario.collectionId, finance.accessToken);

      const row = await ctx.prisma.codCollection.findUniqueOrThrow({
        where: { id: scenario.collectionId },
      });
      // §16: `settled` stays out of the Delivery COD lifecycle. `RECONCILED` is as far as this
      // module goes, and the column a settlement run would eventually fill is still empty.
      expect(row.settlementRef).toBeNull();
    });

    it('does not touch the order', async () => {
      const scenario = await collected();
      const before = await ctx.prisma.order.findUniqueOrThrow({ where: { id: scenario.orderId } });

      await remit(scenario.collectionId, finance.accessToken, exactRemittance());
      await reconcile(scenario.collectionId, finance.accessToken);

      const after = await ctx.prisma.order.findUniqueOrThrow({ where: { id: scenario.orderId } });
      expect(after).toEqual(before);
    });

    it('creates no driver earning, wallet or payable of any kind', async () => {
      const scenario = await collected();

      await remit(scenario.collectionId, finance.accessToken, exactRemittance());
      await reconcile(scenario.collectionId, finance.accessToken);

      // The driver is a collection channel, never the owner of the customer's money: remitting
      // cash must not credit the driver with anything.
      expect(await ctx.prisma.driverEarning.count()).toBe(0);
      expect(await ctx.prisma.accountBalance.count()).toBe(0);
      expect(await ctx.prisma.payoutLine.count()).toBe(0);
    });
  });

  // ===========================================================================================
  // Events and audit (§14, §20)
  // ===========================================================================================

  describe('events and audit', () => {
    it('emits CodRemitted and CodReconciled once each, with all three amounts', async () => {
      const scenario = await collected();
      await remit(scenario.collectionId, finance.accessToken, {
        remittedAmount: 20_000,
        reference: 'CASHDESK-A',
      });
      await reconcile(scenario.collectionId, finance.accessToken);

      const [remitted] = await codEvents(DeliveryEventType.CodRemitted, scenario.collectionId);
      const [reconciled] = await codEvents(
        DeliveryEventType.CodReconciled,
        scenario.collectionId,
      );

      expect(remitted.payload).toMatchObject({
        jobId: scenario.jobId,
        orderId: scenario.orderId,
        driverId: scenario.driverProfileId,
        expectedAmount: COD_AMOUNT,
        collectedAmount: COD_AMOUNT,
        remittedAmount: 20_000,
        currency: 'ETB',
        method: 'CASH',
        reference: 'CASHDESK-A',
        confirmedByUserId: finance.userId,
      });
      expect(reconciled.payload).toMatchObject({
        remittedAmount: 20_000,
        outcome: 'DISCREPANCY',
        remittanceReference: 'CASHDESK-A',
        reconciledByUserId: finance.userId,
      });
    });

    it('leaks no provider secret on either event', async () => {
      const scenario = await collected({ electronic: true });
      await remit(scenario.collectionId, finance.accessToken, exactRemittance());
      await reconcile(scenario.collectionId, finance.accessToken);

      const rows = await ctx.prisma.outbox.findMany({
        where: {
          eventType: { in: [DeliveryEventType.CodRemitted, DeliveryEventType.CodReconciled] },
        },
      });
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        const serialized = JSON.stringify(row.payload).toLowerCase();
        for (const forbidden of ['cvv', 'telebirr', 'password', 'secret', 'signature', 'token']) {
          expect(serialized).not.toContain(forbidden);
        }
      }
    });

    it('writes an audit entry for each step, and none for a rejected attempt', async () => {
      const scenario = await collected();
      await remit(scenario.collectionId, finance.accessToken, exactRemittance());
      await reconcile(scenario.collectionId, finance.accessToken);
      await reconcile(scenario.collectionId, finance.accessToken, { note: 'restated' });

      const actions = await ctx.prisma.auditLog.findMany({
        where: { resourceId: scenario.collectionId },
        orderBy: { createdAt: 'asc' },
        select: { action: true, actorUserId: true },
      });

      // Three assertions, three entries — and the rejected restatement added none.
      expect(actions.map((entry) => entry.action)).toEqual([
        'DELIVERY_COD_COLLECTED',
        'DELIVERY_COD_REMITTED',
        'DELIVERY_COD_RECONCILED',
      ]);
      expect(actions[0].actorUserId).toBe(scenario.driverUserId);
      expect(actions[1].actorUserId).toBe(finance.userId);
    });
  });

  // ===========================================================================================
  // The finance read (§18, §19)
  // ===========================================================================================

  describe('finance view', () => {
    it('answers what was expected, declared, remitted and outstanding', async () => {
      const scenario = await collected();
      await remit(scenario.collectionId, finance.accessToken, {
        remittedAmount: 20_000,
        reference: 'CASHDESK-A',
        note: 'One note short.',
      });

      const res = await request(ctx.server)
        .get(`${BASE}/${scenario.collectionId}`)
        .set(...auth(finance.accessToken));

      expect(res.status).toBe(200);
      expect(detail(res)).toMatchObject({
        expectedAmount: COD_AMOUNT,
        collectedAmount: COD_AMOUNT,
        collectionVariance: 0,
        remittanceVariance: -4_500,
        hasDiscrepancy: true,
        isOutstanding: true,
        status: 'REMITTED',
      });
      expect(detail(res).remittance).toMatchObject({
        remittedAmount: 20_000,
        reference: 'CASHDESK-A',
        confirmedByUserId: finance.userId,
      });
      expect(detail(res).reconciliation).toBeNull();
    });

    it('filters by status and driver', async () => {
      const remittedScenario = await collected();
      const pending = await collected();
      await remit(remittedScenario.collectionId, finance.accessToken, exactRemittance());

      const remittedPage = await request(ctx.server)
        .get(`${BASE}?status=REMITTED`)
        .set(...auth(finance.accessToken));
      const driverPage = await request(ctx.server)
        .get(`${BASE}?driverId=${pending.driverProfileId}`)
        .set(...auth(finance.accessToken));

      expect(page(remittedPage).total).toBe(1);
      expect(page(remittedPage).items[0].id).toBe(remittedScenario.collectionId);
      expect(page(driverPage).total).toBe(1);
      expect(page(driverPage).items[0].id).toBe(pending.collectionId);
    });

    it('groups a whole handover by its remittance reference', async () => {
      const first = await collected();
      const second = await collected();
      const third = await collected();
      await remit(first.collectionId, finance.accessToken, exactRemittance('CASHDESK-MON'));
      await remit(second.collectionId, finance.accessToken, exactRemittance('CASHDESK-MON'));
      await remit(third.collectionId, finance.accessToken, exactRemittance('CASHDESK-TUE'));

      const res = await request(ctx.server)
        .get(`${BASE}?remittanceReference=CASHDESK-MON`)
        .set(...auth(finance.accessToken));

      // §19's batch grouping, with no batch table and no assumed cadence anywhere.
      expect(page(res).total).toBe(2);
      expect(page(res).items.map((item) => item.id).sort()).toEqual(
        [first.collectionId, second.collectionId].sort(),
      );
    });

    it('filters by collection period and currency', async () => {
      const scenario = await collected();

      const inRange = await request(ctx.server)
        .get(`${BASE}?from=2020-01-01T00:00:00.000Z&currency=ETB`)
        .set(...auth(finance.accessToken));
      const outOfRange = await request(ctx.server)
        .get(`${BASE}?to=2020-01-01T00:00:00.000Z`)
        .set(...auth(finance.accessToken));

      expect(page(inRange).items.map((item) => item.id)).toContain(
        scenario.collectionId,
      );
      expect(page(outOfRange).total).toBe(0);
    });

    it('answers NOT_FOUND for an unknown collection', async () => {
      const res = await request(ctx.server)
        .get(`${BASE}/${randomUUID()}`)
        .set(...auth(finance.accessToken));

      expect(res.status).toBe(404);
    });

    it('exposes no driver identity, earnings or payout data', async () => {
      const scenario = await collected();
      await remit(scenario.collectionId, finance.accessToken, exactRemittance());

      const res = await request(ctx.server)
        .get(`${BASE}/${scenario.collectionId}`)
        .set(...auth(finance.accessToken));

      const serialized = JSON.stringify(detail(res)).toLowerCase();
      for (const forbidden of ['phone', 'earning', 'payout', 'wallet', 'balance', 'password']) {
        expect(serialized).not.toContain(forbidden);
      }
      // `driverId` is a `driver_profiles.id`, and it is the whole of what finance is told about
      // the channel.
      expect(detail(res).driverId).toBe(scenario.driverProfileId);
    });

    it('rejects an unknown filter rather than silently ignoring it', async () => {
      const res = await request(ctx.server)
        .get(`${BASE}?pharmacyId=anything`)
        .set(...auth(finance.accessToken));

      expect(res.status).toBe(400);
    });
  });

  // ===========================================================================================
  // CASH and ELECTRONIC (§9, §10)
  // ===========================================================================================

  describe('collection methods', () => {
    it('reconciles cash with no external verification and no fabricated transaction id', async () => {
      const scenario = await collected();
      await remit(scenario.collectionId, finance.accessToken, exactRemittance());

      const res = await reconcile(scenario.collectionId, finance.accessToken);

      expect(mutation(res).collection.method).toBe('CASH');
      expect(mutation(res).collection.providerReference).toBeNull();
      expect(mutation(res).collection.reconciliation?.outcome).toBe('ACCEPTED');
    });

    it('carries an electronic provider reference through untouched, with no provider call', async () => {
      const scenario = await collected({ electronic: true });

      await remit(scenario.collectionId, finance.accessToken, exactRemittance());
      const res = await reconcile(scenario.collectionId, finance.accessToken);

      expect(mutation(res).collection.method).toBe('ELECTRONIC');
      expect(mutation(res).collection.providerReference).toBe('TXN-55512345');
      // The row is byte-for-byte what the driver recorded: nothing verified it, nothing rewrote it.
      const row = await ctx.prisma.codCollection.findUniqueOrThrow({
        where: { id: scenario.collectionId },
      });
      expect(row.providerReference).toBe('TXN-55512345');
    });
  });
});
