import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { AcceptJobOfferCommand } from '../../src/modules/delivery/application/commands/accept-job-offer.command';
import { CreateDriverProfileCommand } from '../../src/modules/delivery/application/commands/create-driver-profile.command';
import { ManageDriverShiftCommand } from '../../src/modules/delivery/application/commands/manage-driver-shift.command';
import { SetDriverAvailabilityCommand } from '../../src/modules/delivery/application/commands/set-driver-availability.command';
import { UpdateDriverLocationCommand } from '../../src/modules/delivery/application/commands/update-driver-location.command';
import { DeliveryJobStatus, DriverAvailability } from '../../src/modules/delivery/domain/enums';
import { VehicleType } from '../../src/modules/delivery/domain/value-objects/vehicle.vo';
import { DomainEvent } from '../../src/shared/events/domain-event';
import { EventBusService } from '../../src/shared/events/event-bus.service';
import { auth, body, createUserWithRole } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { placeOrder, PlacedOrder } from '../orders/support';

interface Item {
  id: string;
  type: string | null;
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

/**
 * Module 13 Work 09 against real PostgreSQL and the real HTTP stack.
 *
 * The assignment is the platform's own: a real order made ready by its pharmacy, Module 08's
 * consumers creating the job and offering it to driver A, and driver A accepting through
 * `AcceptJobOfferCommand` — the only publisher of `delivery.job.assigned`. Events go through the
 * real outbox relay, and the recipient through Work 05's real `DRIVER_RECIPIENT_READ_PORT`.
 */
describe('Driver job-assigned notification (e2e)', () => {
  let ctx: TestContext;
  let accept: AcceptJobOfferCommand;
  let createProfile: CreateDriverProfileCommand;
  let shift: ManageDriverShiftCommand;
  let availability: SetDriverAvailabilityCommand;
  let location: UpdateDriverLocationCommand;

  beforeAll(async () => {
    ctx = await createTestApp();
    accept = ctx.app.get(AcceptJobOfferCommand);
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

  /** A verified driver with a profile; `online` makes them dispatchable at the test branch. */
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

  /** Order ready → Module 08 creates the job and offers it; then driver A accepts → assigned. */
  async function assigned(driver: Driver): Promise<{ order: PlacedOrder; jobId: string }> {
    const order = await placeOrder(ctx);
    for (const action of ['accept', 'prepare', 'ready']) {
      await request(ctx.server).post(`/pharmacy/orders/${order.fulfillmentId}/${action}`).set(...auth(order.pharmacy.accessToken)).expect(200);
    }
    await ctx.drainOutbox();
    const job = await ctx.prisma.deliveryJob.findFirstOrThrow({ where: { orderId: order.orderId } });
    expect(job.status).toBe(DeliveryJobStatus.OFFERED);
    await accept.execute({ userId: driver.userId, jobId: job.id });
    await ctx.drainOutbox();
    expect((await ctx.prisma.deliveryJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe(DeliveryJobStatus.ASSIGNED);
    return { order, jobId: job.id };
  }

  const inbox = async (token: string, query: Record<string, unknown> = {}) =>
    (body(await request(ctx.server).get('/notifications').query(query).set(...auth(token)).expect(200)) as { items: Item[] }).items;
  const ofType = async (token: string, type: string) => (await inbox(token)).filter((i) => i.type === type);

  it('driver A receives exactly one DRIVER_JOB_ASSIGNED; driver B and the customer receive no driver notification', async () => {
    const driverA = await seedDriver(true);
    const driverB = await seedDriver(false);
    const { order, jobId } = await assigned(driverA);

    expect(await ofType(driverA.accessToken, 'DRIVER_JOB_ASSIGNED')).toEqual([
      expect.objectContaining({
        title: 'Delivery job assigned',
        body: 'This delivery job is now assigned to you.',
        data: { jobId },
        read: false,
      }),
    ]);
    expect(await inbox(driverB.accessToken)).toEqual([]);
    expect((await inbox(order.customer.accessToken)).filter((i) => (i.type ?? '').startsWith('DRIVER_'))).toEqual([]);

    const stored = await ctx.prisma.notification.findFirstOrThrow({ where: { templateCode: 'DRIVER_JOB_ASSIGNED' } });
    expect(stored).toMatchObject({ recipientUserId: driverA.userId, channel: 'IN_APP', status: 'SENT', eventType: 'delivery.job.assigned' });
    const envelope = await ctx.prisma.outbox.findFirstOrThrow({ where: { eventType: 'delivery.job.assigned', aggregateId: jobId } });
    expect(stored.dedupeKey).toBe(`${(envelope.payload as unknown as DomainEvent).id}:${driverA.userId}`);
  });

  it('stays a separate notification from the job offer for the same job', async () => {
    const driverA = await seedDriver(true);
    const { jobId } = await assigned(driverA);
    const offered = await ofType(driverA.accessToken, 'DRIVER_JOB_OFFERED');
    const assignedItems = await ofType(driverA.accessToken, 'DRIVER_JOB_ASSIGNED');
    expect([offered.length, assignedItems.length]).toEqual([1, 1]);
    expect(offered[0].data.jobId).toBe(jobId);
    expect(assignedItems[0].data).toEqual({ jobId });
    expect(offered[0].id).not.toBe(assignedItems[0].id);
  });

  it('a redelivered or concurrently delivered assignment writes one notification', async () => {
    const driverA = await seedDriver(true);
    const { jobId } = await assigned(driverA);
    // Module 08 has no consumer of its own on job.assigned, so replaying it touches nothing else.
    for (let i = 0; i < 2; i += 1) {
      await ctx.prisma.outbox.updateMany({ where: { eventType: 'delivery.job.assigned', aggregateId: jobId }, data: { publishedAt: null } });
      await ctx.drainOutbox();
    }
    const row = await ctx.prisma.outbox.findFirstOrThrow({ where: { eventType: 'delivery.job.assigned', aggregateId: jobId } });
    await Promise.all(Array.from({ length: 5 }, () => ctx.app.get(EventBusService).publish(row.payload as unknown as DomainEvent)));
    expect(await ctx.prisma.notification.count({ where: { templateCode: 'DRIVER_JOB_ASSIGNED' } })).toBe(1);
    expect(await ctx.prisma.notification.count({ where: { templateCode: 'DRIVER_JOB_OFFERED' } })).toBe(1);
  });

  it('serves it through GET /notifications; driver A marks it READ, another user cannot', async () => {
    const driverA = await seedDriver(true);
    const driverB = await seedDriver(false);
    const { order } = await assigned(driverA);
    const [n] = await ofType(driverA.accessToken, 'DRIVER_JOB_ASSIGNED');

    for (const other of [driverB, order.customer]) {
      await request(ctx.server).post(`/notifications/${n.id}/read`).set(...auth(other.accessToken)).send({}).expect(404);
    }
    expect((await ctx.prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).status).toBe('SENT');
    const read = body(await request(ctx.server).post(`/notifications/${n.id}/read`).set(...auth(driverA.accessToken)).send({}).expect(200));
    expect(read).toMatchObject({ id: n.id, type: 'DRIVER_JOB_ASSIGNED', read: true });
    expect((await ctx.prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).status).toBe('READ');
  });

  it('stores and serves no customer contact, driver profile, vehicle, location, order, offer or COD data', async () => {
    const driverA = await seedDriver(true);
    const { order, jobId } = await assigned(driverA);
    const offer = await ctx.prisma.jobOffer.findFirstOrThrow({ where: { jobId } });
    const stored = JSON.stringify(await ctx.prisma.notification.findMany({ where: { templateCode: 'DRIVER_JOB_ASSIGNED' } }));
    const served = JSON.stringify(await ofType(driverA.accessToken, 'DRIVER_JOB_ASSIGNED'));
    for (const f of [
      order.customer.userId, order.customer.phone, driverA.profileId, driverA.phone, driverA.plateNumber, order.orderId, offer.id,
      order.fulfillmentId, 'driverId', 'offerId', 'orderId', '"lat"', '"lng"', 'codAmount', 'Bole',
    ]) {
      expect({ f, stored: stored.includes(f), served: served.includes(f) }).toEqual({ f, stored: false, served: false });
    }
    expect(served).not.toContain(driverA.userId);
  });

  it('creation wrote no Module 13 audit entry; reads, count, read and read-all append none', async () => {
    const driverA = await seedDriver(true);
    await assigned(driverA);
    expect(
      await ctx.prisma.auditLog.count({ where: { OR: [{ resourceType: { contains: 'otification' } }, { action: { contains: 'NOTIFICATION' } }] } }),
    ).toBe(0);
    const before = await ctx.prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } });
    const [n] = await ofType(driverA.accessToken, 'DRIVER_JOB_ASSIGNED');
    await request(ctx.server).get('/notifications/unread-count').set(...auth(driverA.accessToken)).expect(200);
    await request(ctx.server).post(`/notifications/${n.id}/read`).set(...auth(driverA.accessToken)).send({}).expect(200);
    await request(ctx.server).post('/notifications/read-all').set(...auth(driverA.accessToken)).send({}).expect(200);
    expect(await ctx.prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } })).toEqual(before);
  });

  it('Module 13’s Module 08 imports are unchanged by Work 09: the driver-recipient port, the event contract and the module', () => {
    const root = join(__dirname, '..', '..', 'src', 'modules', 'notifications');
    const imports = new Set<string>();
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.ts') && !full.endsWith('.spec.ts')) {
          const source = readFileSync(full, 'utf8');
          for (const forbidden of ['prisma.deliveryJob', 'prisma.driverProfile', 'prisma.jobOffer', 'delivery/infrastructure/', 'delivery/domain/entities', 'delivery/domain/repositories']) {
            expect({ full, forbidden, found: source.includes(forbidden) }).toEqual({ full, forbidden, found: false });
          }
          for (const m of source.matchAll(/from '(?:\.\.\/)+(delivery\/[^']*)'/g)) imports.add(m[1]);
        }
      }
    };
    walk(root);
    expect([...imports].sort()).toEqual([
      'delivery/application/ports/inbound/driver-recipient-read.port',
      'delivery/delivery.module',
      'delivery/domain/events',
    ]);
  });
});
