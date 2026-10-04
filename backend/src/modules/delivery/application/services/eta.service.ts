import { Inject, Injectable } from '@nestjs/common';
import { CONFIG_PORT, IConfigPort } from '../../../../shared/config/config.port';
import {
  DEFAULT_DELIVERY_ETA_CACHE_TTL_SECONDS,
  DEFAULT_DELIVERY_ETA_MAX_LOCATION_AGE_SECONDS,
  DEFAULT_DELIVERY_ETA_RECALCULATE_AFTER_METERS,
} from '../../../../shared/config/delivery.config';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { DeliveryJobStatus } from '../../domain/enums';
import { haversineMeters } from '../../domain/services/dispatch-policy';
import { RouteDestination, routeDestinationFor } from '../../domain/services/tracking-policy';
import { GeoPoint } from '../../domain/value-objects/geo-point.vo';
import { ETA_CACHE_PORT, IEtaCachePort } from '../ports/outbound/eta-cache.port';
import { IRoutingPort, ROUTING_PORT } from '../ports/outbound/routing.port';

/** Dotted config keys. */
export const ETA_CACHE_TTL_CONFIG_KEY = 'delivery.etaCacheTtlSeconds';
export const ETA_RECALCULATE_AFTER_METERS_CONFIG_KEY = 'delivery.etaRecalculateAfterMeters';
export const ETA_MAX_LOCATION_AGE_CONFIG_KEY = 'delivery.etaMaxLocationAgeSeconds';

/** An arrival estimate, as every surface reports it. */
export interface EtaView {
  /** Which leg this estimates — the pharmacy before pickup, the customer's door after it. */
  destination: RouteDestination.Pickup | RouteDestination.Dropoff;
  /** Road distance still to travel, in metres. */
  distanceMeters: number;
  /** Remaining travel time in seconds, as calculated. */
  durationSeconds: number;
  /**
   * When the driver is expected to arrive.
   *
   * Absolute, and anchored to the moment the route was calculated rather than to the moment it was
   * read. A cached estimate re-derived as `now + duration` would restart its own countdown on
   * every read, leaving a customer looking at "9 minutes" indefinitely; anchored, a reused entry
   * counts down correctly and a client can render either the timestamp or the remainder.
   */
  expectedArrivalAt: Date;
}

/** What a job needs to expose for an ETA. Deliberately the fields, not the aggregate. */
export interface EtaSubject {
  jobId: string;
  status: DeliveryJobStatus;
  pickupPoint: GeoPoint | null;
  dropoffPoint: GeoPoint | null;
}

/** The driver's position, as the tracking layer already resolved it. */
export interface EtaOrigin {
  lat: number;
  lng: number;
  recordedAt: Date;
}

/**
 * `EtaService` (§3.4 F-TRK-02, §7, BR-DEL-05, NFR-PERF-04) — **the** arrival-estimate calculation
 * for this module.
 *
 * ## One implementation, both surfaces
 *
 * The WebSocket fan-out and the snapshot read — which is itself shared by socket subscribe and the
 * REST fallback — call this and nothing else. §7 asks for exactly that, and the reason is the same
 * one that put authorization in a single query: two ETA implementations would begin identical and
 * drift, and the symptom would be a customer whose live map and whose refresh disagreed about when
 * their medicines were arriving. There is one function; it is called from two places.
 *
 * ## What it will not do
 *
 * It returns `null` — no estimate — rather than a number it cannot stand behind. Four things
 * produce that, and each is a case where a confident answer would be worse than none:
 *
 *  1. **The job is not on a journey.** `routeDestinationFor` says `NONE` for everything that is
 *     not between `ASSIGNED` and `ARRIVED_DROPOFF`. §4 asks for an explicit unavailable rather
 *     than an invented zero, and a delivered order with "arriving in 0 minutes" is precisely the
 *     invented zero it means.
 *  2. **There is no position, or no destination coordinate.** A job whose branch was soft-deleted
 *     carries a null pickup point (the job-creation work's deliberate degradation), and a driver
 *     who has not switched their handset on has no origin. Neither is an error.
 *  3. **The position is too old to trust** — see `etaMaxLocationAgeSeconds`. This is the one that
 *     NFR-LOC-04 guarantees will happen in the field.
 *  4. **Routing failed.** The provider is down, the points are unroutable. §9: tracking keeps
 *     working, the position is still returned, the ETA is simply absent, and nothing about the
 *     delivery job changes.
 *
 * ## Nothing here touches delivery state
 *
 * No repository, no transaction, no outbox, no aggregate mutation — the collaborators are a
 * routing port, a cache port, config and a logger. §14 asks for routing to stay outside the
 * `DeliveryJob` aggregate, and this is where that is enforced: a routing provider having a bad day
 * is structurally incapable of moving a job to `FAILED`, because nothing on this path can write a
 * job at all.
 */
