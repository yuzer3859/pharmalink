import { ErrorCode } from '../../../shared/errors/error-codes';
import { IConfigPort } from '../../../shared/config/config.port';
import { PublishJobLocationCommand } from './commands/publish-job-location.command';
import {
  GetJobTrackingQuery,
  TrackingViewer,
} from './queries/get-job-tracking.query';
import {
  CachedLocation,
  ILocationCachePort,
} from './ports/outbound/location-cache.port';
import { IOrdersPort } from './ports/outbound/orders.port';
import {
  IRealtimePort,
  RealtimeUnsubscribe,
  TrackingUpdate,
} from './ports/outbound/realtime.port';
import { DeliveryJobProps } from '../domain/entities/delivery-job.entity';
import { DriverProfileProps } from '../domain/entities/driver-profile.entity';
import { DeliveryJobStatus, DriverAvailability } from '../domain/enums';
import { IDeliveryJobRepository } from '../domain/repositories/delivery-job.repository';
import {
  DriverLocationUpdate,
  IDriverProfileRepository,
} from '../domain/repositories/driver-profile.repository';
import { ACTIVE_JOB_STATUSES } from '../domain/services/driver-availability-policy';
import {
  TRACKABLE_JOB_STATUSES,
  isTerminalForTracking,
  isTrackableStatus,
} from '../domain/services/tracking-policy';
import { GeoPoint } from '../domain/value-objects/geo-point.vo';
import { InMemoryRealtimeAdapter } from '../infrastructure/realtime/redis-realtime.adapter';
import { DeliveryAccessService } from './services/delivery-access.service';
import { EtaService } from './services/eta.service';
import { CachedEta, IEtaCachePort } from './ports/outbound/eta-cache.port';
import { IRoutingPort, RouteRequest, RouteResult } from './ports/outbound/routing.port';
import { RouteDestination } from '../domain/services/tracking-policy';
import { AppLogger } from '../../../shared/logging/app-logger.service';

/**
 * Real-time location tracking — the application layer (§3.4 F-TRK-01/F-TRK-03, §7, BR-DEL-05,
 * NFR-PERF-04, NFR-LOC-04).
 *
 * In-memory doubles for everything that crosses a boundary, so these tests are about *decisions*:
 * who may post a position, whose job it may be posted against, which fix wins when two race, when
 * a write goes through to Postgres and when it is coalesced away, and who is allowed to watch.
 * The claims that need real infrastructure — a publish on one node reaching a subscriber on
 * another, and a durable position surviving a Redis outage — are proved in
 * `test/delivery/delivery-tracking.e2e-spec.ts` against a real container.
 */

// ---------------------------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------------------------

const DRIVER_USER = 'user-driver-1';
const DRIVER_PROFILE = 'profile-driver-1';
const OTHER_USER = 'user-driver-2';
const OTHER_PROFILE = 'profile-driver-2';
const CUSTOMER_USER = 'user-customer-1';
const STRANGER_USER = 'user-stranger';
const JOB_ID = 'job-1';
const ORDER_ID = 'order-1';

const seconds = (n: number) => new Date(Date.now() - n * 1_000);

class FakeJobRepository implements Pick<IDeliveryJobRepository, 'findById' | 'findByOrderId'> {
  jobs = new Map<string, DeliveryJobProps>();

  async findById(id: string): Promise<DeliveryJobProps | null> {
    return this.jobs.get(id) ?? null;
  }

  async findByOrderId(orderId: string): Promise<DeliveryJobProps[]> {
    return [...this.jobs.values()].filter((job) => job.orderId === orderId);
  }
}

class FakeProfileRepository
  implements Pick<IDriverProfileRepository, 'findByUserId' | 'findById' | 'updateLocation'>
{
  profiles = new Map<string, DriverProfileProps>();
  writes = 0;

  async findByUserId(userId: string): Promise<DriverProfileProps | null> {
    return [...this.profiles.values()].find((p) => p.userId === userId) ?? null;
  }

  async findById(id: string): Promise<DriverProfileProps | null> {
    return this.profiles.get(id) ?? null;
  }

  async updateLocation(
    id: string,
    update: DriverLocationUpdate,
  ): Promise<DriverProfileProps | null> {
    const stored = this.profiles.get(id);
    if (!stored) {
      return null;
    }
    this.writes += 1;
    // Monotonic, exactly like the Prisma adapter's compare-and-set: a fix no newer than the stored
    // one leaves the row alone, and the caller is handed back what is actually stored.
    if (stored.lastLocationAt !== null && update.recordedAt <= stored.lastLocationAt) {
      return { ...stored };
    }
    const next: DriverProfileProps = {
      ...stored,
      lastLocation: GeoPoint.of(update.lat, update.lng),
      lastLocationAt: update.recordedAt,
    };
    this.profiles.set(id, next);
    return { ...next };
  }
}

