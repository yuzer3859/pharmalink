import request from 'supertest';
import { randomUUID } from 'crypto';
import { io, Socket } from 'socket.io-client';
import { AcceptJobOfferCommand } from '../../src/modules/delivery/application/commands/accept-job-offer.command';
import { AdvanceDeliveryJobCommand } from '../../src/modules/delivery/application/commands/advance-delivery-job.command';
import { CreateDriverProfileCommand } from '../../src/modules/delivery/application/commands/create-driver-profile.command';
import { DispatchDeliveryJobCommand } from '../../src/modules/delivery/application/commands/dispatch-delivery-job.command';
import { ManageDriverShiftCommand } from '../../src/modules/delivery/application/commands/manage-driver-shift.command';
import { PublishJobLocationCommand } from '../../src/modules/delivery/application/commands/publish-job-location.command';
import { SetDriverAvailabilityCommand } from '../../src/modules/delivery/application/commands/set-driver-availability.command';
import { UpdateDriverLocationCommand } from '../../src/modules/delivery/application/commands/update-driver-location.command';
import { DeliveryJobStatus, DriverAvailability } from '../../src/modules/delivery/domain/enums';
import { VehicleType } from '../../src/modules/delivery/domain/value-objects/vehicle.vo';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { PermissionCacheService } from '../../src/shared/rbac/permission-cache.service';
import { PERM_VERSION_STORE } from '../../src/modules/identity/application/ports/perm-version.port';
import { CachedPermVersionStore } from '../../src/modules/identity/infrastructure/security/cached-perm-version.store';
import { RedisService } from '../../src/shared/redis/redis.service';
import { ROUTING_PORT } from '../../src/modules/delivery/application/ports/outbound/routing.port';
import { RouteDestination } from '../../src/modules/delivery/domain/services/tracking-policy';
import { auth, body, createUserWithRole, errorOf } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

/**
 * Real-time location tracking, end to end (§3.4 F-TRK-01/F-TRK-03, §7, BR-DEL-05, NFR-PERF-04,
 * NFR-LOC-04).
 *
 * Real `AppModule`, real socket.io gateway over a real TCP port, real Prisma repositories against
 * the container Postgres, and **real Redis** — the throwaway container `global-setup.ts` starts
 * alongside the database.
 *
 * The claims that can only be made here:
 *
 *  1. **Two independent gateway instances share subscriptions through Redis.** A driver posts to
 *     instance A and a customer connected to instance B receives it. This is the design's
 *     "stateless WS nodes; any node can serve any client", and nothing short of two real
 *     applications and a real broker demonstrates it — an in-process fan-out passes this test
 *     trivially while being exactly the thing that fails in production behind a load balancer.
 *  2. **Authorization is real**, on a socket as well as on a route: the token is verified, the
 *     permission version is checked, and ownership is read from Module 06's own table.
 *  3. **Redis is not load-bearing for durability.** With Redis unreachable the durable position
 *     still lands in Postgres and the driver is told the fan-out did not happen.
 *  4. **Nothing internal reaches the customer**, asserted against the bytes actually sent.
 */
