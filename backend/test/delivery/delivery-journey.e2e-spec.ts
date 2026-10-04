import { randomUUID } from 'crypto';
import request from 'supertest';
import { AcceptJobOfferCommand } from '../../src/modules/delivery/application/commands/accept-job-offer.command';
import { AdvanceDeliveryJobCommand } from '../../src/modules/delivery/application/commands/advance-delivery-job.command';
import { CaptureProofOfDeliveryCommand } from '../../src/modules/delivery/application/commands/capture-proof-of-delivery.command';
import { CreateDeliveryJobCommand } from '../../src/modules/delivery/application/commands/create-delivery-job.command';
import { CreateDriverProfileCommand } from '../../src/modules/delivery/application/commands/create-driver-profile.command';
import { DeclineJobOfferCommand } from '../../src/modules/delivery/application/commands/decline-job-offer.command';
import {
  DispatchDeliveryJobCommand,
  DispatchOutcome,
} from '../../src/modules/delivery/application/commands/dispatch-delivery-job.command';
import { ManageDriverShiftCommand } from '../../src/modules/delivery/application/commands/manage-driver-shift.command';
import { ReassignDeliveryJobCommand } from '../../src/modules/delivery/application/commands/reassign-delivery-job.command';
import { RecordCodCollectionCommand } from '../../src/modules/delivery/application/commands/record-cod-collection.command';
import { SetDriverAvailabilityCommand } from '../../src/modules/delivery/application/commands/set-driver-availability.command';
import { UpdateDriverLocationCommand } from '../../src/modules/delivery/application/commands/update-driver-location.command';
import { OfferExpirySweeper } from '../../src/modules/delivery/infrastructure/scheduling/offer-expiry.sweeper';
import {
  CodCollectionMethod,
  CodCollectionStatus,
  CodCorrectionType,
  CodDisputeStatus,
  CodReconciliationOutcome,
  DeliveryJobStatus,
  DriverAvailability,
  EarningStatus,
  JobOfferStatus,
  PodType,
} from '../../src/modules/delivery/domain/enums';
import { DeliveryEventType } from '../../src/modules/delivery/domain/events';
import { VehicleType } from '../../src/modules/delivery/domain/value-objects/vehicle.vo';
import { auth, body, createUserWithRole, uniquePhone } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

const COD_AMOUNT = 48_000;
const COD_BASE = '/admin/delivery/cod-reconciliation';

/**
 * The delivery business flow, end to end, against real PostgreSQL (§18 of the Work 14 brief).
 *
 * One scenario walks the whole intended path — order ready, job created, dispatched, offered,
 * accepted, driven to the door, cash collected, proof captured, delivered, earning accrued,
 * completed — and asserts at each step the fact that step is supposed to establish. The alternate
 * paths follow: decline, expiry, reassignment, no driver, failure, shortfall, overpayment,
 * remittance, reconciliation, correction, dispute.
 *
 * ## What this suite is for, given every step already has its own suite
 *
 * The per-work suites each prove one mechanism in isolation. This proves they compose — that the
 * job the dispatcher offered is the job the driver accepted, whose earning names the driver who
 * carried it, whose COD row names the order the customer paid for. Those joins are the thing no
 * single-work suite can check, and they are exactly what breaks when two works each change
 * something reasonable.
 *
 * ## No Telebirr, no NBE, no provider anywhere
 *
 * Electronic collection is recorded with a `providerReference` that is a *string the driver typed*,
 * and nothing in the platform verifies it against anything. That is the design, not a test
 * shortcut: §1's money flow ends at PharmaLink reconciliation, and the verification of a mobile
 * money receipt is a contract this repository does not have.
 */
