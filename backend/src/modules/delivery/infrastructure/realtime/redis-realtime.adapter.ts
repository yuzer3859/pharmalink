import { Injectable } from '@nestjs/common';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { RedisService } from '../../../../shared/redis/redis.service';
import {
  IRealtimePort,
  RealtimeUnsubscribe,
  TrackingUpdate,
} from '../../application/ports/outbound/realtime.port';

/**
 * `IRealtimePort` over Redis pub/sub (§7, §10's `WsRealtimeAdapter`).
 *
 * ## One channel per job, and why not one channel for everything
 *
 * The channel is `<prefix>:delivery:tracking:<jobId>`, which is §7's "publishes to a **Redis
 * pub/sub** channel keyed by `jobId`" taken literally. A single firehose channel with client-side
 * filtering would be less code and would not scale: every API node would receive every driver's
 * every fix and discard almost all of them, so the cross-node traffic would grow with
 * *drivers × nodes* rather than with the subscriptions that actually exist. Per-job channels mean
 * a node receives a position only when one of its own connected customers is watching that
 * delivery.
 *
 * The bookkeeping that requires — one `SUBSCRIBE` for the first local listener on a job, one
 * `UNSUBSCRIBE` when the last leaves — lives in `RedisService`, because it is a property of the
 * shared subscriber connection rather than of this module. Re-subscription after a Redis
 * reconnect lives there too, which is what stops a customer's socket from surviving a Redis blip
 * and then silently receiving nothing forever.
 *
 * ## Stateless nodes
 *
 * This is the whole point of the design's "any node can serve any client". A driver posting to
 * node A and their customer watching from node C is the *normal* case behind a load balancer, not
 * an edge one, and nothing anywhere pins the two halves of a delivery to one process. Every node
 * that has a listener for the job gets the message, including the publishing node itself — the
 * subscriber is a separate connection, so a same-node delivery takes the same round trip and
 * follows the same code path as a cross-node one. There is deliberately no local short-circuit:
 * it would make the common case in production the case that is never exercised in development.
 */
@Injectable()
export class RedisRealtimeAdapter implements IRealtimePort {
  constructor(
    private readonly redis: RedisService,
    private readonly logger: AppLogger,
  ) {
    this.logger.setContext(RedisRealtimeAdapter.name);
  }

  async publish(jobId: string, update: TrackingUpdate): Promise<boolean> {
    // `RedisService.publish` reports rather than throws, and that boolean is carried all the way
    // back to the driver's response: a fan-out that did not happen must not be described as one
    // that did.
    return this.redis.publish(this.channelFor(jobId), JSON.stringify(update));
  }

  async subscribe(
    jobId: string,
    listener: (update: TrackingUpdate) => void,
  ): Promise<RealtimeUnsubscribe> {
    return this.redis.subscribe(this.channelFor(jobId), (message) => {
      const update = parse(message);
      if (update === null) {
        // A message this version cannot read is dropped rather than propagated. Pub/sub outlives
        // a rolling deploy, so a payload written by the previous version is ordinary.
        this.logger.warn(`Discarded unreadable tracking message for job ${jobId}.`);
        return;
      }
      listener(update);
    });
  }

  private channelFor(jobId: string): string {
    return this.redis.key('delivery', 'tracking', jobId);
  }
}

/**
 * The same port with no Redis behind it — in-process fan-out for a single node.
 *
 * Used when `REDIS_URL` is unset, so a developer running the API alone gets working live tracking
 * without a container, and so the existing test suites keep booting unchanged. What it cannot do
 * is the one thing Redis is here for: a second node's subscribers are unreachable. That limit is
 * a property of the deployment, not a bug in this class, and it is why the cross-instance claim is
 * proved in an e2e test against real Redis rather than against this.
 */
@Injectable()
export class InMemoryRealtimeAdapter implements IRealtimePort {
  private readonly listeners = new Map<string, Set<(update: TrackingUpdate) => void>>();

  async publish(jobId: string, update: TrackingUpdate): Promise<boolean> {
    for (const listener of this.listeners.get(jobId) ?? []) {
      try {
        listener(update);
      } catch {
        // One failing socket must not stop the others watching the same delivery.
      }
    }
    // True regardless of listener count: "published" means the update entered the transport, not
    // that somebody was watching. Redis reports the same way, and a driver's app must not be told
    // its fan-out failed merely because the customer closed the app.
    return true;
  }

  async subscribe(
    jobId: string,
    listener: (update: TrackingUpdate) => void,
  ): Promise<RealtimeUnsubscribe> {
    let listeners = this.listeners.get(jobId);
    if (listeners === undefined) {
      listeners = new Set();
      this.listeners.set(jobId, listeners);
    }
    listeners.add(listener);

    let released = false;
    return async () => {
      if (released) {
        return;
      }
      released = true;
      const current = this.listeners.get(jobId);
      if (!current) {
        return;
      }
      current.delete(listener);
      if (current.size === 0) {
        // Dropped rather than left empty: the map is keyed by job and a long-lived process would
        // otherwise retain one empty Set per delivery it ever served.
        this.listeners.delete(jobId);
      }
    };
  }
}

function parse(message: string): TrackingUpdate | null {
  try {
    const parsed = JSON.parse(message) as Partial<TrackingUpdate>;
    if (
      typeof parsed.jobId !== 'string' ||
      typeof parsed.orderId !== 'string' ||
      typeof parsed.fulfillmentId !== 'string' ||
      typeof parsed.lat !== 'number' ||
      typeof parsed.lng !== 'number' ||
      typeof parsed.recordedAt !== 'string' ||
      typeof parsed.receivedAt !== 'string' ||
      typeof parsed.status !== 'string'
    ) {
      return null;
    }
    // `eta` is deliberately not required. A message published by a node running the previous
    // version carries no such field, and during a rolling deploy that is the normal case rather
    // than a corrupt payload — rejecting it would blank a customer's map for the length of the
    // rollout. Absent becomes `null`, which is what "no estimate" already means everywhere else.
    return { ...parsed, eta: parsed.eta ?? null } as TrackingUpdate;
  } catch {
    return null;
  }
}
