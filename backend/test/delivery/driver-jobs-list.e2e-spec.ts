import { randomUUID } from 'crypto';
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

const ROUTE = '/driver/jobs';

interface JobSummary {
  jobId: string;
  orderId: string;
  status: string;
  isCod: boolean;
  codAmount: number | null;
}

interface OfferSummary {
  offerId: string;
  round: number;
  expiresAt: string;
  job: JobSummary;
}

interface Page {
  items: JobSummary[];
  offers: OfferSummary[];
  total: number;
  page: number;
  size: number;
}

/**
 * `GET /driver/jobs` — the driver's own work (§9.1, deferred until Work 14).
 *
 * The scoping claims are the point of this suite. A read that returns "my jobs" is only worth
 * having if "my" cannot be widened, so most of what follows is an attempt to widen it: by query
 * parameter, by status, by token, by another driver's id. None of them may work.
 */
describe('Driver jobs list (e2e)', () => {
  let ctx: TestContext;
  let dispatch: DispatchDeliveryJobCommand;
  let accept: AcceptJobOfferCommand;
  let advance: AdvanceDeliveryJobCommand;
  let createProfile: CreateDriverProfileCommand;
  let shift: ManageDriverShiftCommand;
  let availability: SetDriverAvailabilityCommand;
  let location: UpdateDriverLocationCommand;

  const PICKUP = { lat: 9.03, lng: 38.74 };

  beforeAll(async () => {
    ctx = await createTestApp();
    dispatch = ctx.app.get(DispatchDeliveryJobCommand);
    accept = ctx.app.get(AcceptJobOfferCommand);
    advance = ctx.app.get(AdvanceDeliveryJobCommand);
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

  interface Driver {
    userId: string;
    profileId: string;
    token: string;
  }

  async function seedDriver(options: { online?: boolean } = {}): Promise<Driver> {
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
      serviceArea: null,
      maxConcurrent: 5,
    });
    if (options.online !== false) {
      await shift.start({ userId: user.userId });
      await availability.execute({ userId: user.userId, availability: DriverAvailability.ONLINE });
      await location.execute({ userId: user.userId, lat: PICKUP.lat, lng: PICKUP.lng });
    }
    return { userId: user.userId, profileId: profile.id, token: user.accessToken };
  }

  async function seedJob(): Promise<{ jobId: string; orderId: string }> {
    const order = await ctx.prisma.order.create({
      data: {
        orderNumber: `ORD-${randomUUID()}`,
        customerUserId: randomUUID(),
        status: 'PAID',
        subtotal: 20_000,
        grandTotal: 20_000,
        currency: 'ETB',
        idempotencyKey: `checkout-${randomUUID()}`,
      },
    });
    const job = await ctx.prisma.deliveryJob.create({
      data: {
        orderId: order.id,
        fulfillmentId: randomUUID(),
        pharmacyId: randomUUID(),
        branchId: randomUUID(),
        pickupLat: PICKUP.lat,
        pickupLng: PICKUP.lng,
        isCod: true,
        codAmount: 20_000,
        status: DeliveryJobStatus.CREATED,
      },
    });
    return { jobId: job.id, orderId: order.id };
  }

  /** A job this driver has accepted and is carrying. */
  async function carrying(driver: Driver): Promise<string> {
    const { jobId } = await seedJob();
    await dispatch.execute({ jobId });
    await accept.execute({ userId: driver.userId, jobId });
    return jobId;
  }

  function list(token: string, query = ''): request.Test {
    return request(ctx.server)
      .get(`${ROUTE}${query}`)
      .set(...auth(token));
  }

  function page(res: request.Response): Page {
    return body(res) as unknown as Page;
  }

  // -------------------------------------------------------------------------------------------
  // 1. What a driver sees
  // -------------------------------------------------------------------------------------------

  it('returns the jobs this driver is carrying', async () => {
    const driver = await seedDriver();
    const first = await carrying(driver);
    const second = await carrying(driver);

    const res = await list(driver.token);

    expect(res.status).toBe(200);
    expect(page(res).total).toBe(2);
    expect(page(res).items.map((j) => j.jobId).sort()).toEqual([first, second].sort());
  });

  it('reports a live offer separately from the jobs already held', async () => {
    const driver = await seedDriver();
    const held = await carrying(driver);
    const { jobId: offeredJob } = await seedJob();
    await dispatch.execute({ jobId: offeredJob });

    const res = await list(driver.token);

    expect(page(res).items.map((j) => j.jobId)).toEqual([held]);
    expect(page(res).offers).toHaveLength(1);
    expect(page(res).offers[0].job.jobId).toBe(offeredJob);
    // The countdown the handset draws.
    expect(new Date(page(res).offers[0].expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('drops an offer from the list once its deadline has passed', async () => {
    const driver = await seedDriver();
    const { jobId } = await seedJob();
    const offered = await dispatch.execute({ jobId });

    const past = Date.now() - 120_000;
    await ctx.prisma.jobOffer.update({
      where: { id: offered.offer!.id },
      data: { offeredAt: new Date(past), expiresAt: new Date(past + 30_000) },
    });

    // A lapsed offer is a closed question. Showing it would invite a tap that can only fail.
    expect(page(await list(driver.token)).offers).toHaveLength(0);
  });

  it('keeps a completed job visible and a reassigned one not', async () => {
    const driver = await seedDriver();
    const jobId = await carrying(driver);
    for (const to of [
      DeliveryJobStatus.ARRIVED_PICKUP,
      DeliveryJobStatus.PICKED_UP,
      DeliveryJobStatus.EN_ROUTE,
      DeliveryJobStatus.ARRIVED_DROPOFF,
      DeliveryJobStatus.DELIVERED,
    ]) {
      await advance.byDriver({ userId: driver.userId, jobId, to });
    }

    // "What did I just finish?" is a question a driver asks.
    expect(page(await list(driver.token)).items.map((j) => j.status)).toEqual([
      DeliveryJobStatus.DELIVERED,
    ]);

    // A job taken off them is no longer theirs, and leaves the list by virtue of the filter.
    const other = await carrying(driver);
    await ctx.prisma.deliveryJob.update({
      where: { id: other },
      data: { status: DeliveryJobStatus.REASSIGNING, assignedDriverId: null },
    });
    expect(page(await list(driver.token)).items.map((j) => j.jobId)).not.toContain(other);
  });

  it('narrows to one status inside the allow-list', async () => {
    const driver = await seedDriver();
    const assigned = await carrying(driver);
    const moved = await carrying(driver);
    await advance.byDriver({
      userId: driver.userId,
      jobId: moved,
      to: DeliveryJobStatus.ARRIVED_PICKUP,
    });

    const res = await list(driver.token, `?status=${DeliveryJobStatus.ASSIGNED}`);
    expect(page(res).items.map((j) => j.jobId)).toEqual([assigned]);
  });

  it('refuses a status outside the driver-visible set', async () => {
    const driver = await seedDriver();
    // `CREATED` is a real `DeliveryJobStatus`, so it passes the DTO's enum check and is stopped by
    // the query's allow-list instead — which is the layer that decides what a driver may ask.
    const res = await list(driver.token, `?status=${DeliveryJobStatus.CREATED}`);
    expect(res.status).toBe(400);
  });

  it('pages, and caps the page size', async () => {
    const driver = await seedDriver();
    await carrying(driver);
    await carrying(driver);
    await carrying(driver);

    const first = await list(driver.token, '?page=1&size=2');
    expect(page(first).items).toHaveLength(2);
    expect(page(first).total).toBe(3);

    const second = await list(driver.token, '?page=2&size=2');
    expect(page(second).items).toHaveLength(1);

    // Past the cap is rejected by the DTO rather than silently clamped.
    expect((await list(driver.token, '?size=500')).status).toBe(400);
  });

  // -------------------------------------------------------------------------------------------
  // 2. What a driver cannot see — the scoping claims
  // -------------------------------------------------------------------------------------------

  describe('scoping', () => {
    it('never returns another driver’s jobs', async () => {
      // Dispatch picks among *every* eligible driver, so each job is seeded while only its
      // intended carrier is online. Otherwise the offer could land on either one and the test
      // would be asserting against whichever way the ranking happened to fall.
      const mine = await seedDriver();
      const myJob = await carrying(mine);
      await availability.execute({
        userId: mine.userId,
        availability: DriverAvailability.OFFLINE,
      });

      const theirs = await seedDriver();
      const theirJob = await carrying(theirs);

      const res = page(await list(mine.token));
      expect(res.items.map((j) => j.jobId)).toEqual([myJob]);
      expect(JSON.stringify(res)).not.toContain(theirJob);
      expect(JSON.stringify(res)).not.toContain(theirs.profileId);
    });

    it('rejects a driverId query parameter rather than honouring or ignoring it', async () => {
      const mine = await seedDriver();
      await carrying(mine);

      // `forbidNonWhitelisted` means an unknown parameter is a 400. A silently-dropped parameter
      // would be one refactor away from being honoured — which is why this asserts a rejection
      // rather than merely asserting that the result was unaffected.
      const res = await list(mine.token, `?driverId=${randomUUID()}`);
      expect(res.status).toBe(400);
    });

    it('rejects an unauthenticated caller', async () => {
      expect((await request(ctx.server).get(ROUTE)).status).toBe(401);
    });

    it('rejects a customer, who holds no delivery permission', async () => {
      const customer = await createUserWithRole(ctx, 'CUSTOMER');
      expect((await list(customer.accessToken)).status).toBe(403);
    });

    it('refuses a user with no driver profile rather than serving an unfiltered page', async () => {
      // The failure direction that matters: "no profile" must never fall through to "no filter".
      const user = await createUserWithRole(ctx, 'DRIVER');
      await ctx.prisma.user.update({
        where: { id: user.userId },
        data: { primaryRole: 'DRIVER' },
      });
      const driverWithJobs = await seedDriver();
      await carrying(driverWithJobs);

      const res = await list(user.accessToken);
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 3. What the payload does not carry
  // -------------------------------------------------------------------------------------------

  describe('payload', () => {
    it('carries what a driver needs and nothing that belongs to somebody else', async () => {
      const driver = await seedDriver();
      const jobId = await carrying(driver);
      await advance.byDriver({
        userId: driver.userId,
        jobId,
        to: DeliveryJobStatus.ARRIVED_PICKUP,
      });
      await advance.byDriver({ userId: driver.userId, jobId, to: DeliveryJobStatus.PICKED_UP });
      await advance.byDriver({ userId: driver.userId, jobId, to: DeliveryJobStatus.EN_ROUTE });
      await advance.byDriver({
        userId: driver.userId,
        jobId,
        to: DeliveryJobStatus.ARRIVED_DROPOFF,
      });
      await advance.byDriver({ userId: driver.userId, jobId, to: DeliveryJobStatus.DELIVERED });
      await ctx.drainOutbox();

      const res = await list(driver.token);
      const item = page(res).items[0];

      // What a driver needs at the door.
      expect(item.isCod).toBe(true);
      expect(item.codAmount).toBe(20_000);

      const serialized = JSON.stringify(page(res));
      // The driver's own internal profile id is not echoed back at them.
      expect(serialized).not.toContain(driver.profileId);
      // Earnings, proof artifacts and COD reconciliation each live behind their own read.
      for (const leaked of ['earning', 'amountMinor', 'artifact', 'podType', 'remittance', 'reconciliation']) {
        expect(serialized).not.toContain(leaked);
      }
    });
  });
});