@Injectable()
export class EtaService {
  constructor(
    @Inject(ROUTING_PORT) private readonly routing: IRoutingPort,
    @Inject(ETA_CACHE_PORT) private readonly cache: IEtaCachePort,
    @Inject(CONFIG_PORT) private readonly config: IConfigPort,
    private readonly logger: AppLogger,
  ) {
    this.logger.setContext(EtaService.name);
  }

  /**
   * The arrival estimate for a job given the driver's latest known position, or `null`.
   *
   * `origin` is supplied by the caller rather than read here, and that is deliberate: both callers
   * have *already* resolved the authoritative position — the tracking query from the hot cache
   * falling back to `driver_profiles`, the publish command from the fix it has just validated and
   * accepted. Re-reading it would be a second source of truth for the same fact, and the two could
   * differ by a fix. §2 and §13's "use the most recent durable location" and "do not calculate ETA
   * from stale client-supplied coordinates" are satisfied upstream, at the one place that knows
   * how to establish a position, and this service is never handed anything a client sent.
   */
  async estimate(job: EtaSubject, origin: EtaOrigin | null, now = new Date()): Promise<EtaView | null> {
    const destination = routeDestinationFor(job.status);
    if (destination === RouteDestination.None) {
      return null;
    }

    const target =
      destination === RouteDestination.Pickup ? job.pickupPoint : job.dropoffPoint;
    if (target === null || origin === null) {
      return null;
    }

    if (this.isStale(origin.recordedAt, now)) {
      // §8. The position is still reported by the caller; only the estimate is withheld.
      return null;
    }

    const from = GeoPoint.of(origin.lat, origin.lng);

    const reusable = await this.reusable(job.jobId, destination, from, now);
    if (reusable) {
      return this.toView(destination, reusable.distanceMeters, reusable.durationSeconds, reusable.computedAt);
    }

    const route = await this.calculate(from, target);
    if (route === null) {
      return null;
    }

    await this.remember(job.jobId, destination, from, route, now);
    return this.toView(destination, route.distanceMeters, route.durationSeconds, now);
  }

  /**
   * A cached route that is still safe to serve, or `null`.
   *
   * Both halves have to hold: recent enough in time, and computed from close enough to where the
   * driver is now. Either alone is a trap — a TTL-only cache serves a two-kilometre-old route to a
   * driver who has been riding, and a distance-only cache freezes a stationary driver's estimate
   * for as long as they stand still while the traffic around them changes.
   */
  private async reusable(
    jobId: string,
    destination: RouteDestination.Pickup | RouteDestination.Dropoff,
    from: GeoPoint,
    now: Date,
  ) {
    const cached = await this.read(jobId, destination);
    if (cached === null) {
      return null;
    }

    const ageMs = now.getTime() - cached.computedAt.getTime();
    if (ageMs < 0 || ageMs > this.cacheTtlSeconds() * 1_000) {
      return null;
    }

    const moved = haversineMeters(from, GeoPoint.of(cached.originLat, cached.originLng));
    return moved <= this.recalculateAfterMeters() ? cached : null;
  }

