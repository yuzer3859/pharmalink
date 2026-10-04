import { IConfigPort } from '../../../shared/config/config.port';
import { AppLogger } from '../../../shared/logging/app-logger.service';
import { ErrorCode } from '../../../shared/errors/error-codes';
import { DeliveryJobProps } from '../domain/entities/delivery-job.entity';
import { DriverProfileProps } from '../domain/entities/driver-profile.entity';
import { DeliveryJobStatus, DriverAvailability } from '../domain/enums';
import { IDeliveryJobRepository } from '../domain/repositories/delivery-job.repository';
import { IDriverProfileRepository } from '../domain/repositories/driver-profile.repository';
import {
  RouteDestination,
  routeDestinationFor,
} from '../domain/services/tracking-policy';
import { GeoPoint } from '../domain/value-objects/geo-point.vo';
import { HaversineRoutingAdapter } from '../infrastructure/routing/haversine-routing.adapter';
import { CachedEta, IEtaCachePort } from './ports/outbound/eta-cache.port';
import { ILocationCachePort, CachedLocation } from './ports/outbound/location-cache.port';
import { IOrdersPort } from './ports/outbound/orders.port';
import { IRoutingPort, RouteRequest, RouteResult } from './ports/outbound/routing.port';
import { GetJobTrackingQuery } from './queries/get-job-tracking.query';
import { DeliveryAccessService } from './services/delivery-access.service';
import { EtaService } from './services/eta.service';

/**
 * ETA and route calculation (§3.4 F-TRK-02, §7, BR-DEL-05, NFR-PERF-04).
 *
 * `IRoutingPort` is a mock in almost every test here, which is the port's whole justification: the
 * rules that matter — which destination, how fresh a position has to be, when a cached route may
 * be reused, what happens when the provider falls over — are decided by this module and must be
 * testable without any map service at all. The one place the real adapter appears is the block
 * that checks its arithmetic, and even that performs no I/O.
 */

const DRIVER_USER = 'user-driver-1';
const DRIVER_PROFILE = 'profile-driver-1';
const OTHER_USER = 'user-driver-2';
const OTHER_PROFILE = 'profile-driver-2';
const CUSTOMER_USER = 'user-customer-1';
const STRANGER_USER = 'user-stranger';
const JOB_ID = 'job-1';
const ORDER_ID = 'order-1';

/** Bole, and a dropoff a few kilometres away in Kazanchis. */
const PICKUP = { lat: 9.03, lng: 38.74 };
const DROPOFF = { lat: 9.01, lng: 38.76 };
/** Where the driver is: near neither, so both legs have a real distance. */
const DRIVER_AT = { lat: 9.05, lng: 38.72 };

const seconds = (n: number) => new Date(Date.now() - n * 1_000);

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

class FakeEtaCache implements IEtaCachePort {
  entries = new Map<string, CachedEta>();
  async get(jobId: string, destination: RouteDestination): Promise<CachedEta | null> {
    return this.entries.get(`${jobId}:${destination}`) ?? null;
  }
  async set(jobId: string, destination: RouteDestination, entry: CachedEta): Promise<void> {
    this.entries.set(`${jobId}:${destination}`, entry);
  }
}

class FakeLocationCache implements ILocationCachePort {
  entries = new Map<string, CachedLocation>();
  async get(jobId: string): Promise<CachedLocation | null> {
    return this.entries.get(jobId) ?? null;
  }
  async set(jobId: string, location: CachedLocation): Promise<void> {
    this.entries.set(jobId, location);
  }
}

class FakeJobRepository implements Pick<IDeliveryJobRepository, 'findById' | 'findByOrderId'> {
  jobs = new Map<string, DeliveryJobProps>();
  async findById(id: string): Promise<DeliveryJobProps | null> {
    return this.jobs.get(id) ?? null;
  }
  async findByOrderId(orderId: string): Promise<DeliveryJobProps[]> {
    return [...this.jobs.values()].filter((j) => j.orderId === orderId);
  }
}