describe('Delivery full journey (e2e)', () => {
  let ctx: TestContext;
  let createJob: CreateDeliveryJobCommand;
  let dispatch: DispatchDeliveryJobCommand;
  let accept: AcceptJobOfferCommand;
  let decline: DeclineJobOfferCommand;
  let advance: AdvanceDeliveryJobCommand;
  let capturePod: CaptureProofOfDeliveryCommand;
  let recordCod: RecordCodCollectionCommand;
  let createProfile: CreateDriverProfileCommand;
  let shift: ManageDriverShiftCommand;
  let availability: SetDriverAvailabilityCommand;
  let location: UpdateDriverLocationCommand;
  let offerSweeper: OfferExpirySweeper;

  beforeAll(async () => {
    ctx = await createTestApp();
    createJob = ctx.app.get(CreateDeliveryJobCommand);
    dispatch = ctx.app.get(DispatchDeliveryJobCommand);
    accept = ctx.app.get(AcceptJobOfferCommand);
    decline = ctx.app.get(DeclineJobOfferCommand);
    advance = ctx.app.get(AdvanceDeliveryJobCommand);
    capturePod = ctx.app.get(CaptureProofOfDeliveryCommand);
    recordCod = ctx.app.get(RecordCodCollectionCommand);
    createProfile = ctx.app.get(CreateDriverProfileCommand);
    shift = ctx.app.get(ManageDriverShiftCommand);
    availability = ctx.app.get(SetDriverAvailabilityCommand);
    location = ctx.app.get(UpdateDriverLocationCommand);
    offerSweeper = ctx.app.get(OfferExpirySweeper);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  // -------------------------------------------------------------------------------------------
  // Fixtures — a real Module 06 fulfillment, and real Module 01 drivers
  // -------------------------------------------------------------------------------------------

  interface Driver {
    userId: string;
    profileId: string;
    accessToken: string;
  }

  async function seedDriver(): Promise<Driver> {
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
      plateNumber: `AA-${Math.floor(Math.random() * 99_999)}`,
      serviceArea: { lat: 9.03, lng: 38.74, radiusMeters: 20_000 },
    });
    await shift.start({ userId: user.userId });
    await availability.execute({ userId: user.userId, availability: DriverAvailability.ONLINE });
    await location.execute({ userId: user.userId, lat: 9.03, lng: 38.74 });
    return { userId: user.userId, profileId: profile.id, accessToken: user.accessToken };
  }

  /** A Module 06 order and fulfillment in `READY` — the upstream event this module reacts to. */
  async function seedFulfillment(
    options: { isCod?: boolean; grandTotal?: number } = {},
  ): Promise<{ fulfillmentId: string; orderId: string }> {
    const grandTotal = options.grandTotal ?? COD_AMOUNT;
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
        isCod: options.isCod ?? true,
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

  async function financeToken(): Promise<string> {
    const officer = await createUserWithRole(ctx, 'FINANCE_OFFICER');
    return officer.accessToken;
  }

  async function jobRow(jobId: string) {
    return ctx.prisma.deliveryJob.findUniqueOrThrow({ where: { id: jobId } });
  }

  async function eventTypes(jobId: string): Promise<string[]> {
    const rows = await ctx.prisma.outbox.findMany({
      where: { aggregateId: jobId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => r.eventType);
  }

  /** Drives a job from ARRIVED_DROPOFF back through the states before it. */
  async function driveToDoor(driver: Driver, jobId: string): Promise<void> {
    for (const to of [
      DeliveryJobStatus.ARRIVED_PICKUP,
      DeliveryJobStatus.PICKED_UP,
      DeliveryJobStatus.EN_ROUTE,
      DeliveryJobStatus.ARRIVED_DROPOFF,
    ]) {
      await advance.byDriver({ userId: driver.userId, jobId, to });
    }
  }

  // -------------------------------------------------------------------------------------------
  // 1. The intended path, start to finish
  // -------------------------------------------------------------------------------------------

  describe('the happy path', () => {
    it('carries a COD order from pharmacy-ready to completed, with every record it should leave', async () => {
      const driver = await seedDriver();
      const seed = await seedFulfillment();

      // --- Order ready → delivery job created -------------------------------------------------
      const { job } = await createJob.execute({ fulfillmentId: seed.fulfillmentId });
      expect(job.status).toBe(DeliveryJobStatus.CREATED);
      expect(job.orderId).toBe(seed.orderId);
      expect(job.isCod).toBe(true);
      // The amount to collect is frozen from the order at creation, not read live at the door.
      expect(job.codAmount).toBe(COD_AMOUNT);

      // --- Dispatch → offer -------------------------------------------------------------------
      const dispatched = await dispatch.execute({ jobId: job.id, actorUserId: null });
      expect(dispatched.outcome).toBe(DispatchOutcome.Offered);
      expect(dispatched.offer!.driverId).toBe(driver.profileId);
      expect(dispatched.offer!.round).toBe(1);
      expect((await jobRow(job.id)).status).toBe(DeliveryJobStatus.OFFERED);

      // --- Driver accepts ---------------------------------------------------------------------
      await accept.execute({ userId: driver.userId, jobId: job.id });
      const assigned = await jobRow(job.id);
      expect(assigned.status).toBe(DeliveryJobStatus.ASSIGNED);
      expect(assigned.assignedDriverId).toBe(driver.profileId);
      expect(
        await ctx.prisma.jobOffer.count({
          where: { jobId: job.id, status: JobOfferStatus.ACCEPTED },
        }),
      ).toBe(1);

      // --- Arrived pickup → picked up → en route → arrived dropoff -----------------------------
      await driveToDoor(driver, job.id);
      const atDoor = await jobRow(job.id);
      expect(atDoor.status).toBe(DeliveryJobStatus.ARRIVED_DROPOFF);
      // The physical timestamp was stamped by the transition that caused it, not by the client.
      expect(atDoor.pickedUpAt).not.toBeNull();
      expect(atDoor.deliveredAt).toBeNull();

      // --- COD collected at the door ----------------------------------------------------------
      const { collection } = await recordCod.execute({
        userId: driver.userId,
        jobId: job.id,
        collectedAmount: COD_AMOUNT,
        method: CodCollectionMethod.CASH,
        providerReference: null,
      });
      expect(collection.expectedAmount).toBe(COD_AMOUNT);
      expect(collection.collectedAmount).toBe(COD_AMOUNT);
      expect(collection.status).toBe(CodCollectionStatus.COLLECTED);
      expect(collection.driverId).toBe(driver.profileId);

      // --- Proof of delivery ------------------------------------------------------------------
      const pod = await capturePod.execute({
        userId: driver.userId,
        jobId: job.id,
        // `CONFIRMATION` is the recipient's attestation and carries no file. `SIGNATURE` and
        // `PHOTO` are artifact types and are refused without one — asserted in the PoD suite.
        type: PodType.CONFIRMATION,
        recipientName: 'Selam Tesfaye',
        recipientConfirmed: true,
      });
      expect(pod.created).toBe(true);

      // --- Delivered --------------------------------------------------------------------------
      await advance.byDriver({
        userId: driver.userId,
        jobId: job.id,
        to: DeliveryJobStatus.DELIVERED,
      });
      const delivered = await jobRow(job.id);
      expect(delivered.deliveredAt).not.toBeNull();

      // --- Earning accrued, then COMPLETED ----------------------------------------------------
      // `DeliveryCompletionHandler` reacts to the delivered event: it accrues the earning and only
      // then closes the job. Both are asserted, because the ordering is the rule — a job cannot be
      // completed with its earning missing.
      // The relay's timer is disabled under NODE_ENV=test, so the production path is driven
      // explicitly rather than waited for.
      await ctx.drainOutbox();

      const earning = await ctx.prisma.driverEarning.findFirstOrThrow({
        where: { jobId: job.id },
      });
      expect(earning.driverId).toBe(driver.profileId);
      expect(earning.status).toBe(EarningStatus.ACCRUED);

      const completed = await jobRow(job.id);
      expect(completed.status).toBe(DeliveryJobStatus.COMPLETED);

      // --- The trail the whole journey left ---------------------------------------------------
      const history = await ctx.prisma.deliveryStatusHistory.findMany({
        where: { jobId: job.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      expect(history.map((h) => h.toStatus)).toEqual([
        DeliveryJobStatus.OFFERED,
        DeliveryJobStatus.ASSIGNED,
        DeliveryJobStatus.ARRIVED_PICKUP,
        DeliveryJobStatus.PICKED_UP,
        DeliveryJobStatus.EN_ROUTE,
        DeliveryJobStatus.ARRIVED_DROPOFF,
        DeliveryJobStatus.DELIVERED,
        DeliveryJobStatus.COMPLETED,
      ]);

      // Each event published exactly once, through the outbox — never twice, never directly.
      const types = await eventTypes(job.id);
      for (const type of [
        DeliveryEventType.JobOffered,
        DeliveryEventType.JobAssigned,
        DeliveryEventType.OrderPickedUp,
        DeliveryEventType.OrderDelivered,
      ]) {
        expect(types.filter((t) => t === type)).toHaveLength(1);
      }

      // --- And nothing financial was written anywhere else -------------------------------------
      // Module 07 owns the ledger. A completed COD delivery must not have moved money.
      expect(await ctx.prisma.accountBalance.count()).toBe(0);
      expect(await ctx.prisma.payoutLine.count()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 2. The alternate paths
  // -------------------------------------------------------------------------------------------

  describe('alternate paths', () => {
    it('moves to the next candidate when a driver declines', async () => {
      const first = await seedDriver();
      const second = await seedDriver();
      const seed = await seedFulfillment();
      const { job } = await createJob.execute({ fulfillmentId: seed.fulfillmentId });

      const offered = await dispatch.execute({ jobId: job.id });
      const declining = offered.offer!.driverId === first.profileId ? first : second;
      const other = declining === first ? second : first;

      await decline.execute({ userId: declining.userId, jobId: job.id });

      const live = await ctx.prisma.jobOffer.findMany({
        where: { jobId: job.id, status: JobOfferStatus.OFFERED },
      });
      expect(live).toHaveLength(1);
      expect(live[0].driverId).toBe(other.profileId);
      expect(live[0].round).toBe(2);
      // The decline is kept — a job that took two rounds says so.
      expect(
        await ctx.prisma.jobOffer.count({
          where: { jobId: job.id, status: JobOfferStatus.DECLINED },
        }),
      ).toBe(1);
    });

    it('expires an unanswered offer and re-offers it', async () => {
      const first = await seedDriver();
      const seed = await seedFulfillment();
      const { job } = await createJob.execute({ fulfillmentId: seed.fulfillmentId });
      const offered = await dispatch.execute({ jobId: job.id });

      const past = Date.now() - 120_000;
      await ctx.prisma.jobOffer.update({
        where: { id: offered.offer!.id },
        data: { offeredAt: new Date(past), expiresAt: new Date(past + 30_000) },
      });
      const second = await seedDriver();

      expect(await offerSweeper.run()).toBe(1);

      const live = await ctx.prisma.jobOffer.findMany({
        where: { jobId: job.id, status: JobOfferStatus.OFFERED },
      });
      expect(live).toHaveLength(1);
      expect(live[0].driverId).toBe(second.profileId);
      expect(live[0].driverId).not.toBe(first.profileId);
    });

    it('reassigns a pre-pickup job to a different driver', async () => {
      const first = await seedDriver();
      const seed = await seedFulfillment();
      const { job } = await createJob.execute({ fulfillmentId: seed.fulfillmentId });
      await dispatch.execute({ jobId: job.id });
      await accept.execute({ userId: first.userId, jobId: job.id });

      const second = await seedDriver();
      const reassign = ctx.app.get(ReassignDeliveryJobCommand);
      const result = await reassign.execute({
        jobId: job.id,
        reason: 'Driver unreachable',
        actorUserId: null,
      });

      expect(result.previousDriverId).toBe(first.profileId);
      const live = await ctx.prisma.jobOffer.findMany({
        where: { jobId: job.id, status: JobOfferStatus.OFFERED },
      });
      expect(live).toHaveLength(1);
      expect(live[0].driverId).toBe(second.profileId);
    });

    it('holds a job safely when nobody is eligible', async () => {
      const seed = await seedFulfillment();
      const { job } = await createJob.execute({ fulfillmentId: seed.fulfillmentId });

      const result = await dispatch.execute({ jobId: job.id });

      expect(result.outcome).toBe(DispatchOutcome.NoCandidate);
      expect((await jobRow(job.id)).status).toBe(DeliveryJobStatus.CREATED);
      expect(
        await ctx.prisma.auditLog.count({
          where: { resourceId: job.id, action: 'DELIVERY_JOB_NO_DRIVER_AVAILABLE' },
        }),
      ).toBe(1);
    });

    it('records a failed delivery with its reason and accrues nothing', async () => {
      const driver = await seedDriver();
      const seed = await seedFulfillment();
      const { job } = await createJob.execute({ fulfillmentId: seed.fulfillmentId });
      await dispatch.execute({ jobId: job.id });
      await accept.execute({ userId: driver.userId, jobId: job.id });
      await advance.byDriver({
        userId: driver.userId,
        jobId: job.id,
        to: DeliveryJobStatus.ARRIVED_PICKUP,
      });
      await advance.byDriver({
        userId: driver.userId,
        jobId: job.id,
        to: DeliveryJobStatus.PICKED_UP,
      });

      await advance.byDriver({
        userId: driver.userId,
        jobId: job.id,
        to: DeliveryJobStatus.FAILED,
        reason: 'Customer not at the address',
      });

      expect((await jobRow(job.id)).status).toBe(DeliveryJobStatus.FAILED);
      const failure = await ctx.prisma.deliveryStatusHistory.findFirstOrThrow({
        where: { jobId: job.id, toStatus: DeliveryJobStatus.FAILED },
      });
      expect(failure.reason).toBe('Customer not at the address');
      // Nothing was delivered, so nothing was earned.
      expect(await ctx.prisma.driverEarning.count({ where: { jobId: job.id } })).toBe(0);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 3. The COD money path, from the door to reconciliation
  // -------------------------------------------------------------------------------------------

  describe('the COD path', () => {
    /** A delivery whose cash has been declared, ready for the finance half. */
    async function collected(collectedAmount: number): Promise<{
      collectionId: string;
      jobId: string;
      driverProfileId: string;
    }> {
      const driver = await seedDriver();
      const seed = await seedFulfillment();
      const { job } = await createJob.execute({ fulfillmentId: seed.fulfillmentId });
      await dispatch.execute({ jobId: job.id });
      await accept.execute({ userId: driver.userId, jobId: job.id });
      await driveToDoor(driver, job.id);
      const { collection } = await recordCod.execute({
        userId: driver.userId,
        jobId: job.id,
        collectedAmount,
        method: CodCollectionMethod.CASH,
        providerReference: null,
      });
      await shift.end({ userId: driver.userId });
      return { collectionId: collection.id, jobId: job.id, driverProfileId: driver.profileId };
    }

    it('records a shortfall without changing what was expected', async () => {
      const { collectionId } = await collected(COD_AMOUNT - 5_000);
      const token = await financeToken();

      const res = await request(ctx.server)
        .get(`${COD_BASE}/${collectionId}`)
        .set(...auth(token));

      expect(res.status).toBe(200);
      const view = body(res) as Record<string, unknown>;
      expect(view.expectedAmount).toBe(COD_AMOUNT);
      expect(view.collectedAmount).toBe(COD_AMOUNT - 5_000);
      expect(view.collectionVariance).toBe(-5_000);
      expect(view.hasDiscrepancy).toBe(true);
    });

    it('records an overpayment the same way, with the sign reversed', async () => {
      const { collectionId } = await collected(COD_AMOUNT + 2_000);
      const token = await financeToken();

      const res = await request(ctx.server)
        .get(`${COD_BASE}/${collectionId}`)
        .set(...auth(token));

      expect(body(res).collectionVariance).toBe(2_000);
      expect(body(res).hasDiscrepancy).toBe(true);
    });

    it('carries an exact collection through remittance and reconciliation to ACCEPTED', async () => {
      const { collectionId } = await collected(COD_AMOUNT);
      const token = await financeToken();

      const remitted = await request(ctx.server)
        .post(`${COD_BASE}/${collectionId}/remit`)
        .set(...auth(token))
        .send({ remittedAmount: COD_AMOUNT, reference: 'CASHDESK-2026-09-17' });
      expect(remitted.status).toBe(200);

      const reconciled = await request(ctx.server)
        .post(`${COD_BASE}/${collectionId}/reconcile`)
        .set(...auth(token))
        .send({ reference: 'RECON-01' });
      expect(reconciled.status).toBe(200);

      const stored = await ctx.prisma.codCollection.findUniqueOrThrow({
        where: { id: collectionId },
      });
      expect(stored.status).toBe(CodCollectionStatus.RECONCILED);
      const outcome = await ctx.prisma.codReconciliation.findUniqueOrThrow({
        where: { collectionId },
      });
      expect(outcome.outcome).toBe(CodReconciliationOutcome.ACCEPTED);

      // Still no ledger, no settlement, no payout anywhere. The money flow ends here.
      expect(await ctx.prisma.accountBalance.count()).toBe(0);
      expect(await ctx.prisma.payoutLine.count()).toBe(0);
    });

    it('reconciles a shortfall as DISCREPANCY and leaves the original figures intact', async () => {
      const { collectionId } = await collected(COD_AMOUNT - 3_000);
      const token = await financeToken();

      await request(ctx.server)
        .post(`${COD_BASE}/${collectionId}/remit`)
        .set(...auth(token))
        .send({ remittedAmount: COD_AMOUNT - 3_000, reference: 'CASHDESK-B' })
        .expect(200);
      await request(ctx.server)
        .post(`${COD_BASE}/${collectionId}/reconcile`)
        .set(...auth(token))
        .send({})
        .expect(200);

      const outcome = await ctx.prisma.codReconciliation.findUniqueOrThrow({
        where: { collectionId },
      });
      expect(outcome.outcome).toBe(CodReconciliationOutcome.DISCREPANCY);

      const stored = await ctx.prisma.codCollection.findUniqueOrThrow({
        where: { id: collectionId },
      });
      expect(stored.expectedAmount).toBe(COD_AMOUNT);
      expect(stored.collectedAmount).toBe(COD_AMOUNT - 3_000);
    });

    it('answers a mistake with a correction beside the record, never an edit to it', async () => {
      const { collectionId } = await collected(COD_AMOUNT - 3_000);
      const token = await financeToken();

      const res = await request(ctx.server)
        .post(`${COD_BASE}/${collectionId}/corrections`)
        .set(...auth(token))
        .send({
          type: CodCorrectionType.RECORDING_MISTAKE,
          originalAmount: COD_AMOUNT - 3_000,
          correctedAmount: COD_AMOUNT,
          reason: 'Cash desk recount: the driver handed over the full amount.',
          idempotencyKey: `corr-${randomUUID()}`,
        });
      expect(res.status).toBe(200);

      // The historical row is untouched — that is the whole point of Work 13.
      const stored = await ctx.prisma.codCollection.findUniqueOrThrow({
        where: { id: collectionId },
      });
      expect(stored.collectedAmount).toBe(COD_AMOUNT - 3_000);
      expect(await ctx.prisma.codCorrection.count({ where: { collectionId } })).toBe(1);
    });

    it('opens and resolves a dispute without moving any money', async () => {
      const { collectionId } = await collected(COD_AMOUNT - 1_000);
      const token = await financeToken();

      const opened = await request(ctx.server)
        .post(`${COD_BASE}/${collectionId}/disputes`)
        .set(...auth(token))
        .send({ reason: 'Driver disputes the counted shortfall.' });
      expect(opened.status).toBe(200);
      const disputeId = (body(opened).dispute as Record<string, unknown>).id as string;

      const resolved = await request(ctx.server)
        .post(`${COD_BASE}/${collectionId}/disputes/${disputeId}/resolve`)
        .set(...auth(token))
        .send({ resolutionNote: 'Recount agreed; no further action.' });
      expect(resolved.status).toBe(200);

      const dispute = await ctx.prisma.codDispute.findUniqueOrThrow({ where: { id: disputeId } });
      expect(dispute.status).toBe(CodDisputeStatus.RESOLVED);

      // The discrepancy is still as visible as it was, and no money moved.
      const stored = await ctx.prisma.codCollection.findUniqueOrThrow({
        where: { id: collectionId },
      });
      expect(stored.collectedAmount).toBe(COD_AMOUNT - 1_000);
      expect(await ctx.prisma.accountBalance.count()).toBe(0);
    });

    it('summarises the day without paging through it', async () => {
      await collected(COD_AMOUNT);
      await collected(COD_AMOUNT - 4_000);
      const token = await financeToken();

      const res = await request(ctx.server)
        .get(`${COD_BASE}/summary`)
        .set(...auth(token));

      expect(res.status).toBe(200);
      const summary = body(res);
      expect(summary.count).toBe(2);
      expect(summary.expectedAmount).toBe(COD_AMOUNT * 2);
      expect(summary.collectedAmount).toBe(COD_AMOUNT * 2 - 4_000);
      // Neither has been reconciled, so both are outstanding; one disagrees with expectation.
      expect(summary.outstandingCount).toBe(2);
      expect(summary.discrepancyCount).toBe(1);
      expect(summary.remittedAmount).toBe(0);
    });
  });
});
