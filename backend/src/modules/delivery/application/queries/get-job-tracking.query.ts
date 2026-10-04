import { Inject, Injectable } from '@nestjs/common';
import { DeliveryJobProps } from '../../domain/entities/delivery-job.entity';
import { DeliveryJobStatus } from '../../domain/enums';
import { DeliveryErrors } from '../../domain/errors';
import {
  DELIVERY_JOB_REPOSITORY,
  IDeliveryJobRepository,
} from '../../domain/repositories/delivery-job.repository';
import {
  DRIVER_PROFILE_REPOSITORY,
  IDriverProfileRepository,
} from '../../domain/repositories/driver-profile.repository';
import { isTerminalForTracking, isTrackableStatus } from '../../domain/services/tracking-policy';
import {
  ILocationCachePort,
  LOCATION_CACHE_PORT,
} from '../ports/outbound/location-cache.port';
import { DeliveryAccessService, DeliveryViewer } from '../services/delivery-access.service';
import { EtaService, EtaView } from '../services/eta.service';

/**
 * Which party a tracking request was authorized as.
 *
 * An alias rather than a second enum. The decision itself moved to `DeliveryAccessService` when
 * the proof-of-delivery read needed the same one, and re-exporting the name keeps every existing
 * caller — the gateway, the controller, the tracking suites — reading naturally while there
 * remains exactly one set of values that a delivery viewer can be.
 */
export { DeliveryViewer as TrackingViewer } from '../services/delivery-access.service';

/**
 * The complete tracking picture a subscriber is given, on subscribe and over HTTP.
 *
 * Field-for-field the same shape the live stream carries, plus the two flags a client needs to
 * decide what to render when there is nothing moving. Nothing about the driver, the pharmacy, the
 * order contents or the money — see `TrackingUpdate`, which states that boundary at length.
 */
export interface JobTrackingView {
  jobId: string;
  orderId: string;
  fulfillmentId: string;
  status: DeliveryJobStatus;
  /** `null` when no position has been recorded yet. The subscription still succeeds (§6). */
  location: { lat: number; lng: number; recordedAt: Date } | null;
  /** Whether this job is currently in a state that produces position updates. */
  isLive: boolean;
  /** Whether it is finished, so a client can stop waiting rather than show a stalled map. */
  isFinished: boolean;
  /**
   * The arrival estimate, or `null` when there is not one worth giving (§4, §8, §9).
   *
   * `null` covers every unavailable case with one value — finished job, no position, position too
   * old, routing provider down — and that is deliberate rather than lazy. Naming the reason on the
   * wire would amount to a customer-visible "we have lost the driver" state, which both the
   * tracking work and §8 of this one decline to invent; `status`, `isLive`, `isFinished` and the
   * age of `location.recordedAt` already let a client say something true without the platform
   * asserting something it does not know.
   */
  eta: EtaView | null;
}

export interface JobTrackingAccess {
  view: JobTrackingView;
  viewer: DeliveryViewer;
}

/**
 * `GetJobTracking` (§3.4 F-TRK-03, §9.4, BR-DEL-05) — the authorized read of a delivery's
 * last-known position, and the **single** authorization decision for tracking.
 *
 * ## One place, three callers
 *
 * The WebSocket subscribe handler, the WebSocket reconnect path and the HTTP fallback all route
 * through this query. That is the point of it: §12 says not to build a second tracking system, and
 * the way two tracking systems actually come about is two authorization checks that start
 * identical and drift. A customer who may not subscribe over a socket must not be able to poll the
 * same coordinates over HTTP, and the only durable way to guarantee that is for there to be one
 * function that decides.
 *
 * ## Who may see a delivery
 *
 * `DeliveryAccessService` decides, and this query does not second-guess it: the customer who owns
 * the order (proved by asking Module 06, never asserted by the caller) or the driver currently
 * carrying it (proved by matching `driver_profiles.id` against `assignedDriverId`). Everybody else
 * gets `NOT_FOUND` rather than `FORBIDDEN`.
 *
 * That decision used to live here, inline, and moved out when the proof-of-delivery read needed
 * the same one. The move is the point rather than tidiness: two reads of the same delivery that
 * each carried their own copy of the rule would be two authorization paths, and §12's warning
 * against those is a warning against exactly the drift that follows — one read gaining a party the
 * other never hears about, or losing a check nobody notices.
 *
 * ## Where the position comes from
 *
 * The durable Delivery-owned state — `driver_profiles.last_lat/last_lng/last_location_at` of the
 * job's current driver — with the hot cache consulted first as an accelerator. The two cannot
 * disagree about anything but recency: both are written from the same accepted fix, the durable
 * one is monotonic, and the cache is only ever *ahead* by the fixes the write throttle coalesced.
 * A cache entry belonging to a previous driver is discarded rather than served, so a reassignment
 * cannot show a customer the position of somebody who is no longer carrying their order.
 *
 * A job with no driver, or a driver who has not reported yet, yields `location: null`. That is a
 * successful answer and not an error: §6 requires the subscription to succeed and say that no
 * position is available, because a customer whose driver has not switched on their phone yet is
 * in a perfectly ordinary situation.
 *
 * ## And the ETA alongside it
 *
 * The arrival estimate is attached here, from the position this query has just resolved, through
 * the one `EtaService` the live fan-out also uses. Being computed at this point rather than
 * anywhere downstream has two consequences worth stating. It inherits the authorization decision
 * made above, so there is no path by which an ETA reaches somebody who may not see the delivery;
 * and it inherits the *position*, so an estimate can never be calculated from coordinates a client
 * supplied — the only thing a caller provides is an id.
 *
 * An absent estimate never degrades the rest of the answer. A routing provider being unreachable
 * yields `eta: null` beside a perfectly good `location`, which is §9's requirement that tracking
 * keeps working when the map does not.
 */
