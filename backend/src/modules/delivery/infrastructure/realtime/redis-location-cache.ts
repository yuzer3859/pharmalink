import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../../../shared/config/app-config.service';
import { DEFAULT_DELIVERY_LOCATION_CACHE_TTL_SECONDS } from '../../../../shared/config/delivery.config';
import { RedisService } from '../../../../shared/redis/redis.service';
import {
  CachedLocation,
  ILocationCachePort,
} from '../../application/ports/outbound/location-cache.port';

/** The dotted config key backing the hot entry's TTL. */
export const LOCATION_CACHE_TTL_CONFIG_KEY = 'delivery.locationCacheTtlSeconds';

/**
 * How many jobs the in-process fallback will hold before it starts evicting.
 *
 * A cap rather than an unbounded map because this runs in an API process that is expected to stay
 * up for weeks: without one, a long-lived node would accumulate an entry per job it ever saw. Two
 * thousand concurrent deliveries is far past the point at which an operator should have configured
 * Redis, and the eviction is harmless anyway — a miss costs one Postgres read.
 */
const IN_MEMORY_CAPACITY = 2_000;

/** The wire shape. Written explicitly so a change to `CachedLocation` cannot silently alter it. */
interface CachedLocationJson {
  lat: number;
  lng: number;
  recordedAt: string;
  driverId: string;
}

/**
 * `ILocationCachePort` over the shared Redis connection (§7's "writes last-known location to
 * **Redis** (hot, TTL)", §10's `LocationRedisCache`).
 *
 * One key per job under the platform's namespace, holding the last accepted fix as JSON with a
 * configured TTL. Both operations are total: a Redis that is unreachable produces a miss and a
 * dropped write, never an exception, because the caller's fallback — the durable Postgres record —
 * is strictly better than a failed request.
 *
 * ## Last write wins, and why that is correct *here*
 *
 * Two fixes for one job that arrive on different nodes within the same few milliseconds can land
 * in either order, so this cache can briefly hold the older of the two. That is deliberate rather
 * than overlooked. The fact that must not go backwards is the **durable** one, and it does not:
 * `updateLocation` is monotonic by compare-and-set at the database. What a customer sees moving is
 * the **published stream**, whose order is fixed by Redis at publish time and not by this key. This
 * cache only accelerates a read and supplies an ordering hint, and the next fix a second or two
 * later corrects it. Paying for a Lua compare-and-set on the hottest path in the module to tighten
 * a window that self-heals would be the wrong trade.
 */
@Injectable()
export class RedisLocationCache implements ILocationCachePort {
  constructor(
    private readonly redis: RedisService,
    private readonly config: AppConfigService,
  ) {}

  async get(jobId: string): Promise<CachedLocation | null> {
    const raw = await this.redis.get(this.keyFor(jobId));
    if (raw === null) {
      return null;
    }
    return parse(raw);
  }

  async set(jobId: string, location: CachedLocation): Promise<void> {
    const payload: CachedLocationJson = {
      lat: location.lat,
      lng: location.lng,
      recordedAt: location.recordedAt.toISOString(),
      driverId: location.driverId,
    };
    await this.redis.set(this.keyFor(jobId), JSON.stringify(payload), this.ttlSeconds());
  }

  private keyFor(jobId: string): string {
    return this.redis.key('delivery', 'location', jobId);
  }

  private ttlSeconds(): number {
    const configured = this.config.get<number>(LOCATION_CACHE_TTL_CONFIG_KEY);
    return typeof configured === 'number' && Number.isInteger(configured) && configured > 0
      ? configured
      : DEFAULT_DELIVERY_LOCATION_CACHE_TTL_SECONDS;
  }
}

/**
 * The same port with no Redis behind it — a bounded in-process map used when `REDIS_URL` is unset.
 *
 * It exists so that an unconfigured deployment is *slower and single-node*, never *incorrect*.
 * The ordering guard in `PublishJobLocationCommand` compares an incoming fix against the newest
 * one seen rather than the last one persisted, and the write throttle deliberately leaves the
 * durable timestamp behind; with no hot store at all, a buffered fix arriving inside the throttle
 * window would look new and could move a driver backwards on the map. This keeps that guard honest
 * on a single node, which is the only topology an unconfigured deployment has.
 *
 * Entries expire on the same TTL and the map is capped — see `IN_MEMORY_CAPACITY`.
 */
@Injectable()
export class InMemoryLocationCache implements ILocationCachePort {
  private readonly entries = new Map<string, { value: CachedLocation; expiresAt: number }>();

  constructor(private readonly config: AppConfigService) {}

  async get(jobId: string): Promise<CachedLocation | null> {
    const entry = this.entries.get(jobId);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(jobId);
      return null;
    }
    return entry.value;
  }

  async set(jobId: string, location: CachedLocation): Promise<void> {
    if (this.entries.size >= IN_MEMORY_CAPACITY && !this.entries.has(jobId)) {
      this.evictOldest();
    }
    this.entries.set(jobId, {
      value: location,
      expiresAt: Date.now() + this.ttlSeconds() * 1_000,
    });
  }

  private evictOldest(): void {
    // Drop everything already expired first; only if that frees nothing does insertion order
    // decide. A Map iterates in insertion order, so the first key is the least recently added.
    const now = Date.now();
    let freed = false;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
        freed = true;
      }
    }
    if (freed) {
      return;
    }
    const oldest = this.entries.keys().next();
    if (!oldest.done) {
      this.entries.delete(oldest.value);
    }
  }

  private ttlSeconds(): number {
    const configured = this.config.get<number>(LOCATION_CACHE_TTL_CONFIG_KEY);
    return typeof configured === 'number' && Number.isInteger(configured) && configured > 0
      ? configured
      : DEFAULT_DELIVERY_LOCATION_CACHE_TTL_SECONDS;
  }
}

/**
 * Parses a cache entry defensively.
 *
 * A cache survives deployments, so an entry written by the previous version of this code is an
 * ordinary occurrence rather than an anomaly. A shape this version does not understand must
 * degrade to a miss — the durable record then answers — and never to an exception on the hot path.
 */
function parse(raw: string): CachedLocation | null {
  try {
    const parsed = JSON.parse(raw) as Partial<CachedLocationJson>;
    const recordedAt = new Date(String(parsed.recordedAt));
    if (
      typeof parsed.lat !== 'number' ||
      typeof parsed.lng !== 'number' ||
      typeof parsed.driverId !== 'string' ||
      Number.isNaN(recordedAt.getTime())
    ) {
      return null;
    }
    return { lat: parsed.lat, lng: parsed.lng, recordedAt, driverId: parsed.driverId };
  } catch {
    return null;
  }
}