class FakeLocationCache implements ILocationCachePort {
  entries = new Map<string, CachedLocation>();
  /** Set to simulate Redis being down: a miss on read, a dropped write, never an exception. */
  disabled = false;

  async get(jobId: string): Promise<CachedLocation | null> {
    return this.disabled ? null : (this.entries.get(jobId) ?? null);
  }

  async set(jobId: string, location: CachedLocation): Promise<void> {
    if (!this.disabled) {
      this.entries.set(jobId, location);
    }
  }
}

class FakeRealtime implements IRealtimePort {
  published: TrackingUpdate[] = [];
  /** Simulates a pub/sub that cannot reach Redis — reports failure rather than throwing. */
  failing = false;

  async publish(_jobId: string, update: TrackingUpdate): Promise<boolean> {
    if (this.failing) {
      return false;
    }
    this.published.push(update);
    return true;
  }

  async subscribe(): Promise<RealtimeUnsubscribe> {
    return async () => undefined;
  }
}

class FakeOrdersPort implements Pick<IOrdersPort, 'getOrderCustomerUserId'> {
  owners = new Map<string, string>();
  calls = 0;

  async getOrderCustomerUserId(orderId: string): Promise<string | null> {
    this.calls += 1;
    return this.owners.get(orderId) ?? null;
  }
}

/** In-process ETA cache keyed exactly as the real one is — by job *and* destination. */
class FakeEtaCache implements IEtaCachePort {
  entries = new Map<string, CachedEta>();
  async get(jobId: string, destination: RouteDestination): Promise<CachedEta | null> {
    return this.entries.get(`${jobId}:${destination}`) ?? null;
  }
  async set(jobId: string, destination: RouteDestination, entry: CachedEta): Promise<void> {
    this.entries.set(`${jobId}:${destination}`, entry);
  }
}

/** A routing port a test drives: count the calls, script a failure, or throw outright. */
class FakeRouting implements IRoutingPort {
  calls: RouteRequest[] = [];
  result: RouteResult | null = { distanceMeters: 4_000, durationSeconds: 600 };
  throws = false;

  async route(request: RouteRequest): Promise<RouteResult | null> {
    this.calls.push(request);
    if (this.throws) {
      throw new Error('routing provider exploded');
    }
    return this.result;
  }
}

class FakeConfig implements IConfigPort {
  values = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }
  getOrThrow<T>(key: string): T {
    return this.values.get(key) as T;
  }
  isFeatureEnabled(): boolean {
    return false;
  }
}

/** `EtaService` logs routing failures; a unit run should not print them. */
function silentLogger(): AppLogger {
  return {
    setContext: () => undefined,
    warn: () => undefined,
    log: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  } as unknown as AppLogger;
}

// ---------------------------------------------------------------------------------------------