@Injectable()
export class GetJobTrackingQuery {
  constructor(
    @Inject(DELIVERY_JOB_REPOSITORY) private readonly jobs: IDeliveryJobRepository,
    @Inject(DRIVER_PROFILE_REPOSITORY) private readonly profiles: IDriverProfileRepository,
    @Inject(LOCATION_CACHE_PORT) private readonly cache: ILocationCachePort,
    private readonly access: DeliveryAccessService,
    private readonly eta: EtaService,
  ) {}

  /** Tracking for one delivery job, authorized for the given authenticated user. */
  async byJobId(jobId: string, userId: string): Promise<JobTrackingAccess> {
    const job = await this.jobs.findById(requireText(jobId, 'jobId'));
    if (!job) {
      throw notFound(jobId);
    }
    return this.authorize(job, requireText(userId, 'userId'), jobId);
  }

  /**
   * Tracking for an order, which is what §9.4's customer-facing channel is keyed by.
   *
   * An order that split across pharmacies has one job per fulfillment (§5.3), so this returns the
   * one the customer should be watching: the live leg if there is one, otherwise the most
   * recently created. A client that needs to follow both legs subscribes to each job — every view
   * carries its own `fulfillmentId` for exactly that.
   */
  async byOrderId(orderId: string, userId: string): Promise<JobTrackingAccess> {
    const id = requireText(orderId, 'orderId');
    const jobs = await this.jobs.findByOrderId(id);
    if (jobs.length === 0) {
      throw notFound(id);
    }
    const live = jobs.filter((job) => isTrackableStatus(job.status));
    const chosen = (live.length > 0 ? live : jobs).reduce((newest, job) =>
      job.createdAt.getTime() >= newest.createdAt.getTime() ? job : newest,
    );
    return this.authorize(chosen, requireText(userId, 'userId'), id);
  }

  private async authorize(
    job: DeliveryJobProps,
    userId: string,
    requestedId: string,
  ): Promise<JobTrackingAccess> {
    // Throws `NOT_FOUND` for anybody who is neither the buyer nor the assigned driver. Nothing is
    // read, computed or routed before this returns.
    const viewer = await this.access.resolve(job, userId, requestedId);
    return { view: await this.toView(job), viewer };
  }

  private async toView(job: DeliveryJobProps): Promise<JobTrackingView> {
    const location = await this.lastKnown(job.id, job.assignedDriverId);
    return {
      jobId: job.id,
      orderId: job.orderId,
      fulfillmentId: job.fulfillmentId,
      status: job.status,
      location,
      isLive: isTrackableStatus(job.status),
      isFinished: isTerminalForTracking(job.status),
      // Computed from the position resolved immediately above — the authoritative one this query
      // already established — rather than from anything the caller supplied (§2, §13). The service
      // decides for itself whether that position is fresh enough to support an estimate.
      eta: await this.eta.estimate(
        {
          jobId: job.id,
          status: job.status,
          pickupPoint: job.pickupPoint,
          dropoffPoint: job.dropoffPoint,
        },
        location,
      ),
    };
  }

  private async lastKnown(
    jobId: string,
    driverId: string | null,
  ): Promise<JobTrackingView['location']> {
    if (driverId === null) {
      // Nobody is carrying it, so there is no position to report — and any cache entry belongs to
      // a driver who has been released from the job.
      return null;
    }

    const cached = await this.cache.get(jobId);
    if (cached !== null && cached.driverId === driverId) {
      return { lat: cached.lat, lng: cached.lng, recordedAt: cached.recordedAt };
    }

    const profile = await this.profiles.findById(driverId);
    if (!profile || profile.lastLocation === null || profile.lastLocationAt === null) {
      return null;
    }
    return {
      lat: profile.lastLocation.lat,
      lng: profile.lastLocation.lng,
      recordedAt: profile.lastLocationAt,
    };
  }
}

/** The one answer an unauthorized or absent subject ever gets. See the class comment. */
function notFound(id: string) {
  return DeliveryErrors.notFound('Delivery job not found.', { id });
}

function requireText(value: string, field: string): string {
  const text = (value ?? '').trim();
  if (!text) {
    throw DeliveryErrors.validation(`${field} is required.`, { field });
  }
  return text;
}
