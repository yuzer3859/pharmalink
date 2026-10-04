import request from 'supertest';
import { createHash, randomUUID } from 'crypto';
import { AcceptJobOfferCommand } from '../../src/modules/delivery/application/commands/accept-job-offer.command';
import { AdvanceDeliveryJobCommand } from '../../src/modules/delivery/application/commands/advance-delivery-job.command';
import { CreateDriverProfileCommand } from '../../src/modules/delivery/application/commands/create-driver-profile.command';
import { DispatchDeliveryJobCommand } from '../../src/modules/delivery/application/commands/dispatch-delivery-job.command';
import { ManageDriverShiftCommand } from '../../src/modules/delivery/application/commands/manage-driver-shift.command';
import { SetDriverAvailabilityCommand } from '../../src/modules/delivery/application/commands/set-driver-availability.command';
import { UpdateDriverLocationCommand } from '../../src/modules/delivery/application/commands/update-driver-location.command';
import {
  POD_COD_REQUIREMENT_CONFIG_KEY,
  POD_COLD_CHAIN_REQUIREMENT_CONFIG_KEY,
  POD_REQUIREMENT_CONFIG_KEY,
} from '../../src/modules/delivery/application/services/pod-requirement';
import { DeliveryJobStatus, DriverAvailability, PodType } from '../../src/modules/delivery/domain/enums';
import { DeliveryEventType } from '../../src/modules/delivery/domain/events';
import { VehicleType } from '../../src/modules/delivery/domain/value-objects/vehicle.vo';
import { AppConfigService } from '../../src/shared/config/app-config.service';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { auth, body, createUserWithRole, errorOf } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

/**
 * Proof of delivery against real PostgreSQL (§3.3 F-STS-04, §5.2, BR-DEL-06, BRULE-29).
 *
 * Real `AppModule`, real routes and guards, the real Prisma repository, real `Serializable`
 * transactions, the real hash-chained audit trail and the real outbox.
 *
 * The claims that can only be made here:
 *
 *  1. **Idempotency is the database's.** `proof_of_delivery.jobId` carries a unique index, so a
 *     handset retrying a submission is settled by Postgres rather than by anything in memory —
 *     which is what makes it still work with two API nodes behind a load balancer.
 *  2. **Evidence cannot be replaced.** A second submission carrying different evidence is refused
 *     and the stored row is byte-for-byte what it was.
 *  3. **A missing requirement stops the delivery and writes nothing** — no status change, no
 *     `delivery_status_history` row, no audit entry, no outbox event.
 *  4. **The `OrderDelivered` contract Module 06 consumes is unchanged**, and carries no storage
 *     handle, no media and no PoD field. This work added a precondition to the transition, not a
 *     new shape on the wire.
 *  5. **The read path leaks nothing.** No storage handle, no URL, no bytes, and a delivery that is
 *     neither yours to buy nor yours to carry answers `404` rather than `403`.
 */