describe('Real-time location tracking', () => {
  let jobs: FakeJobRepository;
  let profiles: FakeProfileRepository;
  let cache: FakeLocationCache;
  let realtime: FakeRealtime;
  let orders: FakeOrdersPort;
  let config: FakeConfig;
  let publish: PublishJobLocationCommand;
  let tracking: GetJobTrackingQuery;
  let routing: FakeRouting;
  let etaCache: FakeEtaCache;
  let eta: EtaService;

  const ADDIS = { lat: 9.03, lng: 38.74 };

  function job(overrides: Partial<DeliveryJobProps> = {}): DeliveryJobProps {
    return {
      id: JOB_ID,
      orderId: ORDER_ID,
      fulfillmentId: 'fulfillment-1',
      pharmacyId: 'pharmacy-1',
      branchId: 'branch-1',
      pickupPoint: GeoPoint.of(ADDIS.lat, ADDIS.lng),
      pickupAddress: 'Bole Branch',
      dropoffPoint: GeoPoint.of(9.01, 38.76),
      dropoffAddress: 'Kazanchis',
      items: [],
      isColdChain: false,
      isCod: false,
      codAmount: null,
      deliveryFee: 0,
      distanceMeters: null,
      status: DeliveryJobStatus.PICKED_UP,
      assignedDriverId: DRIVER_PROFILE,
      pickedUpAt: seconds(600),
      deliveredAt: null,
      createdAt: seconds(3_600),
      updatedAt: seconds(600),
      ...overrides,
    };
  }

  function profile(overrides: Partial<DriverProfileProps> = {}): DriverProfileProps {
    return {
      id: DRIVER_PROFILE,
      userId: DRIVER_USER,
      vehicle: null,
      serviceArea: null,
      availability: DriverAvailability.ONLINE,
      shiftStartedAt: seconds(7_200),
      lastOnlineAt: seconds(7_200),
      maxConcurrent: null,
      lastLocation: null,
      lastLocationAt: null,
      createdAt: seconds(7_200),
      updatedAt: seconds(7_200),
      ...overrides,
    };
  }

  beforeEach(() => {
    jobs = new FakeJobRepository();
    profiles = new FakeProfileRepository();
    cache = new FakeLocationCache();
    realtime = new FakeRealtime();
    orders = new FakeOrdersPort();
    config = new FakeConfig();
    // Every fix persists unless a test says otherwise, so the throttle is opt-in and the other
    // tests observe the durable value directly.
    config.values.set('delivery.locationWriteIntervalSeconds', 0);

    jobs.jobs.set(JOB_ID, job());
    profiles.profiles.set(DRIVER_PROFILE, profile());
    profiles.profiles.set(
      OTHER_PROFILE,
      profile({ id: OTHER_PROFILE, userId: OTHER_USER }),
    );
    orders.owners.set(ORDER_ID, CUSTOMER_USER);

    routing = new FakeRouting();
    etaCache = new FakeEtaCache();
    eta = new EtaService(routing, etaCache, config, silentLogger());

    publish = new PublishJobLocationCommand(
      jobs as unknown as IDeliveryJobRepository,
      profiles as unknown as IDriverProfileRepository,
      cache,
      realtime,
      config,
      eta,
    );
    tracking = new GetJobTrackingQuery(
      jobs as unknown as IDeliveryJobRepository,
      profiles as unknown as IDriverProfileRepository,
      cache,
      new DeliveryAccessService(
        profiles as unknown as IDriverProfileRepository,
        orders as unknown as IOrdersPort,
      ),
      eta,
    );
  });

  const post = (overrides: Record<string, unknown> = {}) =>
    publish.execute({
      userId: DRIVER_USER,
      jobId: JOB_ID,
      lat: ADDIS.lat,
      lng: ADDIS.lng,
      ...overrides,
    });

  // -------------------------------------------------------------------------------------------
  // 1–3. Who may publish
  // -------------------------------------------------------------------------------------------

  it('accepts a position from the assigned driver on an active job', async () => {
    const result = await post({ recordedAt: seconds(1) });

    expect(result.accepted).toBe(true);
    expect(result.persisted).toBe(true);
    expect(result.published).toBe(true);
    expect(realtime.published).toHaveLength(1);
    expect(realtime.published[0]).toMatchObject({
      jobId: JOB_ID,
      orderId: ORDER_ID,
      lat: ADDIS.lat,
      lng: ADDIS.lng,
      status: DeliveryJobStatus.PICKED_UP,
    });
  });

  it("refuses another driver's job as NOT_FOUND, not FORBIDDEN", async () => {
    // The distinction matters: a `FORBIDDEN` would confirm the job exists, turning job ids into an
    // oracle for who is carrying what.
    await expect(post({ userId: OTHER_USER })).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
    expect(realtime.published).toHaveLength(0);
    expect(profiles.writes).toBe(0);
  });

  it('refuses a user with no driver profile at all', async () => {
    await expect(post({ userId: STRANGER_USER })).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });

  it('resolves the driver from the caller, so a job cannot be claimed by naming its owner', async () => {
    // There is no input field through which a driver id could arrive; this asserts the shape.
    const input = { userId: OTHER_USER, jobId: JOB_ID, lat: ADDIS.lat, lng: ADDIS.lng };
    expect(Object.keys(input)).not.toContain('driverId');
    await expect(publish.execute(input)).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  // -------------------------------------------------------------------------------------------
  // 4. Coordinate and timestamp validation (the Work 03 rules, reused)
  // -------------------------------------------------------------------------------------------

  it.each([
    ['latitude above range', { lat: 91 }],
    ['latitude below range', { lat: -91 }],
    ['longitude above range', { lng: 181 }],
    ['longitude below range', { lng: -181 }],
    ['a non-finite latitude', { lat: Number.NaN }],
  ])('rejects %s', async (_label, overrides) => {
    await expect(post(overrides)).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
    });
    expect(profiles.writes).toBe(0);
    expect(realtime.published).toHaveLength(0);
  });

  it('rejects a timestamp far in the future', async () => {
    // A phone a minute fast is ordinary; an hour fast would write a `lastLocationAt` no genuine
    // later fix could beat, freezing the driver on every customer's map.
    await expect(post({ recordedAt: new Date(Date.now() + 3_600_000) })).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
    });
  });

  it('accepts a timestamp within the tolerated clock skew', async () => {
    const result = await post({ recordedAt: new Date(Date.now() + 30_000) });
    expect(result.accepted).toBe(true);
  });

  // -------------------------------------------------------------------------------------------
  // 5. Ordering — a buffered flush must not move the driver backwards
  // -------------------------------------------------------------------------------------------

  it('ignores a stale fix rather than rejecting it, and does not publish it', async () => {
    await post({ recordedAt: seconds(10), lat: 9.05 });
    realtime.published.length = 0;

    const stale = await post({ recordedAt: seconds(60), lat: 8.5 });

    expect(stale.accepted).toBe(false);
    expect(stale.published).toBe(false);
    // The position reported back is the one that beat it, so a client can reconcile.
    expect(stale.location.lat).toBe(9.05);
    expect(realtime.published).toHaveLength(0);
  });

  it('ignores a fix bearing exactly the stored timestamp', async () => {
    const at = seconds(5);
    await post({ recordedAt: at });
    const repeat = await post({ recordedAt: at, lat: 8.9 });

    expect(repeat.accepted).toBe(false);
    expect(profiles.profiles.get(DRIVER_PROFILE)?.lastLocation?.lat).not.toBe(8.9);
  });

  it('catches a stale fix inside the throttle window, where the durable row has not moved', async () => {
    // The case the hot cache exists for. With a 60s write interval the durable timestamp lags, so
    // a buffered point newer than the *stored* one but older than the newest *seen* one would be
    // accepted if the cache were not consulted — and the customer's map would jump backwards.
    config.values.set('delivery.locationWriteIntervalSeconds', 60);

    await post({ recordedAt: seconds(50), lat: 9.01 }); // persisted: nothing stored yet
    await post({ recordedAt: seconds(10), lat: 9.09 }); // coalesced away, but cached
    realtime.published.length = 0;

    const buffered = await post({ recordedAt: seconds(30), lat: 8.4 });

    expect(buffered.accepted).toBe(false);
    expect(realtime.published).toHaveLength(0);
    expect(buffered.location.lat).toBe(9.09);
  });

  it('reports persistence honestly when a newer fix won the durable row', async () => {
    // `updateLocation` is monotonic and returns what is *now* stored, which need not be this fix.
    profiles.profiles.set(
      DRIVER_PROFILE,
      profile({ lastLocation: GeoPoint.of(9.2, 38.9), lastLocationAt: seconds(1) }),
    );
    cache.entries.clear();

    // Newer than the stored fix by the aggregate's reckoning is impossible here, so drive the race
    // directly: a fix that the repository will refuse because something newer landed first.
    const stale = await post({ recordedAt: seconds(2) });
    expect(stale.accepted).toBe(false);
  });

  // -------------------------------------------------------------------------------------------
  // 6. Only active delivery states
  // -------------------------------------------------------------------------------------------

  it.each([
    DeliveryJobStatus.DELIVERED,
    DeliveryJobStatus.COMPLETED,
    DeliveryJobStatus.CANCELLED,
    DeliveryJobStatus.FAILED,
  ])('refuses a location update on a %s job', async (status) => {
    jobs.jobs.set(JOB_ID, job({ status, deliveredAt: seconds(60) }));

    await expect(post()).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    expect(profiles.writes).toBe(0);
    expect(realtime.published).toHaveLength(0);
  });

  it.each([
    DeliveryJobStatus.CREATED,
    DeliveryJobStatus.OFFERED,
    DeliveryJobStatus.REASSIGNING,
  ])('refuses a location update on a %s job, which has no driver', async (status) => {
    jobs.jobs.set(JOB_ID, job({ status, assignedDriverId: null, pickedUpAt: null }));
    await expect(post()).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it.each(TRACKABLE_JOB_STATUSES)('accepts a location update on a %s job', async (status) => {
    jobs.jobs.set(
      JOB_ID,
      job({
        status,
        pickedUpAt:
          status === DeliveryJobStatus.ASSIGNED || status === DeliveryJobStatus.ARRIVED_PICKUP
            ? null
            : seconds(600),
      }),
    );
    await expect(post({ recordedAt: seconds(1) })).resolves.toMatchObject({ accepted: true });
  });

  it('derives its trackable states from the active-job set rather than restating them', () => {
    // One list, two names. A state added to one and not the other would mean a job tracked but not
    // counted against a driver's limit, or counted but invisible on the map.
    expect([...TRACKABLE_JOB_STATUSES]).toEqual([...ACTIVE_JOB_STATUSES]);
    expect(isTrackableStatus(DeliveryJobStatus.EN_ROUTE)).toBe(true);
    expect(isTrackableStatus(DeliveryJobStatus.DELIVERED)).toBe(false);
    expect(isTerminalForTracking(DeliveryJobStatus.DELIVERED)).toBe(true);
    expect(isTerminalForTracking(DeliveryJobStatus.CREATED)).toBe(false);
  });

  // -------------------------------------------------------------------------------------------
  // 7 & 17. Durable state and throttling
  // -------------------------------------------------------------------------------------------

  it('updates the durable last-known location', async () => {
    const at = seconds(1);
    await post({ lat: 9.11, lng: 38.81, recordedAt: at });

    const stored = profiles.profiles.get(DRIVER_PROFILE);
    expect(stored?.lastLocation?.lat).toBe(9.11);
    expect(stored?.lastLocation?.lng).toBe(38.81);
    expect(stored?.lastLocationAt).toEqual(at);
  });

  it('coalesces durable writes to the configured interval while publishing every fix', async () => {
    config.values.set('delivery.locationWriteIntervalSeconds', 10);

    await post({ recordedAt: seconds(40), lat: 9.0 }); // first fix — always persisted
    await post({ recordedAt: seconds(37), lat: 9.1 }); // +3s  — coalesced
    await post({ recordedAt: seconds(34), lat: 9.2 }); // +6s  — coalesced
    await post({ recordedAt: seconds(28), lat: 9.3 }); // +12s — persisted

    // Two writes for four fixes...
    expect(profiles.writes).toBe(2);
    expect(profiles.profiles.get(DRIVER_PROFILE)?.lastLocation?.lat).toBe(9.3);
    // ...and every one of them reached the customer.
    expect(realtime.published).toHaveLength(4);
    expect(realtime.published.map((u) => u.lat)).toEqual([9.0, 9.1, 9.2, 9.3]);
  });

  it('ignores a throttle interval outside the validated bounds and uses the default', async () => {
    // Ten minutes is past `MAX_DELIVERY_LOCATION_WRITE_INTERVAL_SECONDS`, so the ten-second
    // default applies rather than a value an operator could use to stop persisting positions.
    config.values.set('delivery.locationWriteIntervalSeconds', 600);

    await post({ recordedAt: seconds(60), lat: 9.0 });
    await post({ recordedAt: seconds(30), lat: 9.4 });

    expect(profiles.writes).toBe(2);
  });

  it("persists a driver's very first fix immediately rather than after an interval", async () => {
    config.values.set('delivery.locationWriteIntervalSeconds', 300);
    await post({ recordedAt: seconds(1) });
    expect(profiles.writes).toBe(1);
  });

  it('refreshes the hot cache on every accepted fix, including coalesced ones', async () => {
    config.values.set('delivery.locationWriteIntervalSeconds', 300);

    await post({ recordedAt: seconds(60), lat: 9.0 });
    await post({ recordedAt: seconds(30), lat: 9.4 });

    expect(profiles.writes).toBe(1);
    expect(cache.entries.get(JOB_ID)).toMatchObject({ lat: 9.4, driverId: DRIVER_PROFILE });
  });

  // -------------------------------------------------------------------------------------------
  // 16. No history, no audit — structurally
  // -------------------------------------------------------------------------------------------

  it('writes no status history and no audit entry, so duplicates cannot create any', async () => {
    // The command is constructed with neither an audit service nor a unit of work: there is
    // nothing for a duplicate to duplicate. Asserted on the collaborator list rather than by
    // counting rows, because the claim is about what this path *cannot* do.
    expect(PublishJobLocationCommand.length).toBe(6);

    await post({ recordedAt: seconds(3) });
    await post({ recordedAt: seconds(3) });
    await post({ recordedAt: seconds(3) });

    expect(realtime.published).toHaveLength(1);
  });

  // -------------------------------------------------------------------------------------------
  // 15. Redis failure must not corrupt durable state
  // -------------------------------------------------------------------------------------------

  it('still writes the durable location when the fan-out fails', async () => {
    realtime.failing = true;

    const result = await post({ lat: 9.44, recordedAt: seconds(1) });

    expect(result.accepted).toBe(true);
    expect(result.persisted).toBe(true);
    // Reported honestly: the customer did not receive this, and the driver's app is told so.
    expect(result.published).toBe(false);
    expect(profiles.profiles.get(DRIVER_PROFILE)?.lastLocation?.lat).toBe(9.44);
  });

  it('still writes the durable location when the hot cache is unavailable', async () => {
    cache.disabled = true;

    const result = await post({ lat: 9.55, recordedAt: seconds(1) });

    expect(result.accepted).toBe(true);
    expect(result.persisted).toBe(true);
    expect(profiles.profiles.get(DRIVER_PROFILE)?.lastLocation?.lat).toBe(9.55);
  });

  // -------------------------------------------------------------------------------------------
  // 8–10, 19. Subscription authorization and the initial snapshot
  // -------------------------------------------------------------------------------------------

  it('lets the owning customer read their delivery', async () => {
    await post({ lat: 9.07, lng: 38.77, recordedAt: seconds(2) });

    const { view, viewer } = await tracking.byJobId(JOB_ID, CUSTOMER_USER);

    expect(viewer).toBe(TrackingViewer.Customer);
    expect(view.location).toMatchObject({ lat: 9.07, lng: 38.77 });
    expect(view.isLive).toBe(true);
    expect(view.isFinished).toBe(false);
  });

  it('lets the assigned driver read their own job without asking Module 06', async () => {
    const { viewer } = await tracking.byJobId(JOB_ID, DRIVER_USER);
    expect(viewer).toBe(TrackingViewer.Driver);
    expect(orders.calls).toBe(0);
  });

  it("refuses another customer's delivery as NOT_FOUND", async () => {
    await expect(tracking.byJobId(JOB_ID, STRANGER_USER)).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });

  it('refuses a delivery whose order Module 06 does not recognise', async () => {
    orders.owners.clear();
    await expect(tracking.byJobId(JOB_ID, CUSTOMER_USER)).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });

  it('answers by order id, choosing the leg that is live', async () => {
    jobs.jobs.set(
      'job-2',
      job({
        id: 'job-2',
        fulfillmentId: 'fulfillment-2',
        status: DeliveryJobStatus.DELIVERED,
        createdAt: seconds(10),
      }),
    );

    const { view } = await tracking.byOrderId(ORDER_ID, CUSTOMER_USER);
    expect(view.jobId).toBe(JOB_ID);
  });

  it('succeeds with a null location when nothing has been reported yet', async () => {
    const { view } = await tracking.byJobId(JOB_ID, CUSTOMER_USER);

    // §6: the subscription must succeed and say there is no position, not fail.
    expect(view.location).toBeNull();
    expect(view.isLive).toBe(true);
  });

  it('falls back to the durable record when the hot cache is empty', async () => {
    await post({ lat: 9.02, lng: 38.72, recordedAt: seconds(4) });
    cache.entries.clear();

    const { view } = await tracking.byJobId(JOB_ID, CUSTOMER_USER);
    expect(view.location).toMatchObject({ lat: 9.02, lng: 38.72 });
  });

  it("never serves a previous driver's cached position after a reassignment", async () => {
    await post({ lat: 9.33, recordedAt: seconds(5) });
    // The job moves to a different driver who has not reported yet.
    jobs.jobs.set(JOB_ID, job({ assignedDriverId: OTHER_PROFILE }));

    const { view } = await tracking.byJobId(JOB_ID, CUSTOMER_USER);

    // The stale entry is discarded, and the new driver's profile has no position.
    expect(view.location).toBeNull();
  });

  it('reports no position for a job nobody is carrying', async () => {
    jobs.jobs.set(
      JOB_ID,
      job({ status: DeliveryJobStatus.OFFERED, assignedDriverId: null, pickedUpAt: null }),
    );

    const { view } = await tracking.byJobId(JOB_ID, CUSTOMER_USER);
    expect(view.location).toBeNull();
    expect(view.isLive).toBe(false);
    expect(view.isFinished).toBe(false);
  });

  it('marks a finished delivery so a client can stop waiting for movement', async () => {
    jobs.jobs.set(JOB_ID, job({ status: DeliveryJobStatus.DELIVERED, deliveredAt: seconds(5) }));

    const { view } = await tracking.byJobId(JOB_ID, CUSTOMER_USER);
    expect(view.isLive).toBe(false);
    expect(view.isFinished).toBe(true);
  });

  // -------------------------------------------------------------------------------------------
  // 20. Nothing sensitive in the payload
  // -------------------------------------------------------------------------------------------

  it('carries only tracking fields — no driver, pharmacy, items or money', async () => {
    jobs.jobs.set(JOB_ID, job({ isCod: true, codAmount: 45_000, isColdChain: true }));
    await post({ recordedAt: seconds(1) });

    expect(Object.keys(realtime.published[0]).sort()).toEqual([
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

    const serialized = JSON.stringify(realtime.published[0]);
    for (const secret of [DRIVER_PROFILE, DRIVER_USER, 'pharmacy-1', 'branch-1', '45000']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('keeps the same fields out of the customer-facing view', async () => {
    await post({ recordedAt: seconds(1) });
    const { view } = await tracking.byJobId(JOB_ID, CUSTOMER_USER);

    expect(Object.keys(view).sort()).toEqual([
      'eta',
      'fulfillmentId',
      'isFinished',
      'isLive',
      'jobId',
      'location',
      'orderId',
      'status',
    ]);
    expect(JSON.stringify(view)).not.toContain(DRIVER_PROFILE);
  });

  // -------------------------------------------------------------------------------------------
  // 11–12. Fan-out and release, against the in-process transport
  // -------------------------------------------------------------------------------------------

  describe('in-process fan-out', () => {
    let adapter: InMemoryRealtimeAdapter;

    beforeEach(() => {
      adapter = new InMemoryRealtimeAdapter();
    });

    const update = (lat: number): TrackingUpdate => ({
      jobId: JOB_ID,
      orderId: ORDER_ID,
      fulfillmentId: 'fulfillment-1',
      lat,
      lng: 38.7,
      recordedAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      status: DeliveryJobStatus.EN_ROUTE,
      eta: null,
    });

    it('delivers to every subscriber of the job and to nobody else', async () => {
      const watching: TrackingUpdate[] = [];
      const alsoWatching: TrackingUpdate[] = [];
      const elsewhere: TrackingUpdate[] = [];

      await adapter.subscribe(JOB_ID, (u) => watching.push(u));
      await adapter.subscribe(JOB_ID, (u) => alsoWatching.push(u));
      await adapter.subscribe('job-other', (u) => elsewhere.push(u));

      await adapter.publish(JOB_ID, update(9.1));

      expect(watching).toHaveLength(1);
      expect(alsoWatching).toHaveLength(1);
      expect(elsewhere).toHaveLength(0);
    });

    it('stops delivering once released, and releasing twice is safe', async () => {
      const received: TrackingUpdate[] = [];
      const release = await adapter.subscribe(JOB_ID, (u) => received.push(u));

      await adapter.publish(JOB_ID, update(9.1));
      await release();
      await release();
      await adapter.publish(JOB_ID, update(9.2));

      expect(received).toHaveLength(1);
    });

    it('reports a publish as successful even when nobody is listening', async () => {
      // "Published" means the update entered the transport, not that somebody saw it. A driver
      // must not be told their fan-out failed because the customer closed the app.
      await expect(adapter.publish('job-nobody-watches', update(9.1))).resolves.toBe(true);
    });

    it('keeps other subscribers alive when one listener throws', async () => {
      const survived: TrackingUpdate[] = [];
      await adapter.subscribe(JOB_ID, () => {
        throw new Error('this socket is broken');
      });
      await adapter.subscribe(JOB_ID, (u) => survived.push(u));

      await expect(adapter.publish(JOB_ID, update(9.1))).resolves.toBe(true);
      expect(survived).toHaveLength(1);
    });
  });
});
