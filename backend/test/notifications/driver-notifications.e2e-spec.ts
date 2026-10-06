import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { AcceptJobOfferCommand } from '../../src/modules/delivery/application/commands/accept-job-offer.command';
import { AdvanceDeliveryJobCommand } from '../../src/modules/delivery/application/commands/advance-delivery-job.command';
import { CaptureProofOfDeliveryCommand } from '../../src/modules/delivery/application/commands/capture-proof-of-delivery.command';
import { CreateDriverProfileCommand } from '../../src/modules/delivery/application/commands/create-driver-profile.command';
import { ManageDriverShiftCommand } from '../../src/modules/delivery/application/commands/manage-driver-shift.command';
import { RecordCodCollectionCommand } from '../../src/modules/delivery/application/commands/record-cod-collection.command';
import { SetDriverAvailabilityCommand } from '../../src/modules/delivery/application/commands/set-driver-availability.command';
import { UpdateDriverLocationCommand } from '../../src/modules/delivery/application/commands/update-driver-location.command';
import { CodCollectionMethod, DeliveryJobStatus, DriverAvailability, PodType } from '../../src/modules/delivery/domain/enums';
import { VehicleType } from '../../src/modules/delivery/domain/value-objects/vehicle.vo';
import { DomainEvent } from '../../src/shared/events/domain-event';
import { EventBusService } from '../../src/shared/events/event-bus.service';
import { auth, body, createUserWithRole } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { placeOrder, PlacedOrder } from '../orders/support';

interface Item {
  id: string;
  type: string | null;
  category: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  read: boolean;
}

interface Driver {
  userId: string;
  profileId: string;
  accessToken: string;
  phone: string;
  plateNumber: string;
}

const DRIVER_TYPES = [
  'DRIVER_JOB_OFFERED',
  'DRIVER_EARNING_ACCRUED',
  'DRIVER_COD_REMITTED',
  'DRIVER_COD_RECONCILED',
  'DRIVER_COD_CORRECTION_RECORDED',
];
const COD_BASE = '/admin/delivery/cod-reconciliation';
const CORRECTION_REASON = 'Cash desk recount, supervisor note 7731';

/**
 * Module 13 Work 05 against real PostgreSQL and the real HTTP stack.
 *
 * One delivery, the platform's own, produces all five driver events: a real checkout and pharmacy
 * readiness (Module 06); Module 08's `order.ready` consumer creating the job and its
 * `delivery.job.created` consumer dispatching it to driver A (offer); the driver's commands taking
 * it to delivered and Module 08's completion consumer accruing the earning; and a finance officer
 * remitting, reconciling and correcting the COD through Module 08's admin routes. Every event goes
 * through the real outbox relay, and every recipient through the real Module 08 driver port.
 */