describe('Proof of delivery (e2e)', () => {
  let ctx: TestContext;
  let dispatch: DispatchDeliveryJobCommand;
  let accept: AcceptJobOfferCommand;
  let advance: AdvanceDeliveryJobCommand;
  let createProfile: CreateDriverProfileCommand;
  let shift: ManageDriverShiftCommand;
  let availability: SetDriverAvailabilityCommand;
  let driverLocation: UpdateDriverLocationCommand;
  let config: AppConfigService;

  const PICKUP = { lat: 9.03, lng: 38.74 };
  const DROPOFF = { lat: 9.01, lng: 38.76 };

  /** A one-pixel PNG — a real image, small enough to be an honest fixture. */
  const PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const PNG_SHA256 = createHash('sha256').update(Buffer.from(PNG_BASE64, 'base64')).digest('hex');
  const OTHER_PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  /**
   * PoD requirements overridden for one test, on the real config port.
   *
   * Every requirement ships defaulted to `NONE` and the environment this suite boots does not set
   * them, so the strict paths would otherwise be untestable without a second application. The
   * override goes through `AppConfigService.get` — the same call `resolvePodSettings` makes — so
   * what is exercised is the production lookup with a different answer, not a different code path.
   */
  const overrides = new Map<string, unknown>();

  beforeAll(async () => {
    ctx = await createTestApp();
    dispatch = ctx.app.get(DispatchDeliveryJobCommand);
    accept = ctx.app.get(AcceptJobOfferCommand);
    advance = ctx.app.get(AdvanceDeliveryJobCommand);
    createProfile = ctx.app.get(CreateDriverProfileCommand);
    shift = ctx.app.get(ManageDriverShiftCommand);
    availability = ctx.app.get(SetDriverAvailabilityCommand);
    driverLocation = ctx.app.get(UpdateDriverLocationCommand);
    config = ctx.app.get(AppConfigService);

    const real = config.get.bind(config);
    jest
      .spyOn(config, 'get')
      .mockImplementation(<T>(key: string): T | undefined =>
        overrides.has(key) ? (overrides.get(key) as T) : real<T>(key),
      );
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    overrides.clear();
    await ctx.reset();
  });

  // -------------------------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------------------------

  interface Scenario {
    jobId: string;
    orderId: string;
    fulfillmentId: string;
    driver: { userId: string; profileId: string; accessToken: string };
    customer: { userId: string; accessToken: string };
  }

  async function seedDriver(): Promise<Scenario['driver']> {
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
      maxConcurrent: 5,
    });
    await shift.start({ userId: user.userId });
    await availability.execute({ userId: user.userId, availability: DriverAvailability.ONLINE });
    await driverLocation.execute({ userId: user.userId, lat: PICKUP.lat, lng: PICKUP.lng });
    return { userId: user.userId, profileId: profile.id, accessToken: user.accessToken };
  }

  /** A real customer's order, carried by a real driver, standing at the customer's door. */
  async function atTheDoor(jobData: Record<string, unknown> = {}): Promise<Scenario> {
    const customer = await createUserWithRole(ctx, 'CUSTOMER');
    const order = await ctx.prisma.order.create({
      data: {
        orderNumber: `ORD-${randomUUID()}`,
        customerUserId: customer.userId,
        status: 'PAID',
        subtotal: 20_000,
        grandTotal: 20_000,
        currency: 'ETB',
        idempotencyKey: `checkout-${randomUUID()}`,
      },
    });
    const fulfillmentId = randomUUID();
    const job = await ctx.prisma.deliveryJob.create({
      data: {
        orderId: order.id,
        fulfillmentId,
        pharmacyId: randomUUID(),
        branchId: randomUUID(),
        pickupLat: PICKUP.lat,
        pickupLng: PICKUP.lng,
        dropoffLat: DROPOFF.lat,
        dropoffLng: DROPOFF.lng,
        status: DeliveryJobStatus.CREATED,
        ...jobData,
      },
    });

    const driver = await seedDriver();
    await dispatch.execute({ jobId: job.id });
    await accept.execute({ userId: driver.userId, jobId: job.id });
    for (const to of [
      DeliveryJobStatus.ARRIVED_PICKUP,
      DeliveryJobStatus.PICKED_UP,
      DeliveryJobStatus.EN_ROUTE,
      DeliveryJobStatus.ARRIVED_DROPOFF,
    ]) {
      await advance.byDriver({ userId: driver.userId, jobId: job.id, to });
    }

    return {
      jobId: job.id,
      orderId: order.id,
      fulfillmentId,
      driver,
      customer: { userId: customer.userId, accessToken: customer.accessToken },
    };
  }

  const submit = (s: Scenario, payload: Record<string, unknown>) =>
    request(ctx.server)
      .post(`/delivery/jobs/${s.jobId}/proof-of-delivery`)
      .set(...auth(s.driver.accessToken))
      .send(payload);

  const confirmation = {
    type: PodType.CONFIRMATION,
    recipientName: 'Almaz Bekele',
    recipientConfirmed: true,
  };

  const withPhoto = (base64 = PNG_BASE64) => ({
    type: PodType.PHOTO,
    recipientName: 'Almaz Bekele',
    recipientConfirmed: true,
    artifact: { contentType: 'image/png', contentBase64: base64 },
  });

  const deliver = (s: Scenario) =>
    request(ctx.server)
      .post(`/delivery/jobs/${s.jobId}/deliver`)
      .set(...auth(s.driver.accessToken))
      .send({});

  const readProof = (s: Scenario, token: string) =>
    request(ctx.server)
      .get(`/delivery/jobs/${s.jobId}/proof-of-delivery`)
      .set(...auth(token));

  /**
   * Takes a scenario's driver off shift.
   *
   * Needed only where one test builds two scenarios: dispatch picks the nearest available driver,
   * and a driver who has finished one delivery is still online and still nearest, so the second
   * job would be offered to them and the second scenario's own driver would find no offer waiting.
   */
  async function retire(s: Scenario): Promise<void> {
    await shift.end({ userId: s.driver.userId });
  }

  async function statusOf(jobId: string): Promise<string> {
    return (await ctx.prisma.deliveryJob.findUniqueOrThrow({ where: { id: jobId } })).status;
  }

  async function podAudits(jobId: string): Promise<number> {
    return ctx.prisma.auditLog.count({
      where: { action: 'DELIVERY_POD_CAPTURED', context: { path: ['jobId'], equals: jobId } },
    });
  }

  // -------------------------------------------------------------------------------------------
  // 1. Capturing evidence
  // -------------------------------------------------------------------------------------------

  describe('capture', () => {
    it('records a confirmation for the driver carrying the job', async () => {
      const s = await atTheDoor();
      const res = await submit(s, confirmation).expect(201);

      expect(body(res)).toMatchObject({
        jobId: s.jobId,
        orderId: s.orderId,
        fulfillmentId: s.fulfillmentId,
        type: PodType.CONFIRMATION,
        recipientName: 'Almaz Bekele',
        recipientConfirmed: true,
        artifact: null,
        created: true,
      });

      const row = await ctx.prisma.proofOfDelivery.findUniqueOrThrow({
        where: { jobId: s.jobId },
      });
      // The driver is the one resolved from the token, not one the client could name.
      expect(row.capturedByDriverId).toBe(s.driver.profileId);
      expect(row.artifactRef).toBeNull();
    });

    it('stores a photograph and records its handle, size and digest — and only those', async () => {
      const s = await atTheDoor();
      const res = await submit(s, withPhoto()).expect(201);

      expect(body(res).artifact).toMatchObject({
        contentType: 'image/png',
        sha256: PNG_SHA256,
        available: true,
      });

      const row = await ctx.prisma.proofOfDelivery.findUniqueOrThrow({
        where: { jobId: s.jobId },
      });
      expect(row.artifactSha256).toBe(PNG_SHA256);
      expect(row.artifactBytes).toBeGreaterThan(0);
      // The bytes are in storage; the row holds a handle. §6's "do not make a database row contain
      // a giant base64 photo", asserted against the real column rather than asserted in prose.
      expect(row.artifactRef).not.toContain(PNG_BASE64.slice(0, 24));
      expect(row.artifactRef!.length).toBeLessThan(200);
    });

    it('audits the capture with the handle and the digest, and never the content', async () => {
      const s = await atTheDoor();
      await submit(s, withPhoto()).expect(201);

      const entry = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { action: 'DELIVERY_POD_CAPTURED' },
      });
      const context = entry.context as Record<string, unknown>;
      expect(context).toMatchObject({ jobId: s.jobId, artifactSha256: PNG_SHA256 });
      expect(JSON.stringify(context)).not.toContain(PNG_BASE64.slice(0, 24));
    });

    it('refuses a driver who is not carrying the job, with 404 rather than 403', async () => {
      const s = await atTheDoor();
      const other = await seedDriver();

      const res = await request(ctx.server)
        .post(`/delivery/jobs/${s.jobId}/proof-of-delivery`)
        .set(...auth(other.accessToken))
        .send(confirmation)
        .expect(404);

      expect(errorOf(res).code).toBe(ErrorCode.NOT_FOUND);
      expect(await ctx.prisma.proofOfDelivery.count()).toBe(0);
    });

    it('refuses capture before the driver has arrived at the door', async () => {
      const s = await atTheDoor();
      // Wind the job back to the leg before arrival, which is where a premature submission lands.
      await ctx.prisma.deliveryJob.update({
        where: { id: s.jobId },
        data: { status: DeliveryJobStatus.EN_ROUTE },
      });

      const res = await submit(s, confirmation).expect(409);
      expect(errorOf(res).code).toBe(ErrorCode.CONFLICT);
      expect(await ctx.prisma.proofOfDelivery.count()).toBe(0);
    });

    it('refuses evidence offered after the delivery has already been recorded', async () => {
      const s = await atTheDoor();
      await deliver(s).expect(201);

      await submit(s, withPhoto()).expect(409);
      expect(await ctx.prisma.proofOfDelivery.count()).toBe(0);
    });

    it('refuses an unsupported media type, and writes nothing at all', async () => {
      const s = await atTheDoor();
      const res = await submit(s, {
        type: PodType.PHOTO,
        recipientConfirmed: true,
        artifact: { contentType: 'image/svg+xml', contentBase64: PNG_BASE64 },
      }).expect(400);

      expect(errorOf(res).code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(await ctx.prisma.proofOfDelivery.count()).toBe(0);
      // §13: no audit entry for a rejected upload.
      expect(await podAudits(s.jobId)).toBe(0);
    });

    it('refuses an artifact beyond the size ceiling', async () => {
      const s = await atTheDoor();
      overrides.set('delivery.podMaxArtifactBytes', 16);

      const res = await submit(s, withPhoto()).expect(400);
      expect(errorOf(res).code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(await ctx.prisma.proofOfDelivery.count()).toBe(0);
    });

    it('rejects a client that tries to name the driver or the evidence handle', async () => {
      const s = await atTheDoor();
      // `forbidNonWhitelisted` — an unknown field is a 400, not a silently ignored extra.
      await submit(s, { ...confirmation, capturedByDriverId: randomUUID() }).expect(400);
      await submit(s, { ...confirmation, artifactRef: 'pod/anything/at-all' }).expect(400);
      expect(await ctx.prisma.proofOfDelivery.count()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 2. Idempotency and immutability, against the real unique index
  // -------------------------------------------------------------------------------------------

  describe('idempotency and immutability', () => {
    it('treats a resubmission of the same evidence as the retry it is', async () => {
      const s = await atTheDoor();
      const first = await submit(s, withPhoto()).expect(201);
      const second = await submit(s, withPhoto()).expect(201);

      expect(body(first).created).toBe(true);
      expect(body(second).created).toBe(false);
      expect(await ctx.prisma.proofOfDelivery.count({ where: { jobId: s.jobId } })).toBe(1);
      // One capture happened, so one audit entry exists.
      expect(await podAudits(s.jobId)).toBe(1);
    });

    it('refuses a resubmission that would replace the evidence, and leaves it untouched', async () => {
      const s = await atTheDoor();
      await submit(s, withPhoto()).expect(201);
      const before = await ctx.prisma.proofOfDelivery.findUniqueOrThrow({
        where: { jobId: s.jobId },
      });

      const res = await submit(s, withPhoto(OTHER_PNG_BASE64)).expect(409);
      expect(errorOf(res).code).toBe(ErrorCode.CONFLICT);

      const after = await ctx.prisma.proofOfDelivery.findUniqueOrThrow({
        where: { jobId: s.jobId },
      });
      expect(after).toEqual(before);
    });

    it('settles simultaneous submissions through the unique index', async () => {
      const s = await atTheDoor();
      const [a, b] = await Promise.all([submit(s, withPhoto()), submit(s, withPhoto())]);

      expect([a.status, b.status].sort()).toEqual([201, 201]);
      expect([body(a).created, body(b).created].sort()).toEqual([false, true]);
      expect(await ctx.prisma.proofOfDelivery.count({ where: { jobId: s.jobId } })).toBe(1);
      expect(await podAudits(s.jobId)).toBe(1);
    });

    it('has no route, and no repository method, that can alter accepted evidence', async () => {
      const s = await atTheDoor();
      await submit(s, confirmation).expect(201);

      // There is no PUT, PATCH or DELETE on the resource — Nest answers 404 for an unrouted verb.
      // Each request is built inside the loop: supertest closes the server it opened when a
      // request finishes, so pre-building them would leave the later ones with nothing to talk to.
      const path = `/delivery/jobs/${s.jobId}/proof-of-delivery`;
      await request(ctx.server).put(path).set(...auth(s.driver.accessToken)).send({}).expect(404);
      await request(ctx.server).patch(path).set(...auth(s.driver.accessToken)).send({}).expect(404);
      await request(ctx.server).delete(path).set(...auth(s.driver.accessToken)).expect(404);

      expect(await ctx.prisma.proofOfDelivery.count({ where: { jobId: s.jobId } })).toBe(1);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 3. The DELIVERED gate (BRULE-29)
  // -------------------------------------------------------------------------------------------

  describe('the DELIVERED transition', () => {
    it('delivers without evidence while the platform requires none', async () => {
      const s = await atTheDoor();
      await deliver(s).expect(201);

      expect(await statusOf(s.jobId)).toBe(DeliveryJobStatus.DELIVERED);
    });

    it('refuses with POD_REQUIRED, and writes nothing, when required proof is missing', async () => {
      const s = await atTheDoor();
      overrides.set(POD_REQUIREMENT_CONFIG_KEY, 'CONFIRMATION');

      const history = await ctx.prisma.deliveryStatusHistory.count({ where: { jobId: s.jobId } });
      const events = await ctx.prisma.outbox.count({ where: { aggregateId: s.jobId } });

      const res = await deliver(s).expect(409);
      expect(errorOf(res).code).toBe(ErrorCode.POD_REQUIRED);

      // No partial delivery state: the status, the history, the events and the timestamp are all
      // exactly where they were.
      const job = await ctx.prisma.deliveryJob.findUniqueOrThrow({ where: { id: s.jobId } });
      expect(job.status).toBe(DeliveryJobStatus.ARRIVED_DROPOFF);
      expect(job.deliveredAt).toBeNull();
      expect(await ctx.prisma.deliveryStatusHistory.count({ where: { jobId: s.jobId } })).toBe(
        history,
      );
      expect(await ctx.prisma.outbox.count({ where: { aggregateId: s.jobId } })).toBe(events);
    });

    it('delivers once the required evidence has been captured', async () => {
      const s = await atTheDoor();
      overrides.set(POD_REQUIREMENT_CONFIG_KEY, 'CONFIRMATION');

      await deliver(s).expect(409);
      await submit(s, confirmation).expect(201);
      await deliver(s).expect(201);

      expect(await statusOf(s.jobId)).toBe(DeliveryJobStatus.DELIVERED);
    });

    it('is not satisfied by a confirmation when the policy demands an artifact', async () => {
      const s = await atTheDoor();
      overrides.set(POD_REQUIREMENT_CONFIG_KEY, 'ARTIFACT');
      await submit(s, confirmation).expect(201);

      expect(errorOf(await deliver(s).expect(409)).code).toBe(ErrorCode.POD_REQUIRED);
    });

    it('applies the cold-chain rule only to a cold-chain delivery', async () => {
      overrides.set(POD_COLD_CHAIN_REQUIREMENT_CONFIG_KEY, 'CONFIRMATION');

      const ordinary = await atTheDoor();
      await deliver(ordinary).expect(201);
      await retire(ordinary);

      const cold = await atTheDoor({ isColdChain: true });
      expect(errorOf(await deliver(cold).expect(409)).code).toBe(ErrorCode.POD_REQUIRED);
    });

    it('applies the cash-on-delivery rule only to a COD delivery', async () => {
      overrides.set(POD_COD_REQUIREMENT_CONFIG_KEY, 'CONFIRMATION');

      const prepaid = await atTheDoor();
      await deliver(prepaid).expect(201);
      await retire(prepaid);

      const cod = await atTheDoor({ isCod: true, codAmount: 24_500 });
      expect(errorOf(await deliver(cod).expect(409)).code).toBe(ErrorCode.POD_REQUIRED);
    });

    it('still refuses an illegal transition ahead of the proof check', async () => {
      const s = await atTheDoor();
      overrides.set(POD_REQUIREMENT_CONFIG_KEY, 'CONFIRMATION');
      await ctx.prisma.deliveryJob.update({
        where: { id: s.jobId },
        data: { status: DeliveryJobStatus.ASSIGNED, pickedUpAt: null },
      });

      // A job that has not reached the door cannot be delivered, and saying `POD_REQUIRED` would
      // send the driver to capture evidence the capture route would itself refuse.
      const res = await deliver(s).expect(409);
      expect(errorOf(res).code).toBe(ErrorCode.INVALID_DELIVERY_STATE_TRANSITION);
    });

    it('leaves the Module 06 OrderDelivered contract exactly as it was', async () => {
      const s = await atTheDoor();
      overrides.set(POD_REQUIREMENT_CONFIG_KEY, 'ARTIFACT');
      await submit(s, withPhoto()).expect(201);
      await deliver(s).expect(201);

      const event = await ctx.prisma.outbox.findFirstOrThrow({
        where: { aggregateId: s.jobId, eventType: DeliveryEventType.OrderDelivered },
      });
      const payload = (event.payload as { payload: Record<string, unknown> }).payload;

      // The same keys the status work published, with nothing added for proof of delivery. §11 is
      // explicit: Module 06 changes the order's state, and it does not need the evidence to do it.
      expect(Object.keys(payload).sort()).toEqual(
        ['jobId', 'orderId', 'fulfillmentId', 'driverId', 'status'].sort(),
      );
      const serialized = JSON.stringify(event.payload);
      expect(serialized).not.toContain(PNG_SHA256);
      expect(serialized).not.toContain('pod/');
      expect(serialized).not.toContain(PNG_BASE64.slice(0, 24));
    });
  });

  // -------------------------------------------------------------------------------------------
  // 4. Reading the evidence back
  // -------------------------------------------------------------------------------------------

  describe('the authorized read', () => {
    it('serves the customer who owns the order', async () => {
      const s = await atTheDoor();
      await submit(s, withPhoto()).expect(201);

      const res = await readProof(s, s.customer.accessToken).expect(200);
      expect(body(res)).toMatchObject({
        jobId: s.jobId,
        type: PodType.PHOTO,
        recipientName: 'Almaz Bekele',
        recipientConfirmed: true,
        artifact: { contentType: 'image/png', sha256: PNG_SHA256, available: true },
      });
    });

    it('serves the driver who captured it', async () => {
      const s = await atTheDoor();
      await submit(s, confirmation).expect(201);
      await readProof(s, s.driver.accessToken).expect(200);
    });

    it('exposes no storage handle, no URL and no bytes', async () => {
      const s = await atTheDoor();
      await submit(s, withPhoto()).expect(201);
      const res = await readProof(s, s.customer.accessToken).expect(200);

      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain('pod/');
      expect(serialized).not.toContain(PNG_BASE64.slice(0, 24));
      expect(serialized).not.toContain('http');
      expect(Object.keys(body(res)).sort()).toEqual(
        [
          'jobId',
          'orderId',
          'fulfillmentId',
          'type',
          'recipientName',
          'recipientConfirmed',
          'capturedAt',
          'artifact',
        ].sort(),
      );
      // Nothing about the driver's identity, which the tracking work also declined to expose.
      expect(serialized).not.toContain(s.driver.profileId);
      expect(serialized).not.toContain(s.driver.userId);
    });

    it('answers 404 to a customer who does not own the order', async () => {
      const s = await atTheDoor();
      await submit(s, confirmation).expect(201);
      const stranger = await createUserWithRole(ctx, 'CUSTOMER');

      const res = await readProof(s, stranger.accessToken).expect(404);
      expect(errorOf(res).code).toBe(ErrorCode.NOT_FOUND);
    });

    it('answers 404 to a driver who is not carrying the job', async () => {
      const s = await atTheDoor();
      await submit(s, confirmation).expect(201);
      const other = await seedDriver();

      await readProof(s, other.accessToken).expect(404);
    });

    it('answers 404 for a delivery that has no evidence', async () => {
      const s = await atTheDoor();
      const res = await readProof(s, s.customer.accessToken).expect(404);
      expect(errorOf(res).code).toBe(ErrorCode.NOT_FOUND);
    });

    it('requires authentication', async () => {
      const s = await atTheDoor();
      await request(ctx.server).get(`/delivery/jobs/${s.jobId}/proof-of-delivery`).expect(401);
      await request(ctx.server)
        .post(`/delivery/jobs/${s.jobId}/proof-of-delivery`)
        .send(confirmation)
        .expect(401);
    });
  });
});