class FakeProfileRepository
  implements Pick<IDriverProfileRepository, 'findByUserId' | 'findById'>
{
  profiles = new Map<string, DriverProfileProps>();
  async findByUserId(userId: string): Promise<DriverProfileProps | null> {
    return [...this.profiles.values()].find((p) => p.userId === userId) ?? null;
  }
  async findById(id: string): Promise<DriverProfileProps | null> {
    return this.profiles.get(id) ?? null;
  }
}

class FakeOrdersPort implements Pick<IOrdersPort, 'getOrderCustomerUserId'> {
  owners = new Map<string, string>();
  async getOrderCustomerUserId(orderId: string): Promise<string | null> {
    return this.owners.get(orderId) ?? null;
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

function silentLogger(): AppLogger {
  return {
    setContext: () => undefined,
    warn: () => undefined,
    log: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  } as unknown as AppLogger;
}

describe('ETA and route calculation', () => {
  let routing: FakeRouting;
  let etaCache: FakeEtaCache;
  let locationCache: FakeLocationCache;
  let jobs: FakeJobRepository;
  let profiles: FakeProfileRepository;
  let orders: FakeOrdersPort;
  let config: FakeConfig;
  let eta: EtaService;
  let tracking: GetJobTrackingQuery;

  function job(overrides: Partial<DeliveryJobProps> = {}): DeliveryJobProps {
    return {
      id: JOB_ID,
      orderId: ORDER_ID,
      fulfillmentId: 'fulfillment-1',
      pharmacyId: 'pharmacy-1',
      branchId: 'branch-1',
      pickupPoint: GeoPoint.of(PICKUP.lat, PICKUP.lng),
      pickupAddress: 'Bole Branch',
      dropoffPoint: GeoPoint.of(DROPOFF.lat, DROPOFF.lng),
      dropoffAddress: 'Kazanchis',
      items: [],
      isColdChain: false,
      isCod: false,
      codAmount: null,
      deliveryFee: 0,
      distanceMeters: null,
      status: DeliveryJobStatus.ASSIGNED,
      assignedDriverId: DRIVER_PROFILE,
      pickedUpAt: null,
      deliveredAt: null,
      createdAt: seconds(3_600),
      updatedAt: seconds(60),
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
      lastLocation: GeoPoint.of(DRIVER_AT.lat, DRIVER_AT.lng),
      lastLocationAt: seconds(5),
      createdAt: seconds(7_200),
      updatedAt: seconds(5),
      ...overrides,
    };
  }

  const subject = (j: DeliveryJobProps) => ({
    jobId: j.id,
    status: j.status,
    pickupPoint: j.pickupPoint,
    dropoffPoint: j.dropoffPoint,
  });

  const origin = (agoSeconds = 5) => ({
    lat: DRIVER_AT.lat,
    lng: DRIVER_AT.lng,
    recordedAt: seconds(agoSeconds),
  });

  beforeEach(() => {
    routing = new FakeRouting();
    etaCache = new FakeEtaCache();
    locationCache = new FakeLocationCache();
    jobs = new FakeJobRepository();
    profiles = new FakeProfileRepository();
    orders = new FakeOrdersPort();
    config = new FakeConfig();

    jobs.jobs.set(JOB_ID, job());
    profiles.profiles.set(DRIVER_PROFILE, profile());
    profiles.profiles.set(OTHER_PROFILE, profile({ id: OTHER_PROFILE, userId: OTHER_USER }));
    orders.owners.set(ORDER_ID, CUSTOMER_USER);

    eta = new EtaService(routing, etaCache, config, silentLogger());
    tracking = new GetJobTrackingQuery(
      jobs as unknown as IDeliveryJobRepository,
      profiles as unknown as IDriverProfileRepository,
      locationCache,
      new DeliveryAccessService(
        profiles as unknown as IDriverProfileRepository,
        orders as unknown as IOrdersPort,
      ),
      eta,
    );
  });

  // -------------------------------------------------------------------------------------------
  // 1 & 2. The pickup boundary decides the destination
  // -------------------------------------------------------------------------------------------

  describe('destination', () => {
    it.each([DeliveryJobStatus.ASSIGNED, DeliveryJobStatus.ARRIVED_PICKUP])(
      'routes to the pharmacy while the job is %s',
      async (status) => {
        const result = await eta.estimate(subject(job({ status })), origin());

        expect(result?.destination).toBe(RouteDestination.Pickup);
        expect(routing.calls[0].destination).toMatchObject({
          lat: PICKUP.lat,
          lng: PICKUP.lng,
        });
      },
    );

    it.each([
      DeliveryJobStatus.PICKED_UP,
      DeliveryJobStatus.EN_ROUTE,
      DeliveryJobStatus.ARRIVED_DROPOFF,
    ])('routes to the customer once the job is %s', async (status) => {
      const result = await eta.estimate(subject(job({ status })), origin());

      expect(result?.destination).toBe(RouteDestination.Dropoff);
      expect(routing.calls[0].destination).toMatchObject({
        lat: DROPOFF.lat,
        lng: DROPOFF.lng,
      });
    });

    it('routes from the driver, not from the pharmacy', async () => {
      await eta.estimate(subject(job()), origin());
      expect(routing.calls[0].origin).toMatchObject({ lat: DRIVER_AT.lat, lng: DRIVER_AT.lng });
    });

    it('states the pickup boundary in exactly one place', () => {
      // Both callers ask this function; neither restates the rule. A status added to the state
      // machine without a destination here falls through to `None`, which is safe by default.
      expect(routeDestinationFor(DeliveryJobStatus.ARRIVED_PICKUP)).toBe(RouteDestination.Pickup);
      expect(routeDestinationFor(DeliveryJobStatus.PICKED_UP)).toBe(RouteDestination.Dropoff);
      expect(routeDestinationFor(DeliveryJobStatus.OFFERED)).toBe(RouteDestination.None);
    });

    it('gives no estimate when the destination coordinate is missing', async () => {
      // A soft-deleted branch leaves the job with a null pickup point — the job-creation work's
      // deliberate degradation. Not an error, just nothing to route to.
      const result = await eta.estimate(subject(job({ pickupPoint: null })), origin());

      expect(result).toBeNull();
      expect(routing.calls).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 4 & 8. States and staleness that must not produce an estimate
  // -------------------------------------------------------------------------------------------

  describe('when no estimate may be given', () => {
    it.each([
      DeliveryJobStatus.DELIVERED,
      DeliveryJobStatus.COMPLETED,
      DeliveryJobStatus.CANCELLED,
      DeliveryJobStatus.FAILED,
    ])('gives no estimate for a %s job', async (status) => {
      const result = await eta.estimate(subject(job({ status })), origin());

      // §4: an explicit unavailable, never an invented zero.
      expect(result).toBeNull();
      expect(routing.calls).toHaveLength(0);
    });

    it.each([
      DeliveryJobStatus.CREATED,
      DeliveryJobStatus.OFFERED,
      DeliveryJobStatus.REASSIGNING,
    ])('gives no estimate for a %s job, which nobody is carrying', async (status) => {
      expect(await eta.estimate(subject(job({ status })), origin())).toBeNull();
    });

    it('gives no estimate when the driver has never reported a position', async () => {
      expect(await eta.estimate(subject(job()), null)).toBeNull();
      expect(routing.calls).toHaveLength(0);
    });

    it('gives no estimate from a position older than the configured limit', async () => {
      config.values.set('delivery.etaMaxLocationAgeSeconds', 60);

      const result = await eta.estimate(subject(job()), origin(600));

      // §8: a ten-minute-old fix is arithmetic on a place the driver has left, not an estimate.
      expect(result).toBeNull();
      expect(routing.calls).toHaveLength(0);
    });

    it('still gives an estimate from a position inside the limit', async () => {
      config.values.set('delivery.etaMaxLocationAgeSeconds', 60);
      expect(await eta.estimate(subject(job()), origin(30))).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------------------------
  // 5. What a route produces
  // -------------------------------------------------------------------------------------------

  describe('the estimate itself', () => {
    it('carries distance, duration and an absolute arrival time', async () => {
      routing.result = { distanceMeters: 3_300, durationSeconds: 540 };
      const now = new Date();

      const result = await eta.estimate(subject(job()), origin(), now);

      expect(result).toMatchObject({
        destination: RouteDestination.Pickup,
        distanceMeters: 3_300,
        durationSeconds: 540,
      });
      expect(result?.expectedArrivalAt.getTime()).toBe(now.getTime() + 540_000);
    });

    it('rounds to whole metres and seconds', async () => {
      routing.result = { distanceMeters: 1_234.56, durationSeconds: 78.9 };
      const result = await eta.estimate(subject(job()), origin());

      expect(result?.distanceMeters).toBe(1_235);
      expect(result?.durationSeconds).toBe(79);
    });

    it('exposes nothing beyond the four agreed fields', async () => {
      const result = await eta.estimate(subject(job()), origin());

      // §17: no provider id, no polyline, no raw response, no leg breakdown. `RouteResult`
      // normalises every vendor to a distance and a duration before it reaches here.
      expect(Object.keys(result ?? {}).sort()).toEqual([
        'destination',
        'distanceMeters',
        'durationSeconds',
        'expectedArrivalAt',
      ]);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 6, 7, 18. Routing failure
  // -------------------------------------------------------------------------------------------

  describe('when routing fails', () => {
    it('reports no estimate when the provider returns none', async () => {
      routing.result = null;
      expect(await eta.estimate(subject(job()), origin())).toBeNull();
    });

    it('reports no estimate when the provider throws, rather than propagating', async () => {
      // `IRoutingPort` says implementations must not throw. The eventual implementation will be
      // somebody's HTTP client, so the service guards instead of trusting the contract — a socket
      // hang-up inside it must not reach the live fan-out.
      routing.throws = true;
      await expect(eta.estimate(subject(job()), origin())).resolves.toBeNull();
    });

    it('leaves tracking fully working — position, status and flags intact', async () => {
      routing.throws = true;

      const { view } = await tracking.byJobId(JOB_ID, CUSTOMER_USER);

      expect(view.eta).toBeNull();
      expect(view.location).toMatchObject({ lat: DRIVER_AT.lat, lng: DRIVER_AT.lng });
      expect(view.status).toBe(DeliveryJobStatus.ASSIGNED);
      expect(view.isLive).toBe(true);
    });

    it('changes no delivery job state', async () => {
      routing.throws = true;
      const before = { ...jobs.jobs.get(JOB_ID)! };

      await tracking.byJobId(JOB_ID, CUSTOMER_USER);

      // §9, structurally: the service has no repository, no unit of work and no aggregate — there
      // is no path by which a failing map service could move a job to FAILED.
      expect(jobs.jobs.get(JOB_ID)).toEqual(before);
      expect(EtaService.length).toBe(4);
    });

    it('caches nothing it could not compute', async () => {
      routing.result = null;
      await eta.estimate(subject(job()), origin());
      expect(etaCache.entries.size).toBe(0);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 11–14. Caching
  // -------------------------------------------------------------------------------------------

  describe('caching', () => {
    it('reuses a recent route for an unmoved driver instead of calling the provider', async () => {
      await eta.estimate(subject(job()), origin());
      const second = await eta.estimate(subject(job()), origin());

      expect(routing.calls).toHaveLength(1);
      expect(second).not.toBeNull();
    });

    it('keeps a reused arrival time counting down rather than resetting it', async () => {
      const start = new Date();
      routing.result = { distanceMeters: 3_000, durationSeconds: 600 };

      const first = await eta.estimate(subject(job()), origin(), start);
      const later = new Date(start.getTime() + 20_000);
      const second = await eta.estimate(subject(job()), origin(), later);

      // Same absolute arrival, so a customer sees 10:00 then 9:40 — not 10:00 twice.
      expect(second?.expectedArrivalAt.getTime()).toBe(first?.expectedArrivalAt.getTime());
    });

    it('recalculates once the cached route has expired', async () => {
      config.values.set('delivery.etaCacheTtlSeconds', 30);
      const start = new Date();

      await eta.estimate(subject(job()), origin(), start);
      await eta.estimate(subject(job()), origin(), new Date(start.getTime() + 45_000));

      expect(routing.calls).toHaveLength(2);
    });

    it('recalculates once the driver has moved materially', async () => {
      config.values.set('delivery.etaRecalculateAfterMeters', 100);

      await eta.estimate(subject(job()), origin());
      // Roughly 1.1 km north — well past the threshold.
      await eta.estimate(subject(job()), {
        lat: DRIVER_AT.lat + 0.01,
        lng: DRIVER_AT.lng,
        recordedAt: seconds(1),
      });

      expect(routing.calls).toHaveLength(2);
    });

    it('does not recalculate for GPS jitter below the threshold', async () => {
      config.values.set('delivery.etaRecalculateAfterMeters', 150);

      await eta.estimate(subject(job()), origin());
      // About 11 metres — a stationary handset wandering.
      await eta.estimate(subject(job()), {
        lat: DRIVER_AT.lat + 0.0001,
        lng: DRIVER_AT.lng,
        recordedAt: seconds(1),
      });

      expect(routing.calls).toHaveLength(1);
    });

    it('keeps pickup and dropoff estimates in separate cache entries', async () => {
      await eta.estimate(subject(job({ status: DeliveryJobStatus.ASSIGNED })), origin());
      await eta.estimate(subject(job({ status: DeliveryJobStatus.PICKED_UP })), origin());

      expect([...etaCache.entries.keys()].sort()).toEqual([
        `${JOB_ID}:${RouteDestination.Dropoff}`,
        `${JOB_ID}:${RouteDestination.Pickup}`,
      ]);
      expect(routing.calls).toHaveLength(2);
    });

    it('never serves a pickup estimate as a dropoff one across the boundary', async () => {
      routing.result = { distanceMeters: 100, durationSeconds: 30 };
      const beforePickup = await eta.estimate(
        subject(job({ status: DeliveryJobStatus.ASSIGNED })),
        origin(),
      );

      routing.result = { distanceMeters: 9_000, durationSeconds: 1_500 };
      const afterPickup = await eta.estimate(
        subject(job({ status: DeliveryJobStatus.PICKED_UP })),
        origin(),
      );

      // The transition changes the key, so the two-minute pickup estimate is unreachable rather
      // than merely ignored.
      expect(beforePickup?.durationSeconds).toBe(30);
      expect(afterPickup?.durationSeconds).toBe(1_500);
    });

    it('does not let one job read another job’s cached route', async () => {
      await eta.estimate(subject(job()), origin());
      await eta.estimate(subject(job({ id: 'job-2' })), origin());

      expect(routing.calls).toHaveLength(2);
    });

    it('recomputes rather than failing when the cache is unreadable', async () => {
      await eta.estimate(subject(job()), origin());
      etaCache.get = async () => {
        throw new Error('cache down');
      };

      // A cache miss and a cache failure must reach the same place: recompute. A store that threw
      // into the live fan-out would turn a caching problem into a customer losing their map.
      const result = await eta.estimate(subject(job()), origin());

      expect(result).not.toBeNull();
      expect(routing.calls).toHaveLength(2);
    });

    it('still answers when the cache cannot be written', async () => {
      etaCache.set = async () => {
        throw new Error('cache down');
      };

      await expect(eta.estimate(subject(job()), origin())).resolves.not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------------------------
  // 3, 9, 10. Through the tracking query — position source and authorization
  // -------------------------------------------------------------------------------------------

  describe('through the tracking query', () => {
    it('includes the estimate beside the position', async () => {
      routing.result = { distanceMeters: 2_500, durationSeconds: 420 };

      const { view } = await tracking.byJobId(JOB_ID, CUSTOMER_USER);

      expect(view.eta).toMatchObject({
        destination: RouteDestination.Pickup,
        distanceMeters: 2_500,
        durationSeconds: 420,
      });
    });

    it('computes from the hot cache position when it is newer than the durable one', async () => {
      // §2/§13: the authoritative position the tracking layer resolved, never a caller's input.
      locationCache.entries.set(JOB_ID, {
        lat: 9.2,
        lng: 38.9,
        recordedAt: seconds(1),
        driverId: DRIVER_PROFILE,
      });

      await tracking.byJobId(JOB_ID, CUSTOMER_USER);

      expect(routing.calls[0].origin).toMatchObject({ lat: 9.2, lng: 38.9 });
    });

    it('falls back to the durable position when the hot cache is empty', async () => {
      await tracking.byJobId(JOB_ID, CUSTOMER_USER);
      expect(routing.calls[0].origin).toMatchObject({
        lat: DRIVER_AT.lat,
        lng: DRIVER_AT.lng,
      });
    });

    it('takes no coordinates from the caller at all', async () => {
      // The only inputs are two ids. There is no parameter through which a client could supply a
      // position to be routed from.
      expect(GetJobTrackingQuery.prototype.byJobId.length).toBe(2);
      expect(GetJobTrackingQuery.prototype.byOrderId.length).toBe(2);
    });

    it('gives an unauthorized customer no estimate, and no answer at all', async () => {
      await expect(tracking.byJobId(JOB_ID, STRANGER_USER)).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
      expect(routing.calls).toHaveLength(0);
    });

    it("gives a driver no estimate for another driver's delivery", async () => {
      await expect(tracking.byJobId(JOB_ID, OTHER_USER)).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
      expect(routing.calls).toHaveLength(0);
    });

    it('gives the assigned driver the estimate for their own delivery', async () => {
      const { view } = await tracking.byJobId(JOB_ID, DRIVER_USER);
      expect(view.eta).not.toBeNull();
    });

    it('gives no estimate for a finished delivery even to its owner', async () => {
      jobs.jobs.set(
        JOB_ID,
        job({ status: DeliveryJobStatus.DELIVERED, deliveredAt: seconds(60) }),
      );

      const { view } = await tracking.byJobId(JOB_ID, CUSTOMER_USER);

      expect(view.eta).toBeNull();
      expect(view.isFinished).toBe(true);
      expect(view.location).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------------------------
  // The deterministic adapter's own arithmetic
  // -------------------------------------------------------------------------------------------

  describe('the deterministic routing adapter', () => {
    const adapter = new HaversineRoutingAdapter();

    it('produces a road distance longer than the straight line', async () => {
      const route = await adapter.route({
        origin: GeoPoint.of(DRIVER_AT.lat, DRIVER_AT.lng),
        destination: GeoPoint.of(DROPOFF.lat, DROPOFF.lng),
      });

      // Roughly 5 km apart as the crow flies; the winding factor puts the road distance above it.
      expect(route!.distanceMeters).toBeGreaterThan(5_000);
      expect(route!.durationSeconds).toBeGreaterThan(0);
    });

    it('is deterministic, so a test never depends on a third party being up', async () => {
      const request = {
        origin: GeoPoint.of(DRIVER_AT.lat, DRIVER_AT.lng),
        destination: GeoPoint.of(PICKUP.lat, PICKUP.lng),
      };
      expect(await adapter.route(request)).toEqual(await adapter.route(request));
    });

    it('reports zero for a driver who is already there', async () => {
      const route = await adapter.route({
        origin: GeoPoint.of(PICKUP.lat, PICKUP.lng),
        destination: GeoPoint.of(PICKUP.lat, PICKUP.lng),
      });

      // A permanent one-minute countdown for a driver standing at the door would be worse than
      // saying nothing.
      expect(route).toEqual({ distanceMeters: 0, durationSeconds: 0 });
    });

    it('scales duration with distance', async () => {
      const near = await adapter.route({
        origin: GeoPoint.of(9.03, 38.74),
        destination: GeoPoint.of(9.04, 38.74),
      });
      const far = await adapter.route({
        origin: GeoPoint.of(9.03, 38.74),
        destination: GeoPoint.of(9.13, 38.74),
      });

      expect(far!.durationSeconds).toBeGreaterThan(near!.durationSeconds * 5);
    });
  });
});