describe('Driver notifications (e2e)', () => {
  let ctx: TestContext;
  let accept: AcceptJobOfferCommand;
  let advance: AdvanceDeliveryJobCommand;
  let capturePod: CaptureProofOfDeliveryCommand;
  let recordCod: RecordCodCollectionCommand;
  let createProfile: CreateDriverProfileCommand;
  let shift: ManageDriverShiftCommand;
  let availability: SetDriverAvailabilityCommand;
  let location: UpdateDriverLocationCommand;

  beforeAll(async () => {
    ctx = await createTestApp();
    accept = ctx.app.get(AcceptJobOfferCommand);
    advance = ctx.app.get(AdvanceDeliveryJobCommand);
    capturePod = ctx.app.get(CaptureProofOfDeliveryCommand);
    recordCod = ctx.app.get(RecordCodCollectionCommand);
    createProfile = ctx.app.get(CreateDriverProfileCommand);
    shift = ctx.app.get(ManageDriverShiftCommand);
    availability = ctx.app.get(SetDriverAvailabilityCommand);
    location = ctx.app.get(UpdateDriverLocationCommand);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  // -------------------------------------------------------------------------------------------
  // Fixtures — Modules 01, 06 and 08's own commands and routes
  // -------------------------------------------------------------------------------------------

  /** A verified driver with a profile; `online` puts them on shift and dispatchable at the branch. */
  async function seedDriver(online: boolean): Promise<Driver> {
    const user = await createUserWithRole(ctx, 'DRIVER');
    await ctx.prisma.user.update({ where: { id: user.userId }, data: { primaryRole: 'DRIVER' } });
    await ctx.prisma.verificationRequest.create({
      data: { userId: user.userId, type: 'DRIVER_DOCS', status: 'APPROVED', reviewedAt: new Date() },
    });
    const plateNumber = `AA-${Math.floor(10_000 + Math.random() * 89_999)}`;
    const { profile } = await createProfile.execute({
      userId: user.userId,
      vehicleType: VehicleType.Motorcycle,
      plateNumber,
      serviceArea: { lat: 9.02, lng: 38.75, radiusMeters: 20_000 },
    });
    if (online) {
      await shift.start({ userId: user.userId });
      await availability.execute({ userId: user.userId, availability: DriverAvailability.ONLINE });
      await location.execute({ userId: user.userId, lat: 9.02, lng: 38.75 });
    }
    return { userId: user.userId, profileId: profile.id, accessToken: user.accessToken, phone: user.phone, plateNumber };
  }

  const finance = () => createUserWithRole(ctx, 'FINANCE_OFFICER');

  /** Order ready → Module 08 creates the job and offers it to the one dispatchable driver. */
  async function offered(): Promise<{ order: PlacedOrder; jobId: string }> {
    const order = await placeOrder(ctx);
    for (const action of ['accept', 'prepare', 'ready']) {
      await request(ctx.server).post(`/pharmacy/orders/${order.fulfillmentId}/${action}`).set(...auth(order.pharmacy.accessToken)).expect(200);
    }
    await ctx.drainOutbox();
    const job = await ctx.prisma.deliveryJob.findFirstOrThrow({ where: { orderId: order.orderId } });
    expect(job.status).toBe(DeliveryJobStatus.OFFERED);
    return { order, jobId: job.id };
  }

  /** Accept → door → COD → PoD → delivered; Module 08's completion consumer accrues the earning. */
  async function delivered(driver: Driver, jobId: string): Promise<string> {
    await accept.execute({ userId: driver.userId, jobId });
    for (const to of [DeliveryJobStatus.ARRIVED_PICKUP, DeliveryJobStatus.PICKED_UP, DeliveryJobStatus.EN_ROUTE, DeliveryJobStatus.ARRIVED_DROPOFF]) {
      await advance.byDriver({ userId: driver.userId, jobId, to });
    }
    const job = await ctx.prisma.deliveryJob.findUniqueOrThrow({ where: { id: jobId } });
    const { collection } = await recordCod.execute({
      userId: driver.userId,
      jobId,
      collectedAmount: job.codAmount ?? 0,
      method: CodCollectionMethod.CASH,
      providerReference: null,
    });
    await capturePod.execute({ userId: driver.userId, jobId, type: PodType.CONFIRMATION, recipientName: 'Selam', recipientConfirmed: true });
    await advance.byDriver({ userId: driver.userId, jobId, to: DeliveryJobStatus.DELIVERED });
    await ctx.drainOutbox();
    return collection.id;
  }

  /** The finance half, through Module 08's admin routes: remit, reconcile, correct. */
  async function financeCod(collectionId: string, amount: number): Promise<void> {
    const officer = await finance();
    await request(ctx.server)
      .post(`${COD_BASE}/${collectionId}/remit`)
      .set(...auth(officer.accessToken))
      .send({ remittedAmount: amount, reference: 'CASHDESK-2026-10-06' })
      .expect(200);
    await request(ctx.server).post(`${COD_BASE}/${collectionId}/reconcile`).set(...auth(officer.accessToken)).send({ reference: 'RECON-01' }).expect(200);
    await request(ctx.server)
      .post(`${COD_BASE}/${collectionId}/corrections`)
      .set(...auth(officer.accessToken))
      .send({
        type: 'RECORDING_MISTAKE',
        originalAmount: amount,
        correctedAmount: amount - 100,
        reason: CORRECTION_REASON,
        idempotencyKey: `corr-${randomUUID()}`,
      })
      .expect(200);
    await ctx.drainOutbox();
  }

  /** The whole journey; returns the actors and identifiers the assertions need. */
  async function journey() {
    const driverA = await seedDriver(true);
    const driverB = await seedDriver(false);
    const { order, jobId } = await offered();
    const collectionId = await delivered(driverA, jobId);
    const job = await ctx.prisma.deliveryJob.findUniqueOrThrow({ where: { id: jobId } });
    await financeCod(collectionId, job.codAmount ?? 0);
    return { driverA, driverB, order, jobId, collectionId, codAmount: job.codAmount ?? 0 };
  }

  const inbox = async (token: string, query: Record<string, unknown> = {}) =>
    (body(await request(ctx.server).get('/notifications').query(query).set(...auth(token)).expect(200)) as { items: Item[] })
      .items;
  const driverItems = async (token: string) => (await inbox(token)).filter((i) => DRIVER_TYPES.includes(i.type ?? ''));

  // ===========================================================================================
  // 1. The five events, from one real delivery
  // ===========================================================================================

  describe('events', () => {
    it('driver A receives exactly one of each of the five; driver B and the customer receive none', async () => {
      const { driverA, driverB, order, jobId, codAmount } = await journey();
      const earning = await ctx.prisma.driverEarning.findFirstOrThrow({ where: { jobId } });
      const offer = await ctx.prisma.jobOffer.findFirstOrThrow({ where: { jobId } });

      const items = await driverItems(driverA.accessToken);
      expect(items.map((i) => i.type).sort()).toEqual([...DRIVER_TYPES].sort());
      const byType = Object.fromEntries(items.map((i) => [i.type, i]));
      expect(byType.DRIVER_JOB_OFFERED).toMatchObject({
        category: 'TRANSACTIONAL',
        title: 'New delivery offer',
        data: { jobId, expiresAt: offer.expiresAt.toISOString() },
      });
      expect(byType.DRIVER_EARNING_ACCRUED).toMatchObject({ title: 'Earning recorded', data: { jobId, amount: earning.total, currency: 'ETB' } });
      expect(byType.DRIVER_COD_REMITTED).toMatchObject({
        title: 'Cash handover confirmed',
        data: { jobId, remittedAmount: codAmount, currency: 'ETB', reference: 'CASHDESK-2026-10-06' },
      });
      expect(byType.DRIVER_COD_RECONCILED).toMatchObject({ data: { jobId, outcome: 'ACCEPTED' } });
      expect(byType.DRIVER_COD_CORRECTION_RECORDED).toMatchObject({ data: { jobId, correctionType: 'RECORDING_MISTAKE' } });

      expect(await inbox(driverB.accessToken)).toEqual([]);
      expect((await inbox(order.customer.accessToken)).filter((i) => DRIVER_TYPES.includes(i.type ?? ''))).toEqual([]);
      const stored = await ctx.prisma.notification.findMany({ where: { templateCode: { in: DRIVER_TYPES } } });
      expect(stored).toHaveLength(5);
      expect(stored.every((n) => n.recipientUserId === driverA.userId && n.channel === 'IN_APP' && n.status === 'SENT')).toBe(true);
    });

    it('renders in the driver’s language, read from Module 01', async () => {
      const driverA = await seedDriver(true);
      await request(ctx.server).patch('/users/me').set(...auth(driverA.accessToken)).send({ preferredLanguage: 'am' }).expect(200);
      await offered();
      expect(await driverItems(driverA.accessToken)).toEqual([
        expect.objectContaining({ type: 'DRIVER_JOB_OFFERED', title: 'አዲስ የማድረስ ሥራ ቀርቦልዎታል' }),
      ]);
    });
  });

  // ===========================================================================================
  // 2. Idempotency, inbox, privacy, audit
  // ===========================================================================================

  describe('idempotency', () => {
    it('a redelivered or concurrently delivered job offer writes one notification', async () => {
      const driverA = await seedDriver(true);
      const { jobId } = await offered();
      // Module 08 has no consumer of its own on job.offered, so replaying it touches nothing else.
      for (let i = 0; i < 2; i += 1) {
        await ctx.prisma.outbox.updateMany({ where: { eventType: 'delivery.job.offered', aggregateId: jobId }, data: { publishedAt: null } });
        await ctx.drainOutbox();
      }
      const row = await ctx.prisma.outbox.findFirstOrThrow({ where: { eventType: 'delivery.job.offered', aggregateId: jobId } });
      await Promise.all(Array.from({ length: 5 }, () => ctx.app.get(EventBusService).publish(row.payload as unknown as DomainEvent)));
      expect(await ctx.prisma.notification.count({ where: { templateCode: 'DRIVER_JOB_OFFERED', recipientUserId: driverA.userId } })).toBe(1);
    });
  });

  describe('inbox', () => {
    it('serves them through GET /notifications; driver A marks one READ, driver B cannot', async () => {
      const driverA = await seedDriver(true);
      const driverB = await seedDriver(false);
      await offered();
      const [offer] = await driverItems(driverA.accessToken);

      await request(ctx.server).post(`/notifications/${offer.id}/read`).set(...auth(driverB.accessToken)).send({}).expect(404);
      expect((await ctx.prisma.notification.findUniqueOrThrow({ where: { id: offer.id } })).status).toBe('SENT');
      const read = body(await request(ctx.server).post(`/notifications/${offer.id}/read`).set(...auth(driverA.accessToken)).send({}).expect(200));
      expect(read).toMatchObject({ id: offer.id, type: 'DRIVER_JOB_OFFERED', read: true });
      expect((await ctx.prisma.notification.findUniqueOrThrow({ where: { id: offer.id } })).status).toBe('READ');
    });

    it('carries no contact, vehicle, location, internal id, operator, provider or finance-internal data', async () => {
      const { driverA, order, collectionId } = await journey();
      const officerIds = (await ctx.prisma.codRemittance.findMany()).map((r) => r.confirmedByUserId);
      const stored = JSON.stringify(await ctx.prisma.notification.findMany({ where: { templateCode: { in: DRIVER_TYPES } } }));
      const served = JSON.stringify(await driverItems(driverA.accessToken));
      for (const f of [
        driverA.profileId, driverA.phone, driverA.plateNumber, order.customer.userId, order.customer.phone,
        order.orderId, order.fulfillmentId, collectionId, ...officerIds,
        'driverId', 'orderId', 'fulfillmentId', 'collectionId', 'confirmedByUserId', 'reconciledByUserId', 'createdByUserId',
        'providerReference', 'calculationVersion', 'expectedAmount', 'collectedAmount', 'originalAmount', 'correctedAmount',
        CORRECTION_REASON, '7731', '"lat"', '"lng"', 'Selam',
      ]) {
        expect({ f, stored: stored.includes(f), served: served.includes(f) }).toEqual({ f, stored: false, served: false });
      }
      expect(served).not.toContain(driverA.userId);
    });

    it('creation wrote no Module 13 audit entry; reads, count, read and read-all append none', async () => {
      const { driverA } = await journey();
      expect(
        await ctx.prisma.auditLog.count({ where: { OR: [{ resourceType: { contains: 'otification' } }, { action: { contains: 'NOTIFICATION' } }] } }),
      ).toBe(0);
      const before = await ctx.prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } });
      const [first] = await driverItems(driverA.accessToken);
      await request(ctx.server).get('/notifications/unread-count').set(...auth(driverA.accessToken)).expect(200);
      await request(ctx.server).post(`/notifications/${first.id}/read`).set(...auth(driverA.accessToken)).send({}).expect(200);
      await request(ctx.server).post('/notifications/read-all').set(...auth(driverA.accessToken)).send({}).expect(200);
      expect(await ctx.prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } })).toEqual(before);
    });
  });

  // ===========================================================================================
  // 3. Boundaries
  // ===========================================================================================

  describe('boundaries', () => {
    const moduleRoot = join(__dirname, '..', '..', 'src', 'modules', 'notifications');
    const files = (): string[] => {
      const out: string[] = [];
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          if (statSync(full).isDirectory()) walk(full);
          else if (full.endsWith('.ts') && !full.endsWith('.spec.ts')) out.push(full);
        }
      };
      walk(moduleRoot);
      return out;
    };

    it('Module 13 never touches Module 08 driver persistence, repositories, entities or infrastructure', () => {
      for (const file of files()) {
        const source = readFileSync(file, 'utf8');
        for (const forbidden of [
          'prisma.driverProfile',
          'prisma.driverEarning',
          'prisma.deliveryJob',
          'prisma.jobOffer',
          'prisma.cod',
          'DRIVER_PROFILE_REPOSITORY',
          'DELIVERY_JOB_REPOSITORY',
          'delivery/domain/entities',
          'delivery/domain/repositories',
          'delivery/domain/enums',
          'delivery/infrastructure/',
          'delivery/application/commands/',
          'delivery/application/queries/',
          'delivery/application/ports/outbound',
        ]) {
          expect({ file, forbidden, found: source.includes(forbidden) }).toEqual({ file, forbidden, found: false });
        }
      }
    });

    it('Module 13 reaches Module 08 only through the driver-recipient port, the event contract and DeliveryModule', () => {
      const imports = new Set<string>();
      for (const file of files()) {
        for (const m of readFileSync(file, 'utf8').matchAll(/from '(?:\.\.\/)+(delivery\/[^']*)'/g)) imports.add(m[1]);
      }
      expect([...imports].sort()).toEqual([
        'delivery/application/ports/inbound/driver-recipient-read.port',
        'delivery/delivery.module',
        'delivery/domain/events',
      ]);
    });
  });
});