describe('Delivery real-time tracking (e2e)', () => {
  /** The node a driver posts to. */
  let alpha: TestContext;
  /** A second, independent node a customer connects to. Same database, same Redis, own process state. */
  let beta: TestContext;

  let dispatch: DispatchDeliveryJobCommand;
  let accept: AcceptJobOfferCommand;
  let advance: AdvanceDeliveryJobCommand;
  let createProfile: CreateDriverProfileCommand;
  let shift: ManageDriverShiftCommand;
  let availability: SetDriverAvailabilityCommand;
  let driverLocation: UpdateDriverLocationCommand;
  let redis: RedisService;

  const PICKUP = { lat: 9.03, lng: 38.74 };
  const DROPOFF = { lat: 9.01, lng: 38.76 };
  const sockets: Socket[] = [];

  beforeAll(async () => {
    // Promote the suite's Redis container to the variable the application reads. Done here rather
    // than in `global-setup.ts` so that every other e2e suite keeps booting without Redis, which
    // keeps the unconfigured single-node path continuously exercised.
    process.env.REDIS_URL = process.env.REDIS_TEST_URL;
    // Persist every fix, so the durable row can be observed directly. The coalescing behaviour
    // itself is covered by the unit suite, which can drive the clock.
    process.env.DELIVERY_LOCATION_WRITE_INTERVAL_SECONDS = '0';

    alpha = await createTestApp([], { listen: true });
    beta = await createTestApp([], { listen: true });

    dispatch = alpha.app.get(DispatchDeliveryJobCommand);
    accept = alpha.app.get(AcceptJobOfferCommand);
    advance = alpha.app.get(AdvanceDeliveryJobCommand);
    createProfile = alpha.app.get(CreateDriverProfileCommand);
    shift = alpha.app.get(ManageDriverShiftCommand);
    availability = alpha.app.get(SetDriverAvailabilityCommand);
    driverLocation = alpha.app.get(UpdateDriverLocationCommand);
    redis = alpha.app.get(RedisService);
  }, 120_000);

  afterAll(async () => {
    await closeTestApp(beta);
    await closeTestApp(alpha);
    delete process.env.REDIS_URL;
    delete process.env.DELIVERY_LOCATION_WRITE_INTERVAL_SECONDS;
  });

  beforeEach(async () => {
    await alpha.reset();
    // `beta` shares the database but has its own in-process permission caches; without clearing
    // them a previous test's user could satisfy its guard for a brand-new id.
    beta.app.get(PermissionCacheService).clear();
    beta.app.get<CachedPermVersionStore>(PERM_VERSION_STORE).clear();
    tick = 0;
  });

  afterEach(() => {
    // A socket left open holds the app's HTTP server and would stall the run.
    while (sockets.length > 0) {
      sockets.pop()?.disconnect();
    }
  });

  // -------------------------------------------------------------------------------------------
  // Socket helpers
  // -------------------------------------------------------------------------------------------

  /**
   * Connects to a node's `/tracking` namespace and reports whether the connection *survived*.
   *
   * The distinction matters. socket.io accepts a namespace connection before the gateway's
   * `handleConnection` has checked the token, so the client's own `connect` event fires even for a
   * request that is about to be rejected; a helper that resolved there would call every
   * unauthenticated connection a success. So a `connect` is held briefly and the socket's actual
   * state is read afterwards, which is also exactly what a real client experiences.
   */
  async function connect(
    ctx: TestContext,
    token: string | null,
  ): Promise<{ socket: Socket; connected: boolean; error?: unknown }> {
    const socket = io(`${ctx.url}/tracking`, {
      // `websocket` only: the default begins with HTTP long-polling, which makes an authentication
      // failure arrive as a transport error rather than as the gateway's own message.
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: token === null ? {} : { token },
    });
    sockets.push(socket);

    let error: unknown;
    const connected = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 8_000);
      const settle = (value: boolean) => {
        clearTimeout(timer);
        resolve(value);
      };

      socket.on('connect_error', (err: unknown) => {
        error = err;
        settle(false);
      });
      socket.on('tracking:error', (err: unknown) => {
        error = err;
        settle(false);
      });
      socket.on('connect', () => {
        setTimeout(() => settle(socket.connected), 600);
      });
    });

    return { socket, connected, error };
  }

  /** Connects and fails the test if the handshake is refused. */
  async function connected(ctx: TestContext, token: string): Promise<Socket> {
    const result = await connect(ctx, token);
    expect(result.connected).toBe(true);
    return result.socket;
  }

  interface Ack<T> {
    ok: boolean;
    data?: T;
    error?: { code: string; message: string };
  }

  function send<T>(socket: Socket, event: string, payload: unknown): Promise<Ack<T>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No ack for ${event}`)), 8_000);
      socket.emit(event, payload, (ack: Ack<T>) => {
        clearTimeout(timer);
        resolve(ack);
      });
    });
  }

  /** Resolves with the next `event` payload, or `null` if none arrives within `within` ms. */
  function next<T>(socket: Socket, event: string, within = 8_000): Promise<T | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        socket.off(event, handler);
        resolve(null);
      }, within);
      const handler = (payload: T) => {
        clearTimeout(timer);
        socket.off(event, handler);
        resolve(payload);
      };
      socket.on(event, handler);
    });
  }

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
    const user = await createUserWithRole(alpha, 'DRIVER');
    await alpha.prisma.user.update({
      where: { id: user.userId },
      data: { primaryRole: 'DRIVER' },
    });
    await alpha.prisma.verificationRequest.create({
      data: { userId: user.userId, type: 'DRIVER_DOCS', status: 'APPROVED', reviewedAt: new Date() },
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

  /** A job carried by a verified driver, owned by a real customer, sitting at `PICKED_UP`. */
  async function scenario(): Promise<Scenario> {
    const customer = await createUserWithRole(alpha, 'CUSTOMER');
    const order = await alpha.prisma.order.create({
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
    const job = await alpha.prisma.deliveryJob.create({
      data: {
        orderId: order.id,
        fulfillmentId,
        pharmacyId: randomUUID(),
        branchId: randomUUID(),
        pickupLat: PICKUP.lat,
        pickupLng: PICKUP.lng,
        // A real dropoff, so the post-pickup leg has a destination to route to. Without one the
        // ETA would be legitimately null and the tests below would pass for the wrong reason.
        dropoffLat: DROPOFF.lat,
        dropoffLng: DROPOFF.lng,
        status: DeliveryJobStatus.CREATED,
      },
    });

    const driver = await seedDriver();
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

    return {
      jobId: job.id,
      orderId: order.id,
      fulfillmentId,
      driver,
      customer: { userId: customer.userId, accessToken: customer.accessToken },
    };
  }

  /**
   * A fresh position report, with a timestamp strictly newer than every previous one.
   *
   * Monotonic on purpose: `seedDriver` records a position at seed time, and the ordering guard
   * correctly ignores anything no newer than what is already stored. A fixture handing out
   * timestamps in the past would therefore be rejected for the right reason while making the test
   * look like it had found the wrong one.
   */
  let tick = 0;
  const fix = (lat: number, lng = 38.75) => ({
    lat,
    lng,
    recordedAt: new Date(Date.now() + ++tick * 50).toISOString(),
  });

  /** A deliberately old report — a handset flushing a buffer it filled while disconnected. */
  const staleFix = (lat: number, agoSeconds: number, lng = 38.75) => ({
    lat,
    lng,
    recordedAt: new Date(Date.now() - agoSeconds * 1_000).toISOString(),
  });

  // -------------------------------------------------------------------------------------------
  // 1–3. Publishing: who may, and who may not
  // -------------------------------------------------------------------------------------------

  describe('driver publishing', () => {
    it('accepts a position from the assigned driver on their active job', async () => {
      const s = await scenario();
      const socket = await connected(alpha, s.driver.accessToken);

      const ack = await send<{ accepted: boolean; persisted: boolean; published: boolean }>(
        socket,
        'tracking:location',
        { jobId: s.jobId, ...fix(9.05) },
      );

      expect(ack.ok).toBe(true);
      expect(ack.data).toMatchObject({ accepted: true, persisted: true, published: true });

      const stored = await alpha.prisma.driverProfile.findUniqueOrThrow({
        where: { id: s.driver.profileId },
      });
      expect(Number(stored.lastLat)).toBeCloseTo(9.05, 6);
    });

    it("refuses to publish to another driver's job, and says NOT_FOUND", async () => {
      const s = await scenario();
      const intruderUser = await seedDriver();
      const socket = await connected(alpha, intruderUser.accessToken);

      const ack = await send(socket, 'tracking:location', { jobId: s.jobId, ...fix(9.9) });

      expect(ack.ok).toBe(false);
      expect(ack.error?.code).toBe(ErrorCode.NOT_FOUND);

      // The real driver's row is untouched.
      const stored = await alpha.prisma.driverProfile.findUniqueOrThrow({
        where: { id: s.driver.profileId },
      });
      expect(Number(stored.lastLat)).toBeCloseTo(PICKUP.lat, 6);
    });

    it('refuses a customer trying to publish a position for their own delivery', async () => {
      const s = await scenario();
      const socket = await connected(alpha, s.customer.accessToken);

      const ack = await send(socket, 'tracking:location', { jobId: s.jobId, ...fix(9.9) });

      expect(ack.ok).toBe(false);
      expect(ack.error?.code).toBe(ErrorCode.FORBIDDEN);
    });

    it('closes a connection presenting no token', async () => {
      const result = await connect(alpha, null);
      expect(result.connected).toBe(false);
    });

    it('closes a connection presenting a forged token', async () => {
      const result = await connect(alpha, 'not.a.real.token');
      expect(result.connected).toBe(false);
    });

    it('refuses a token whose permissions have since changed', async () => {
      // A socket authenticated once could otherwise stream for as long as it stayed open. The
      // permission version is what stops a revoked grant from outliving its token.
      const s = await scenario();
      await alpha.prisma.user.update({
        where: { id: s.driver.userId },
        data: { permVersion: { increment: 1 } },
      });
      alpha.app.get<CachedPermVersionStore>(PERM_VERSION_STORE).clear();

      const result = await connect(alpha, s.driver.accessToken);
      expect(result.connected).toBe(false);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 4–6. Validation, ordering, terminal states
  // -------------------------------------------------------------------------------------------

  describe('validation and ordering', () => {
    it.each([
      ['a latitude out of range', { lat: 91, lng: 38.7 }],
      ['a longitude out of range', { lat: 9, lng: 181 }],
      ['a non-numeric latitude', { lat: 'north', lng: 38.7 }],
      ['a missing longitude', { lat: 9 }],
    ])('rejects %s without closing the socket', async (_label, payload) => {
      const s = await scenario();
      const socket = await connected(alpha, s.driver.accessToken);

      const ack = await send(socket, 'tracking:location', { jobId: s.jobId, ...payload });

      expect(ack.ok).toBe(false);
      expect(ack.error?.code).toBe(ErrorCode.VALIDATION_ERROR);
      // Still usable — a bad frame must not cost the driver their connection.
      expect(socket.connected).toBe(true);
      const good = await send<{ accepted: boolean }>(socket, 'tracking:location', {
        jobId: s.jobId,
        ...fix(9.06),
      });
      expect(good.ok).toBe(true);
    });

    it.each([
      ['a non-object payload', 'hello'],
      ['an array payload', [1, 2, 3]],
      ['an empty object', {}],
      ['a null jobId', { jobId: null, lat: 9, lng: 38.7 }],
    ])('rejects %s safely', async (_label, payload) => {
      const s = await scenario();
      const socket = await connected(alpha, s.driver.accessToken);

      const ack = await send(socket, 'tracking:location', payload);

      expect(ack.ok).toBe(false);
      expect(ack.error?.code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(socket.connected).toBe(true);
    });

    it('ignores a buffered fix older than one already accepted', async () => {
      const s = await scenario();
      const socket = await connected(alpha, s.driver.accessToken);

      await send(socket, 'tracking:location', { jobId: s.jobId, ...fix(9.2) });
      const stale = await send<{ accepted: boolean }>(socket, 'tracking:location', {
        jobId: s.jobId,
        ...staleFix(8.1, 300),
      });

      expect(stale.ok).toBe(true);
      expect(stale.data?.accepted).toBe(false);

      // The durable position did not move backwards.
      const stored = await alpha.prisma.driverProfile.findUniqueOrThrow({
        where: { id: s.driver.profileId },
      });
      expect(Number(stored.lastLat)).toBeCloseTo(9.2, 6);
    });

    it('rejects a timestamp implausibly far in the future', async () => {
      const s = await scenario();
      const socket = await connected(alpha, s.driver.accessToken);

      const ack = await send(socket, 'tracking:location', {
        jobId: s.jobId,
        lat: 9.1,
        lng: 38.7,
        recordedAt: new Date(Date.now() + 3_600_000).toISOString(),
      });

      expect(ack.ok).toBe(false);
      expect(ack.error?.code).toBe(ErrorCode.VALIDATION_ERROR);
    });

    it('refuses a position on a delivered job', async () => {
      const s = await scenario();
      await advance.byDriver({
        userId: s.driver.userId,
        jobId: s.jobId,
        to: DeliveryJobStatus.EN_ROUTE,
      });
      await advance.byDriver({
        userId: s.driver.userId,
        jobId: s.jobId,
        to: DeliveryJobStatus.ARRIVED_DROPOFF,
      });
      await advance.byDriver({
        userId: s.driver.userId,
        jobId: s.jobId,
        to: DeliveryJobStatus.DELIVERED,
      });

      const socket = await connected(alpha, s.driver.accessToken);
      const ack = await send(socket, 'tracking:location', { jobId: s.jobId, ...fix(9.4) });

      expect(ack.ok).toBe(false);
      expect(ack.error?.code).toBe(ErrorCode.CONFLICT);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 16. A position report leaves no trail
  // -------------------------------------------------------------------------------------------

  it('writes no status history and no audit entry, however many fixes arrive', async () => {
    const s = await scenario();
    const socket = await connected(alpha, s.driver.accessToken);

    const historyBefore = await alpha.prisma.deliveryStatusHistory.count({
      where: { jobId: s.jobId },
    });
    const auditBefore = await alpha.prisma.auditLog.count();

    for (let i = 0; i < 6; i += 1) {
      await send(socket, 'tracking:location', { jobId: s.jobId, ...fix(9.1 + i / 100) });
    }

    expect(await alpha.prisma.deliveryStatusHistory.count({ where: { jobId: s.jobId } })).toBe(
      historyBefore,
    );
    expect(await alpha.prisma.auditLog.count()).toBe(auditBefore);
  });

  // -------------------------------------------------------------------------------------------
  // 8–11, 19. Subscribing
  // -------------------------------------------------------------------------------------------

  describe('customer subscription', () => {
    it('lets the owning customer subscribe and receive the last-known position', async () => {
      const s = await scenario();
      const driverSocket = await connected(alpha, s.driver.accessToken);
      await send(driverSocket, 'tracking:location', { jobId: s.jobId, ...fix(9.07, 38.77) });

      const socket = await connected(alpha, s.customer.accessToken);
      const ack = await send<{ location: { lat: number } | null }>(socket, 'tracking:subscribe', {
        jobId: s.jobId,
      });

      expect(ack.ok).toBe(true);
      expect(ack.data?.location?.lat).toBeCloseTo(9.07, 6);
    });

    it("refuses another customer's delivery with NOT_FOUND, not FORBIDDEN", async () => {
      const s = await scenario();
      const stranger = await createUserWithRole(alpha, 'CUSTOMER');
      const socket = await connected(alpha, stranger.accessToken);

      const ack = await send(socket, 'tracking:subscribe', { jobId: s.jobId });

      expect(ack.ok).toBe(false);
      // NOT_FOUND rather than FORBIDDEN: a distinguishable answer would turn job ids into an
      // oracle for who has ordered medicines and when.
      expect(ack.error?.code).toBe(ErrorCode.NOT_FOUND);
    });

    it('refuses by order id too', async () => {
      const s = await scenario();
      const stranger = await createUserWithRole(alpha, 'CUSTOMER');
      const socket = await connected(alpha, stranger.accessToken);

      const ack = await send(socket, 'tracking:subscribe', { orderId: s.orderId });
      expect(ack.error?.code).toBe(ErrorCode.NOT_FOUND);
    });

    it('subscribes by order id, which is the identifier a customer actually has', async () => {
      const s = await scenario();
      const socket = await connected(alpha, s.customer.accessToken);

      const ack = await send<{ jobId: string; fulfillmentId: string }>(
        socket,
        'tracking:subscribe',
        { orderId: s.orderId },
      );

      expect(ack.ok).toBe(true);
      expect(ack.data?.jobId).toBe(s.jobId);
      expect(ack.data?.fulfillmentId).toBe(s.fulfillmentId);
    });

    it('succeeds with a null location when the driver has not reported on this job yet', async () => {
      const s = await scenario();
      // The driver has a profile position from seeding; clear the hot entry and the durable one so
      // the "nothing yet" branch is genuinely exercised.
      await alpha.prisma.driverProfile.update({
        where: { id: s.driver.profileId },
        data: { lastLat: null, lastLng: null, lastLocationAt: null },
      });
      await redis.del(redis.key('delivery', 'location', s.jobId));

      const socket = await connected(alpha, s.customer.accessToken);
      const ack = await send<{ location: unknown; isLive: boolean }>(socket, 'tracking:subscribe', {
        jobId: s.jobId,
      });

      // §6: the subscription still succeeds and reports that no position is available.
      expect(ack.ok).toBe(true);
      expect(ack.data?.location).toBeNull();
      expect(ack.data?.isLive).toBe(true);
    });

    it('receives subsequent positions live', async () => {
      const s = await scenario();
      const customerSocket = await connected(alpha, s.customer.accessToken);
      await send(customerSocket, 'tracking:subscribe', { jobId: s.jobId });

      const arriving = next<{ lat: number; lng: number }>(customerSocket, 'tracking:update');
      const driverSocket = await connected(alpha, s.driver.accessToken);
      await send(driverSocket, 'tracking:location', { jobId: s.jobId, ...fix(9.12, 38.79) });

      const update = await arriving;
      expect(update).not.toBeNull();
      expect(update?.lat).toBeCloseTo(9.12, 6);
      expect(update?.lng).toBeCloseTo(38.79, 6);
    });

    it('stops delivering after an unsubscribe', async () => {
      const s = await scenario();
      const customerSocket = await connected(alpha, s.customer.accessToken);
      await send(customerSocket, 'tracking:subscribe', { jobId: s.jobId });

      const released = await send(customerSocket, 'tracking:unsubscribe', { jobId: s.jobId });
      expect(released.ok).toBe(true);

      const arriving = next(customerSocket, 'tracking:update', 1_500);
      const driverSocket = await connected(alpha, s.driver.accessToken);
      await send(driverSocket, 'tracking:location', { jobId: s.jobId, ...fix(9.13) });

      expect(await arriving).toBeNull();
    });

    it('stops delivering after a disconnect, and a reconnect resumes from the durable position', async () => {
      const s = await scenario();
      const driverSocket = await connected(alpha, s.driver.accessToken);
      await send(driverSocket, 'tracking:location', { jobId: s.jobId, ...fix(9.15, 38.8) });

      const first = await connected(alpha, s.customer.accessToken);
      await send(first, 'tracking:subscribe', { jobId: s.jobId });
      first.disconnect();

      // Nothing served from process memory: the hot entry is dropped so the answer must come from
      // `driver_profiles`, which is the Delivery-owned durable state.
      await redis.del(redis.key('delivery', 'location', s.jobId));

      const reconnected = await connected(alpha, s.customer.accessToken);
      const ack = await send<{ location: { lat: number } | null }>(
        reconnected,
        'tracking:subscribe',
        { jobId: s.jobId },
      );

      expect(ack.ok).toBe(true);
      expect(ack.data?.location?.lat).toBeCloseTo(9.15, 6);
    });

    it('resubscribing does not create a second stream', async () => {
      const s = await scenario();
      const customerSocket = await connected(alpha, s.customer.accessToken);
      await send(customerSocket, 'tracking:subscribe', { jobId: s.jobId });
      await send(customerSocket, 'tracking:subscribe', { jobId: s.jobId });
      await send(customerSocket, 'tracking:subscribe', { jobId: s.jobId });

      const received: unknown[] = [];
      customerSocket.on('tracking:update', (u: unknown) => received.push(u));

      const driverSocket = await connected(alpha, s.driver.accessToken);
      await send(driverSocket, 'tracking:location', { jobId: s.jobId, ...fix(9.16) });
      await new Promise((resolve) => setTimeout(resolve, 1_200));

      // One fix, one delivery — not three.
      expect(received).toHaveLength(1);
    });

    it('rejects a malformed subscribe without closing the socket', async () => {
      const s = await scenario();
      const socket = await connected(alpha, s.customer.accessToken);

      expect((await send(socket, 'tracking:subscribe', {})).error?.code).toBe(
        ErrorCode.VALIDATION_ERROR,
      );
      expect(
        (await send(socket, 'tracking:subscribe', { jobId: s.jobId, orderId: s.orderId })).error
          ?.code,
      ).toBe(ErrorCode.VALIDATION_ERROR);
      expect(socket.connected).toBe(true);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 14. The claim this whole architecture exists for
  // -------------------------------------------------------------------------------------------

  it('fans a position out from one gateway instance to a subscriber on another', async () => {
    const s = await scenario();

    // The customer is connected to `beta`; the driver posts to `alpha`. Two applications, two
    // HTTP servers, two socket.io instances, one Redis — exactly the production topology behind a
    // load balancer, and the case an in-process fan-out would silently fail.
    const customerSocket = await connected(beta, s.customer.accessToken);
    const subscribed = await send(customerSocket, 'tracking:subscribe', { jobId: s.jobId });
    expect(subscribed.ok).toBe(true);

    const arriving = next<{ lat: number; jobId: string }>(customerSocket, 'tracking:update');

    const driverSocket = await connected(alpha, s.driver.accessToken);
    const posted = await send<{ published: boolean }>(driverSocket, 'tracking:location', {
      jobId: s.jobId,
      ...fix(9.21, 38.82),
    });
    expect(posted.data?.published).toBe(true);

    const update = await arriving;
    expect(update).not.toBeNull();
    expect(update?.jobId).toBe(s.jobId);
    expect(update?.lat).toBeCloseTo(9.21, 6);
  });

  it('does not deliver one delivery’s positions to another delivery’s subscriber', async () => {
    const mine = await scenario();
    const theirs = await scenario();

    const customerSocket = await connected(beta, mine.customer.accessToken);
    await send(customerSocket, 'tracking:subscribe', { jobId: mine.jobId });

    const arriving = next(customerSocket, 'tracking:update', 2_000);

    const otherDriver = await connected(alpha, theirs.driver.accessToken);
    await send(otherDriver, 'tracking:location', { jobId: theirs.jobId, ...fix(9.31) });

    expect(await arriving).toBeNull();
  });

  // -------------------------------------------------------------------------------------------
  // 15. Redis is not load-bearing for durability
  // -------------------------------------------------------------------------------------------

  it('keeps the durable position correct when Redis is unreachable, and says the fan-out failed', async () => {
    const s = await scenario();

    // A third application pointed at a port nothing is listening on. It must boot, serve, and
    // persist — degraded, not broken.
    process.env.REDIS_URL = 'redis://127.0.0.1:6399';
    const isolated = await createTestApp([], {});
    try {
      const result = await isolated.app.get(PublishJobLocationCommand).execute({
        userId: s.driver.userId,
        jobId: s.jobId,
        lat: 9.41,
        lng: 38.91,
        // A second ahead of now — comfortably inside the tolerated clock skew, and guaranteed
        // newer than the position `seedDriver` recorded however fast this app booted.
        recordedAt: new Date(Date.now() + 1_000),
      });

      expect(result.accepted).toBe(true);
      expect(result.persisted).toBe(true);
      // Reported honestly rather than assumed: nobody received this.
      expect(result.published).toBe(false);

      const stored = await alpha.prisma.driverProfile.findUniqueOrThrow({
        where: { id: s.driver.profileId },
      });
      expect(Number(stored.lastLat)).toBeCloseTo(9.41, 6);
    } finally {
      await closeTestApp(isolated);
      process.env.REDIS_URL = process.env.REDIS_TEST_URL;
    }
  }, 60_000);

  // -------------------------------------------------------------------------------------------
  // 12. The HTTP fallback — same authorization, same answer
  // -------------------------------------------------------------------------------------------

  describe('HTTP fallback', () => {
    it('serves the owning customer the last-known position', async () => {
      const s = await scenario();
      const driverSocket = await connected(alpha, s.driver.accessToken);
      await send(driverSocket, 'tracking:location', { jobId: s.jobId, ...fix(9.08, 38.78) });

      const res = await request(alpha.server)
        .get(`/tracking/orders/${s.orderId}`)
        .set(...auth(s.customer.accessToken))
        .expect(200);

      const payload = body(res) as { location: { lat: number }; status: string };
      expect(payload.location.lat).toBeCloseTo(9.08, 6);
      expect(payload.status).toBe(DeliveryJobStatus.PICKED_UP);
    });

    it("answers NOT_FOUND for another customer's order", async () => {
      const s = await scenario();
      const stranger = await createUserWithRole(alpha, 'CUSTOMER');

      const res = await request(alpha.server)
        .get(`/tracking/orders/${s.orderId}`)
        .set(...auth(stranger.accessToken))
        .expect(404);

      expect(errorOf(res).code).toBe(ErrorCode.NOT_FOUND);
    });

    it('requires authentication', async () => {
      const s = await scenario();
      await request(alpha.server).get(`/tracking/orders/${s.orderId}`).expect(401);
    });

    it('serves the assigned driver, who is authorized as the driver rather than as a buyer', async () => {
      // Every registered account also holds `CUSTOMER`, so a driver's token does carry
      // `order:read:own` and does reach the handler. The query is what decides what they see.
      const s = await scenario();
      await request(alpha.server)
        .get(`/tracking/jobs/${s.jobId}`)
        .set(...auth(s.driver.accessToken))
        .expect(200);
    });

    it('answers NOT_FOUND to a driver who is not carrying the job', async () => {
      const s = await scenario();
      const other = await seedDriver();

      const res = await request(alpha.server)
        .get(`/tracking/jobs/${s.jobId}`)
        .set(...auth(other.accessToken))
        .expect(404);

      expect(errorOf(res).code).toBe(ErrorCode.NOT_FOUND);
    });

    it('agrees with the socket, because both ask the same query', async () => {
      const s = await scenario();
      const driverSocket = await connected(alpha, s.driver.accessToken);
      await send(driverSocket, 'tracking:location', { jobId: s.jobId, ...fix(9.09, 38.71) });

      const socket = await connected(alpha, s.customer.accessToken);
      const overSocket = await send<Record<string, unknown>>(socket, 'tracking:subscribe', {
        jobId: s.jobId,
      });
      const overHttp = body(
        await request(alpha.server)
          .get(`/tracking/jobs/${s.jobId}`)
          .set(...auth(s.customer.accessToken))
          .expect(200),
      );

      expect(overSocket.data).toEqual(overHttp);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 20. Nothing internal reaches the customer
  // -------------------------------------------------------------------------------------------

  it('leaks nothing about the driver, the pharmacy or the money', async () => {
    const s = await scenario();
    await alpha.prisma.deliveryJob.update({
      where: { id: s.jobId },
      data: { isCod: true, codAmount: 45_000, isColdChain: true },
    });

    const customerSocket = await connected(alpha, s.customer.accessToken);
    const snapshot = await send<Record<string, unknown>>(customerSocket, 'tracking:subscribe', {
      jobId: s.jobId,
    });
    const arriving = next<Record<string, unknown>>(customerSocket, 'tracking:update');

    const driverSocket = await connected(alpha, s.driver.accessToken);
    await send(driverSocket, 'tracking:location', { jobId: s.jobId, ...fix(9.22) });
    const update = await arriving;

    expect(Object.keys(update ?? {}).sort()).toEqual([
      'eta',
      'fulfillmentId',
      'jobId',
      'lat',
      'lng',
      'orderId',
      'receivedAt',
      'recordedAt',
      'status',
    ]);

    const bytes = JSON.stringify({ snapshot: snapshot.data, update });
    for (const secret of [s.driver.userId, s.driver.profileId, '45000']) {
      expect(bytes).not.toContain(secret);
    }

    // And over HTTP, from the same query.
    const res = await request(alpha.server)
      .get(`/tracking/jobs/${s.jobId}`)
      .set(...auth(s.customer.accessToken))
      .expect(200);
    expect(JSON.stringify(body(res))).not.toContain(s.driver.profileId);
  });

  // -------------------------------------------------------------------------------------------
  // ETA and route calculation (§3.4 F-TRK-02) — against the real wiring and the real Redis cache
  // -------------------------------------------------------------------------------------------

  describe('ETA', () => {
    /** The wire shape both surfaces use. */
    interface EtaWire {
      destination: string;
      distanceMeters: number;
      durationSeconds: number;
      expectedArrivalAt: string;
    }

    async function trackOverHttp(
      ctx: TestContext,
      jobId: string,
      token: string,
    ): Promise<{ eta: EtaWire | null; location: { lat: number } | null; isFinished: boolean }> {
      const res = await request(ctx.server)
        .get(`/tracking/jobs/${jobId}`)
        .set(...auth(token))
        .expect(200);
      return body(res) as never;
    }

    it('rides along with a live position on the socket', async () => {
      const s = await scenario();
      const customerSocket = await connected(alpha, s.customer.accessToken);
      await send(customerSocket, 'tracking:subscribe', { jobId: s.jobId });

      const arriving = next<{ eta: EtaWire | null }>(customerSocket, 'tracking:update');
      const driverSocket = await connected(alpha, s.driver.accessToken);
      await send(driverSocket, 'tracking:location', { jobId: s.jobId, ...fix(9.05, 38.73) });

      const update = await arriving;
      expect(update?.eta).not.toBeNull();
      // Past pickup, so the journey is to the customer's door.
      expect(update?.eta?.destination).toBe(RouteDestination.Dropoff);
      expect(update?.eta?.distanceMeters).toBeGreaterThan(0);
      expect(update?.eta?.durationSeconds).toBeGreaterThan(0);
      expect(Date.parse(update!.eta!.expectedArrivalAt)).toBeGreaterThan(Date.now() - 5_000);
    });

    it('is present on the subscribe snapshot too', async () => {
      const s = await scenario();
      const driverSocket = await connected(alpha, s.driver.accessToken);
      await send(driverSocket, 'tracking:location', { jobId: s.jobId, ...fix(9.06, 38.73) });

      const socket = await connected(alpha, s.customer.accessToken);
      const ack = await send<{ eta: EtaWire | null }>(socket, 'tracking:subscribe', {
        jobId: s.jobId,
      });

      expect(ack.ok).toBe(true);
      expect(ack.data?.eta?.destination).toBe(RouteDestination.Dropoff);
    });

    it('is byte-for-byte the same over REST as over the socket', async () => {
      const s = await scenario();
      const driverSocket = await connected(alpha, s.driver.accessToken);
      await send(driverSocket, 'tracking:location', { jobId: s.jobId, ...fix(9.07, 38.72) });

      const socket = await connected(alpha, s.customer.accessToken);
      const overSocket = await send<Record<string, unknown>>(socket, 'tracking:subscribe', {
        jobId: s.jobId,
      });
      const overHttp = await trackOverHttp(alpha, s.jobId, s.customer.accessToken);

      // §7: one representation, because there is one mapper and one calculation behind both.
      expect(overSocket.data).toEqual(overHttp);
      expect(overHttp.eta).not.toBeNull();
    });

    it('targets the pharmacy before pickup and the customer after it', async () => {
      const s = await scenario();
      // Rewind to pre-pickup and read the destination the platform chooses.
      await alpha.prisma.deliveryJob.update({
        where: { id: s.jobId },
        data: { status: DeliveryJobStatus.ASSIGNED, pickedUpAt: null },
      });
      const before = await trackOverHttp(alpha, s.jobId, s.customer.accessToken);
      expect(before.eta?.destination).toBe(RouteDestination.Pickup);

      await alpha.prisma.deliveryJob.update({
        where: { id: s.jobId },
        data: { status: DeliveryJobStatus.PICKED_UP, pickedUpAt: new Date() },
      });
      const after = await trackOverHttp(alpha, s.jobId, s.customer.accessToken);
      expect(after.eta?.destination).toBe(RouteDestination.Dropoff);

      // Genuinely two routes rather than one cached answer relabelled: the pickup and the dropoff
      // are kilometres apart, and the cache key carries the destination.
      expect(after.eta?.distanceMeters).not.toBe(before.eta?.distanceMeters);
    });

    it('has none for a delivered job, and says so without inventing a zero', async () => {
      const s = await scenario();
      for (const to of [
        DeliveryJobStatus.EN_ROUTE,
        DeliveryJobStatus.ARRIVED_DROPOFF,
        DeliveryJobStatus.DELIVERED,
      ]) {
        await advance.byDriver({ userId: s.driver.userId, jobId: s.jobId, to });
      }

      const payload = await trackOverHttp(alpha, s.jobId, s.customer.accessToken);

      expect(payload.eta).toBeNull();
      expect(payload.isFinished).toBe(true);
      // The position is still served — only the estimate is withheld.
      expect(payload.location).not.toBeNull();
    });

    it('has none when the driver has not reported a position', async () => {
      const s = await scenario();
      await alpha.prisma.driverProfile.update({
        where: { id: s.driver.profileId },
        data: { lastLat: null, lastLng: null, lastLocationAt: null },
      });
      await redis.del(redis.key('delivery', 'location', s.jobId));

      expect((await trackOverHttp(alpha, s.jobId, s.customer.accessToken)).eta).toBeNull();
    });

    it('has none from a position too old to trust, but still serves that position', async () => {
      const s = await scenario();
      await alpha.prisma.driverProfile.update({
        where: { id: s.driver.profileId },
        data: {
          lastLat: 9.05,
          lastLng: 38.73,
          lastLocationAt: new Date(Date.now() - 30 * 60_000),
        },
      });
      await redis.del(redis.key('delivery', 'location', s.jobId));

      const payload = await trackOverHttp(alpha, s.jobId, s.customer.accessToken);

      // §8: no confident arrival time from a half-hour-old fix — and no invented "offline" state.
      expect(payload.eta).toBeNull();
      expect(payload.location?.lat).toBeCloseTo(9.05, 6);
    });

    it('exposes nothing a routing vendor could be identified by', async () => {
      const s = await scenario();
      const driverSocket = await connected(alpha, s.driver.accessToken);
      await send(driverSocket, 'tracking:location', { jobId: s.jobId, ...fix(9.04, 38.75) });

      const payload = await trackOverHttp(alpha, s.jobId, s.customer.accessToken);

      expect(Object.keys(payload.eta ?? {}).sort()).toEqual([
        'destination',
        'distanceMeters',
        'durationSeconds',
        'expectedArrivalAt',
      ]);
      const bytes = JSON.stringify(payload).toLowerCase();
      for (const vendor of ['google', 'mapbox', 'osrm', 'openroute', 'polyline', 'provider']) {
        expect(bytes).not.toContain(vendor);
      }
    });

    it('is refused to a customer who does not own the delivery', async () => {
      const s = await scenario();
      const stranger = await createUserWithRole(alpha, 'CUSTOMER');

      await request(alpha.server)
        .get(`/tracking/jobs/${s.jobId}`)
        .set(...auth(stranger.accessToken))
        .expect(404);
    });

    it('keeps tracking alive, and the job untouched, when routing fails', async () => {
      const s = await scenario();
      const before = await alpha.prisma.deliveryJob.findUniqueOrThrow({ where: { id: s.jobId } });

      // A routing port that rejects on every call — the failure mode a real HTTP client has.
      const broken = await createTestApp(
        [
          {
            provide: ROUTING_PORT,
            useValue: { route: () => Promise.reject(new Error('map service unreachable')) },
          },
        ],
        { listen: true },
      );

      try {
        const socket = await connected(broken, s.customer.accessToken);
        const ack = await send<{ eta: unknown; location: { lat: number } | null }>(
          socket,
          'tracking:subscribe',
          { jobId: s.jobId },
        );

        // §9: the socket is healthy, the subscribe succeeded, the position is there, and the ETA
        // is simply absent.
        expect(ack.ok).toBe(true);
        expect(ack.data?.eta).toBeNull();
        expect(ack.data?.location).not.toBeNull();
        expect(socket.connected).toBe(true);

        const res = await request(broken.server)
          .get(`/tracking/jobs/${s.jobId}`)
          .set(...auth(s.customer.accessToken))
          .expect(200);
        expect((body(res) as { eta: unknown }).eta).toBeNull();

        // And a driver can still post a position through the broken node.
        const driverSocket = await connected(broken, s.driver.accessToken);
        const posted = await send<{ accepted: boolean }>(driverSocket, 'tracking:location', {
          jobId: s.jobId,
          ...fix(9.08, 38.71),
        });
        expect(posted.data?.accepted).toBe(true);
      } finally {
        await closeTestApp(broken);
      }

      // §18: the job is exactly as it was. A map service is not allowed to fail a delivery.
      const after = await alpha.prisma.deliveryJob.findUniqueOrThrow({ where: { id: s.jobId } });
      expect(after.status).toBe(before.status);
      expect(after.assignedDriverId).toBe(before.assignedDriverId);
    }, 60_000);

    it('reuses one cached route across two nodes rather than recomputing per instance', async () => {
      const s = await scenario();
      const driverSocket = await connected(alpha, s.driver.accessToken);
      await send(driverSocket, 'tracking:location', { jobId: s.jobId, ...fix(9.09, 38.7) });

      // Computed on alpha, read back on beta. The cache is in Redis, so the answer does not depend
      // on which node the customer's request happens to land on (§5).
      const fromAlpha = await trackOverHttp(alpha, s.jobId, s.customer.accessToken);
      const fromBeta = await trackOverHttp(beta, s.jobId, s.customer.accessToken);

      expect(fromBeta.eta).toEqual(fromAlpha.eta);
    });

    it('keeps the pickup and dropoff estimates under separate Redis keys', async () => {
      const s = await scenario();
      await alpha.prisma.deliveryJob.update({
        where: { id: s.jobId },
        data: { status: DeliveryJobStatus.ASSIGNED, pickedUpAt: null },
      });
      await trackOverHttp(alpha, s.jobId, s.customer.accessToken);

      await alpha.prisma.deliveryJob.update({
        where: { id: s.jobId },
        data: { status: DeliveryJobStatus.PICKED_UP, pickedUpAt: new Date() },
      });
      await trackOverHttp(alpha, s.jobId, s.customer.accessToken);

      const pickupKey = redis.key('delivery', 'eta', s.jobId, RouteDestination.Pickup);
      const dropoffKey = redis.key('delivery', 'eta', s.jobId, RouteDestination.Dropoff);
      const pickup = await redis.get(pickupKey);
      const dropoff = await redis.get(dropoffKey);

      expect(pickup).not.toBeNull();
      expect(dropoff).not.toBeNull();
      expect(pickup).not.toEqual(dropoff);
    });
  });

  // -------------------------------------------------------------------------------------------
  // A driver released from a job loses the stream with it
  // -------------------------------------------------------------------------------------------

  it('stops accepting positions from a driver the job was reassigned away from', async () => {
    const s = await scenario();
    // Reassignment is pre-pickup only, so rewind the job to ASSIGNED for this one.
    await alpha.prisma.deliveryJob.update({
      where: { id: s.jobId },
      data: { status: DeliveryJobStatus.ASSIGNED, pickedUpAt: null },
    });
    const socket = await connected(alpha, s.driver.accessToken);
    expect((await send(socket, 'tracking:location', { jobId: s.jobId, ...fix(9.5) })).ok).toBe(true);

    await alpha.prisma.deliveryJob.update({
      where: { id: s.jobId },
      data: { status: DeliveryJobStatus.REASSIGNING, assignedDriverId: null },
    });

    const after = await send(socket, 'tracking:location', { jobId: s.jobId, ...fix(9.6) });
    expect(after.ok).toBe(false);
    expect(after.error?.code).toBe(ErrorCode.NOT_FOUND);
  });

  it("never shows a customer the position of a driver who no longer holds the job", async () => {
    const s = await scenario();
    const driverSocket = await connected(alpha, s.driver.accessToken);
    await send(driverSocket, 'tracking:location', { jobId: s.jobId, ...fix(9.77, 38.99) });

    // The job moves to a different driver who has not reported yet.
    const replacement = await seedDriver();
    await alpha.prisma.driverProfile.update({
      where: { id: replacement.profileId },
      data: { lastLat: null, lastLng: null, lastLocationAt: null },
    });
    await alpha.prisma.deliveryJob.update({
      where: { id: s.jobId },
      data: { assignedDriverId: replacement.profileId },
    });

    const socket = await connected(alpha, s.customer.accessToken);
    const ack = await send<{ location: unknown }>(socket, 'tracking:subscribe', {
      jobId: s.jobId,
    });

    // The previous driver's cached fix is discarded rather than served.
    expect(ack.data?.location).toBeNull();
  });
});