  /**
   * The cache read, wrapped.
   *
   * Guarded for the same reason the routing call below is: a cache is never load-bearing here, so
   * every way it can fail has to arrive at the same place a miss does — recompute. An unreachable
   * Redis already answers `null` rather than throwing, but this path runs inside the live fan-out,
   * and a store that threw would turn a caching problem into a customer losing their map (§9).
   */
  private async read(
    jobId: string,
    destination: RouteDestination.Pickup | RouteDestination.Dropoff,
  ) {
    try {
      return await this.cache.get(jobId, destination);
    } catch (err) {
      this.logger.warn(`Failed to read a cached ETA for job ${jobId}: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * The routing call, wrapped.
   *
   * `IRoutingPort` says outright that implementations must answer `null` rather than throw, and
   * this catches anyway. That is not belt-and-braces: the implementation that eventually replaces
   * the deterministic adapter will be somebody's HTTP client, and a socket hang-up or a JSON parse
   * error inside it would otherwise escape into the live fan-out and take down a customer's
   * tracking connection over a map service being slow. §9's "WebSocket connection must remain
   * healthy" is enforced here rather than hoped for.
   */
  private async calculate(origin: GeoPoint, destination: GeoPoint) {
    try {
      return await this.routing.route({ origin, destination });
    } catch (err) {
      this.logger.warn(`Routing provider failed, ETA unavailable: ${(err as Error).message}`);
      return null;
    }
  }

  /** Storing a route must never be able to fail the request that computed it. */
  private async remember(
    jobId: string,
    destination: RouteDestination.Pickup | RouteDestination.Dropoff,
    from: GeoPoint,
    route: { distanceMeters: number; durationSeconds: number },
    now: Date,
  ): Promise<void> {
    try {
      await this.cache.set(jobId, destination, {
        originLat: from.lat,
        originLng: from.lng,
        distanceMeters: route.distanceMeters,
        durationSeconds: route.durationSeconds,
        computedAt: now,
      });
    } catch (err) {
      this.logger.warn(`Failed to cache an ETA for job ${jobId}: ${(err as Error).message}`);
    }
  }

  private toView(
    destination: RouteDestination.Pickup | RouteDestination.Dropoff,
    distanceMeters: number,
    durationSeconds: number,
    computedAt: Date,
  ): EtaView {
    return {
      destination,
      distanceMeters: Math.round(distanceMeters),
      durationSeconds: Math.round(durationSeconds),
      expectedArrivalAt: new Date(computedAt.getTime() + Math.round(durationSeconds) * 1_000),
    };
  }

  private isStale(recordedAt: Date, now: Date): boolean {
    return now.getTime() - recordedAt.getTime() > this.maxLocationAgeSeconds() * 1_000;
  }

  private cacheTtlSeconds(): number {
    return this.positiveInt(ETA_CACHE_TTL_CONFIG_KEY, DEFAULT_DELIVERY_ETA_CACHE_TTL_SECONDS);
  }

  private recalculateAfterMeters(): number {
    return this.positiveInt(
      ETA_RECALCULATE_AFTER_METERS_CONFIG_KEY,
      DEFAULT_DELIVERY_ETA_RECALCULATE_AFTER_METERS,
    );
  }

  private maxLocationAgeSeconds(): number {
    return this.positiveInt(
      ETA_MAX_LOCATION_AGE_CONFIG_KEY,
      DEFAULT_DELIVERY_ETA_MAX_LOCATION_AGE_SECONDS,
    );
  }

  private positiveInt(key: string, fallback: number): number {
    const configured = this.config.get<number>(key);
    return typeof configured === 'number' && Number.isInteger(configured) && configured > 0
      ? configured
      : fallback;
  }
}
