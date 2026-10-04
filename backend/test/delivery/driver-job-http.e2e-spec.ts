import request from 'supertest';
import { randomUUID } from 'crypto';
import { CreateDriverProfileCommand } from '../../src/modules/delivery/application/commands/create-driver-profile.command';
import { DispatchDeliveryJobCommand } from '../../src/modules/delivery/application/commands/dispatch-delivery-job.command';
import { ManageDriverShiftCommand } from '../../src/modules/delivery/application/commands/manage-driver-shift.command';
import { SetDriverAvailabilityCommand } from '../../src/modules/delivery/application/commands/set-driver-availability.command';
import { UpdateDriverLocationCommand } from '../../src/modules/delivery/application/commands/update-driver-location.command';
import {
  DeliveryJobStatus,
  DriverAvailability,
  JobOfferStatus,
} from '../../src/modules/delivery/domain/enums';
import { VehicleType } from '../../src/modules/delivery/domain/value-objects/vehicle.vo';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { auth, body, createUserWithRole, errorOf } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

/**
 * `POST /delivery/jobs/{id}/accept` and `/decline` over real HTTP (§9.2).
 *
 * The module's first controller, and the RBAC claim is the point of this suite: `delivery:accept:own`
 * and `delivery:update:own` have been in the catalogue since Phase 0, granted to `DRIVER` and
 * attached to nothing. These are the routes they were seeded for, so no permission is invented —
 * and the tests below assert exactly that, including that a `CUSTOMER` holding neither is refused.
 *
 * The workflow itself is proven in `dispatch.e2e-spec.ts` against the commands directly. What is
 * under test here is the HTTP boundary: authentication, authorization, scoping from the token, the
 * response allow-list, and the error envelope.
 */
