import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
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
import { createCustomer, placeOrder, PlacedOrder } from '../orders/support';

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
  phone: string;
  plateNumber: string;
}

const DELIVERY_TYPES = ['DELIVERY_PICKED_UP', 'DELIVERY_EN_ROUTE', 'DELIVERY_DELIVERED', 'DELIVERY_FAILED'];
const FAIL_REASON = 'Recipient not home; driver called +251911998877 twice';

/**
 * Module 13 Work 04 against real PostgreSQL and the real HTTP stack.
 *
 * The delivery is the platform's own, end to end: a real checkout (Module 06), the pharmacy
 * accepting and marking it ready through its routes, Module 08's `order.ready` consumer creating
 * the job and its `delivery.job.created` consumer dispatching it to a real, online driver, and the
 * driver moving it through Module 08's commands. Every event is published by the real outbox relay,
 * and the customer is resolved by the real Module 06 recipient port. What can only be shown here:
 * that customer A hears each step exactly once, customer B never, and the courier's identity never
 * reaches the customer.
 */
describe('Delivery notifications (e2e)', () => {
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
  // Fixtures — through Modules 01, 06 and 08's own commands and routes
  // -------------------------------------------------------------------------------------------

  /** A verified, on-shift, ONLINE driver at the test branch's coordinates — dispatchable. */
  async function seedDriver(): Promise<Driver> {
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
    await shift.start({ userId: user.userId });
    await availability.execute({ userId: user.userId, availability: DriverAvailability.ONLINE });
    await location.execute({ userId: user.userId, lat: 9.02, lng: 38.75 });
    return { userId: user.userId, profileId: profile.id, phone: user.phone, plateNumber };
  }

  /** A real order, accepted and marked ready by its pharmacy; Module 08 creates and offers the job. */
  async function readyForDriver(driver: Driver): Promise<{ order: PlacedOrder; jobId: string }> {
    const order = await placeOrder(ctx);
    for (const action of ['accept', 'prepare', 'ready']) {
      await request(ctx.server).post(`/pharmacy/orders/${order.fulfillmentId}/${action}`).set(...auth(order.pharmacy.accessToken)).expect(200);
    }
    await ctx.drainOutbox(); // order.ready → job created → job.created → offered to the driver
    const job = await ctx.prisma.deliveryJob.findFirstOrThrow({ where: { orderId: order.orderId } });
    expect(job.status).toBe(DeliveryJobStatus.OFFERED);
    await accept.execute({ userId: driver.userId, jobId: job.id });
    return { order, jobId: job.id };
  }

  const step = (driver: Driver, jobId: string, to: DeliveryJobStatus, reason?: string) =>
    advance.byDriver({ userId: driver.userId, jobId, to, reason });

  const inbox = async (token: string, query: Record<string, unknown> = {}) =>
    (body(await request(ctx.server).get('/notifications').query(query).set(...auth(token)).expect(200)) as { items: Item[] })
      .items;
  const deliveryItems = async (token: string) => (await inbox(token)).filter((i) => DELIVERY_TYPES.includes(i.type ?? ''));

  /** Picked up, on the way, delivered — the full customer-visible journey. */
  async function deliverAll(): Promise<{ order: PlacedOrder; jobId: string; driver: Driver }> {
    const driver = await seedDriver();
    const { order, jobId } = await readyForDriver(driver);
    await step(driver, jobId, DeliveryJobStatus.ARRIVED_PICKUP);
    await step(driver, jobId, DeliveryJobStatus.PICKED_UP);
    await step(driver, jobId, DeliveryJobStatus.EN_ROUTE);
    await step(driver, jobId, DeliveryJobStatus.ARRIVED_DROPOFF);
    const job = await ctx.prisma.deliveryJob.findUniqueOrThrow({ where: { id: jobId } });
    await recordCod.execute({
      userId: driver.userId,
      jobId,
      collectedAmount: job.codAmount ?? 0,
      method: CodCollectionMethod.CASH,
      providerReference: null,
    });
    await capturePod.execute({ userId: driver.userId, jobId, type: PodType.CONFIRMATION, recipientName: 'Selam', recipientConfirmed: true });
    await step(driver, jobId, DeliveryJobStatus.DELIVERED);
    await ctx.drainOutbox();
    return { order, jobId, driver };
  }

  // ===========================================================================================
  // 1. The four events, caused by the platform's own delivery path
  // ===========================================================================================

  describe('events', () => {
    it('picked up, on the way, delivered → customer A, exactly once each; customer B and the courier get none', async () => {
      const customerB = await createCustomer(ctx);
      const { order, driver, jobId } = await deliverAll();

      const items = await deliveryItems(order.customer.accessToken);
      expect(items.map((i) => [i.type, i.category, i.title, i.data, i.read])).toEqual([
        ['DELIVERY_DELIVERED', 'TRANSACTIONAL', 'Order delivered', { orderId: order.orderId }, false],
        ['DELIVERY_EN_ROUTE', 'TRANSACTIONAL', 'Order on the way', { orderId: order.orderId }, false],
        ['DELIVERY_PICKED_UP', 'TRANSACTIONAL', 'Order picked up', { orderId: order.orderId }, false],
      ]);
      expect(await inbox(customerB.accessToken)).toEqual([]);
      // No customer delivery notification reaches the courier. (Since Work 05 the courier does
      // receive their own DRIVER_* notifications for this job — offer and earning.)
      expect(
        await ctx.prisma.notification.count({ where: { recipientUserId: driver.userId, templateCode: { in: DELIVERY_TYPES } } }),
      ).toBe(0);

      const stored = await ctx.prisma.notification.findMany({ where: { templateCode: { in: DELIVERY_TYPES } } });
      expect(stored.every((n) => n.recipientUserId === order.customer.userId && n.channel === 'IN_APP' && n.status === 'SENT')).toBe(true);
      const pickedUp = await ctx.prisma.outbox.findFirstOrThrow({ where: { eventType: 'delivery.order.picked_up', aggregateId: jobId } });
      expect(stored.find((n) => n.templateCode === 'DELIVERY_PICKED_UP')!.dedupeKey).toBe(
        `${(pickedUp.payload as unknown as DomainEvent).id}:${order.customer.userId}`,
      );
    });

    it('delivery.failed → customer A, in Amharic, without the driver’s free-text reason', async () => {
      const driver = await seedDriver();
      const { order, jobId } = await readyForDriver(driver);
      await request(ctx.server).patch('/users/me').set(...auth(order.customer.accessToken)).send({ preferredLanguage: 'am' }).expect(200);
      await step(driver, jobId, DeliveryJobStatus.ARRIVED_PICKUP);
      await step(driver, jobId, DeliveryJobStatus.PICKED_UP);
      await step(driver, jobId, DeliveryJobStatus.FAILED, FAIL_REASON);
      await ctx.drainOutbox();

      const items = await deliveryItems(order.customer.accessToken);
      expect(items.map((i) => i.type)).toEqual(['DELIVERY_FAILED', 'DELIVERY_PICKED_UP']);
      expect(items[0]).toMatchObject({ title: 'ማድረስ አልተቻለም', body: 'ትዕዛዝዎን ማድረስ አልተቻለም።', data: { orderId: order.orderId } });
      const stored = JSON.stringify(await ctx.prisma.notification.findMany({ where: { templateCode: 'DELIVERY_FAILED' } }));
      for (const forbidden of ['Recipient not home', '+251911998877', 'reason']) {
        expect({ forbidden, found: stored.includes(forbidden) }).toEqual({ forbidden, found: false });
      }
    });
  });

  // ===========================================================================================
  // 2. Idempotency, inbox, privacy, audit
  // ===========================================================================================

  describe('idempotency', () => {
    it('a redelivered or concurrently delivered delivery event writes one notification', async () => {
      const driver = await seedDriver();
      const { order, jobId } = await readyForDriver(driver);
      await step(driver, jobId, DeliveryJobStatus.ARRIVED_PICKUP);
      await step(driver, jobId, DeliveryJobStatus.PICKED_UP);
      await ctx.drainOutbox();

      // Module 08 has no consumer of its own on picked_up, so replaying it touches nothing else.
      for (let i = 0; i < 2; i += 1) {
        await ctx.prisma.outbox.updateMany({ where: { eventType: 'delivery.order.picked_up', aggregateId: jobId }, data: { publishedAt: null } });
        await ctx.drainOutbox();
      }
      const row = await ctx.prisma.outbox.findFirstOrThrow({ where: { eventType: 'delivery.order.picked_up', aggregateId: jobId } });
      await Promise.all(Array.from({ length: 5 }, () => ctx.app.get(EventBusService).publish(row.payload as unknown as DomainEvent)));

      expect(
        await ctx.prisma.notification.count({ where: { templateCode: 'DELIVERY_PICKED_UP', recipientUserId: order.customer.userId } }),
      ).toBe(1);
    });
  });

  describe('inbox', () => {
    it('serves the notifications through GET /notifications; the owner marks one READ, another customer cannot', async () => {
      const customerB = await createCustomer(ctx);
      const { order } = await deliverAll();
      const [delivered] = await deliveryItems(order.customer.accessToken);

      await request(ctx.server).post(`/notifications/${delivered.id}/read`).set(...auth(customerB.accessToken)).send({}).expect(404);
      expect((await ctx.prisma.notification.findUniqueOrThrow({ where: { id: delivered.id } })).status).toBe('SENT');

      const read = body(
        await request(ctx.server).post(`/notifications/${delivered.id}/read`).set(...auth(order.customer.accessToken)).send({}).expect(200),
      );
      expect(read).toMatchObject({ id: delivered.id, type: 'DELIVERY_DELIVERED', read: true });
      expect((await ctx.prisma.notification.findUniqueOrThrow({ where: { id: delivered.id } })).status).toBe('READ');
      expect((await inbox(order.customer.accessToken, { unread: 'true' })).map((i) => i.id)).not.toContain(delivered.id);
    });

    it('carries no driver identifier, contact, vehicle, job or fulfillment data, stored or served', async () => {
      const { order, driver, jobId } = await deliverAll();
      const stored = JSON.stringify(await ctx.prisma.notification.findMany({ where: { templateCode: { in: DELIVERY_TYPES } } }));
      const served = JSON.stringify(await deliveryItems(order.customer.accessToken));
      for (const f of [
        driver.userId, driver.profileId, driver.phone, driver.plateNumber, jobId, order.fulfillmentId,
        // Location as JSON keys: a bare 'lat' is inside the column name `templateCode`.
        'driverId', 'jobId', 'fulfillmentId', 'Selam', '"lat"', '"lng"', 'codAmount',
      ]) {
        expect({ f, stored: stored.includes(f), served: served.includes(f) }).toEqual({ f, stored: false, served: false });
      }
    });

    it('reads, the unread count, read and read-all append no audit entry; creation wrote none of Module 13’s', async () => {
      const { order } = await deliverAll();
      expect(
        await ctx.prisma.auditLog.count({
          where: { OR: [{ resourceType: { contains: 'otification' } }, { action: { contains: 'NOTIFICATION' } }] },
        }),
      ).toBe(0);

      const before = await ctx.prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } });
      const [first] = await deliveryItems(order.customer.accessToken);
      await request(ctx.server).get('/notifications/unread-count').set(...auth(order.customer.accessToken)).expect(200);
      await request(ctx.server).post(`/notifications/${first.id}/read`).set(...auth(order.customer.accessToken)).send({}).expect(200);
      await request(ctx.server).post('/notifications/read-all').set(...auth(order.customer.accessToken)).send({}).expect(200);
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

    it('Module 13 never touches Module 08 persistence, repositories, entities, commands, queries or infrastructure', () => {
      for (const file of files()) {
        const source = readFileSync(file, 'utf8');
        for (const forbidden of [
          'prisma.deliveryJob',
          'prisma.driverProfile',
          'prisma.jobOffer',
          'prisma.cod',
          'prisma.proofOfDelivery',
          'DELIVERY_JOB_REPOSITORY',
          'DRIVER_PROFILE_REPOSITORY',
          'delivery/domain/entities',
          'delivery/domain/repositories',
          'delivery/domain/enums',
          'delivery/infrastructure/',
          'delivery/application/commands/',
          'delivery/application/queries/',
          'delivery/application/ports/outbound',
          // Module 06, likewise, only through its recipient port.
          'prisma.order',
          'orders/domain/entities',
          'orders/domain/repositories',
          'orders/infrastructure/',
        ]) {
          expect({ file, forbidden, found: source.includes(forbidden) }).toEqual({ file, forbidden, found: false });
        }
      }
    });

    it('Module 13 takes nothing from Module 08 but its event contract and the driver-recipient port (Work 05)', () => {
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