describe('Driver job offer HTTP (e2e)', () => {
  let ctx: TestContext;
  let dispatch: DispatchDeliveryJobCommand;
  let createProfile: CreateDriverProfileCommand;
  let shift: ManageDriverShiftCommand;
  let availability: SetDriverAvailabilityCommand;
  let location: UpdateDriverLocationCommand;

  const PICKUP = { lat: 9.03, lng: 38.74 };

  beforeAll(async () => {
    ctx = await createTestApp();
    dispatch = ctx.app.get(DispatchDeliveryJobCommand);
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

  async function seedJob(): Promise<string> {
    const order = await ctx.prisma.order.create({
      data: {
        orderNumber: `ORD-${randomUUID()}`,
        customerUserId: randomUUID(),
        status: 'PAID',
        subtotal: 20_000,
        grandTotal: 20_000,
        currency: 'ETB',
        isCod: true,
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
        pickupAddress: 'Bole Branch, Africa Ave',
        dropoffLat: 8.98,
        dropoffLng: 38.79,
        dropoffAddress: 'Kazanchis, Bldg 4',
        items: [{ catalogProductId: randomUUID(), name: 'Amoxicillin', quantity: 2 }],
        isCod: true,
        codAmount: 20_000,
        status: DeliveryJobStatus.CREATED,
      },
    });
    return job.id;
  }

  /** A logged-in DRIVER with an operational profile, online and located at the pickup. */
  async function seedDriver(at = PICKUP) {
    const user = await createUserWithRole(ctx, 'DRIVER');
    // Module 01's own record of a verified driver: a DRIVER_DOCS approval, and the DRIVER
    // primaryRole the operational profile requires.
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
    });
    await shift.start({ userId: user.userId });
    await availability.execute({
      userId: user.userId,
      availability: DriverAvailability.ONLINE,
    });
    await location.execute({ userId: user.userId, lat: at.lat, lng: at.lng });
    return { ...user, profileId: profile.id };
  }

  // -------------------------------------------------------------------------------------------
  // Accept
  // -------------------------------------------------------------------------------------------

  it('lets the offered driver accept, and returns the job they now carry', async () => {
    const jobId = await seedJob();
    const driver = await seedDriver();
    await dispatch.execute({ jobId });

    const res = await request(ctx.server)
      .post(`/delivery/jobs/${jobId}/accept`)
      .set(...auth(driver.accessToken))
      .expect(201);

    const data = body(res);
    expect(data.offerId).toEqual(expect.any(String));
    expect(data.acceptedAt).toEqual(expect.any(String));
    expect(data.job).toMatchObject({
      jobId,
      status: DeliveryJobStatus.ASSIGNED,
      pickupAddress: 'Bole Branch, Africa Ave',
      dropoffAddress: 'Kazanchis, Bldg 4',
      isCod: true,
      codAmount: 20_000,
    });
  });

  it('exposes only the allow-listed job fields', async () => {
    const jobId = await seedJob();
    const driver = await seedDriver();
    await dispatch.execute({ jobId });

    const res = await request(ctx.server)
      .post(`/delivery/jobs/${jobId}/accept`)
      .set(...auth(driver.accessToken))
      .expect(201);

    const job = body(res).job as Record<string, unknown>;
    expect(Object.keys(job).sort()).toEqual([
      'codAmount',
      'dropoff',
      'dropoffAddress',
      'isCod',
      'isColdChain',
      'items',
      'jobId',
      'orderId',
      'pickup',
      'pickupAddress',
      'status',
    ]);
    // Nothing about the customer, the order's money, or the driver's own row leaks through.
    const serialized = JSON.stringify(body(res));
    expect(serialized).not.toContain('customerUserId');
    expect(serialized).not.toContain('grandTotal');
    expect(serialized).not.toContain('assignedDriverId');
  });

  it('refuses an unauthenticated caller', async () => {
    const jobId = await seedJob();
    await request(ctx.server).post(`/delivery/jobs/${jobId}/accept`).expect(401);
  });

  it('refuses a CUSTOMER, who holds neither delivery permission', async () => {
    const jobId = await seedJob();
    const driver = await seedDriver();
    await dispatch.execute({ jobId });
    const customer = await createUserWithRole(ctx, 'CUSTOMER');

    const res = await request(ctx.server)
      .post(`/delivery/jobs/${jobId}/accept`)
      .set(...auth(customer.accessToken))
      .expect(403);

    expect(errorOf(res).code).toBe(ErrorCode.FORBIDDEN);
    // And the job is untouched — the guard ran before anything else.
    const job = await ctx.prisma.deliveryJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe(DeliveryJobStatus.OFFERED);
    expect(job.assignedDriverId).toBeNull();
    expect(driver.profileId).toEqual(expect.any(String));
  });

  it('answers 404 when the job is offered to another driver', async () => {
    // Not 403: a driver must not be able to probe job ids to learn who is being dispatched what.
    const jobId = await seedJob();
    await seedDriver();
    const outsider = await seedDriver({ lat: 9.4, lng: 39.1 });
    await dispatch.execute({ jobId });

    const res = await request(ctx.server)
      .post(`/delivery/jobs/${jobId}/accept`)
      .set(...auth(outsider.accessToken))
      .expect(404);

    expect(errorOf(res).code).toBe(ErrorCode.NOT_FOUND);
  });

  it('answers 409 with OFFER_EXPIRED when the deadline has passed', async () => {
    const jobId = await seedJob();
    const driver = await seedDriver();
    const offered = await dispatch.execute({ jobId });
    const past = Date.now() - 60_000;
    await ctx.prisma.jobOffer.update({
      where: { id: offered.offer!.id },
      data: { offeredAt: new Date(past), expiresAt: new Date(past + 30_000) },
    });

    const res = await request(ctx.server)
      .post(`/delivery/jobs/${jobId}/accept`)
      .set(...auth(driver.accessToken))
      .expect(409);

    expect(errorOf(res).code).toBe(ErrorCode.OFFER_EXPIRED);
  });

  it('answers 409 with CONCURRENT_LIMIT_REACHED when the driver is full', async () => {
    const jobId = await seedJob();
    const driver = await seedDriver();
    await dispatch.execute({ jobId });

    const otherJobId = await seedJob();
    await ctx.prisma.deliveryJob.update({
      where: { id: otherJobId },
      data: { status: DeliveryJobStatus.ASSIGNED, assignedDriverId: driver.profileId },
    });

    const res = await request(ctx.server)
      .post(`/delivery/jobs/${jobId}/accept`)
      .set(...auth(driver.accessToken))
      .expect(409);

    expect(errorOf(res).code).toBe(ErrorCode.CONCURRENT_LIMIT_REACHED);
  });

  // -------------------------------------------------------------------------------------------
  // Decline
  // -------------------------------------------------------------------------------------------

  it('lets the offered driver decline, with a reason', async () => {
    const jobId = await seedJob();
    const driver = await seedDriver();
    await seedDriver({ lat: 9.06, lng: 38.78 });
    await dispatch.execute({ jobId });

    const res = await request(ctx.server)
      .post(`/delivery/jobs/${jobId}/decline`)
      .set(...auth(driver.accessToken))
      .send({ reason: 'Finishing another run' })
      .expect(201);

    expect(body(res)).toMatchObject({
      status: JobOfferStatus.DECLINED,
      reason: 'Finishing another run',
    });
  });

  it('accepts a decline with no body at all', async () => {
    const jobId = await seedJob();
    const driver = await seedDriver();
    await dispatch.execute({ jobId });

    const res = await request(ctx.server)
      .post(`/delivery/jobs/${jobId}/decline`)
      .set(...auth(driver.accessToken))
      .expect(201);

    expect(body(res).reason).toBeNull();
  });

  it('does not report who the job went to next', async () => {
    // Another driver's business. The command returns the re-dispatch outcome; the wire format
    // deliberately drops it.
    const jobId = await seedJob();
    const driver = await seedDriver();
    const next = await seedDriver({ lat: 9.06, lng: 38.78 });
    await dispatch.execute({ jobId });

    const res = await request(ctx.server)
      .post(`/delivery/jobs/${jobId}/decline`)
      .set(...auth(driver.accessToken))
      .expect(201);

    expect(Object.keys(body(res)).sort()).toEqual([
      'declinedAt',
      'offerId',
      'reason',
      'status',
    ]);
    expect(JSON.stringify(body(res))).not.toContain(next.profileId);
  });

  it('rejects an unknown body field', async () => {
    const jobId = await seedJob();
    const driver = await seedDriver();
    await dispatch.execute({ jobId });

    // `forbidNonWhitelisted`: naming a driver or an offer must be a 400, not a silent no-op.
    await request(ctx.server)
      .post(`/delivery/jobs/${jobId}/decline`)
      .set(...auth(driver.accessToken))
      .send({ reason: 'no', driverId: randomUUID() })
      .expect(400);
  });

  it('rejects an over-long decline reason', async () => {
    const jobId = await seedJob();
    const driver = await seedDriver();
    await dispatch.execute({ jobId });

    await request(ctx.server)
      .post(`/delivery/jobs/${jobId}/decline`)
      .set(...auth(driver.accessToken))
      .send({ reason: 'x'.repeat(500) })
      .expect(400);
  });

  it('refuses a CUSTOMER on decline as well', async () => {
    const jobId = await seedJob();
    await seedDriver();
    await dispatch.execute({ jobId });
    const customer = await createUserWithRole(ctx, 'CUSTOMER');

    await request(ctx.server)
      .post(`/delivery/jobs/${jobId}/decline`)
      .set(...auth(customer.accessToken))
      .send({})
      .expect(403);
  });
});
