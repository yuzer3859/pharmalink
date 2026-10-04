import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../../../shared/config/app-config.service';
import { DEFAULT_DELIVERY_ETA_CACHE_TTL_SECONDS } from '../../../../shared/config/delivery.config';
import { RedisService } from '../../../../shared/redis/redis.service';
import { CachedEta, IEtaCachePort } from '../../application/ports/outbound/eta-cache.port';
import { RouteDestination } from '../../domain/services/tracking-policy';

/** The dotted config key backing the entry's TTL. */
export const ETA_CACHE_TTL_CONFIG_KEY = 'delivery.etaCacheTtlSeconds';

/**
 * Entries the in-process fallback will hold before evicting. Two per live delivery at most — one
 * pickup, one dropoff — so this is a generous ceiling for a node that has no Redis configured.
 */
const IN_MEMORY_CAPACITY = 2_000;

/** The wire shape, written explicitly so a change to `CachedEta` cannot silently alter it. */
interface CachedEtaJson {
  originLat: number;
  originLng: number;
  distanceMeters: number;
  durationSeconds: number;
  computedAt: string;
}

/**
 * `IEtaCachePort` over the shared Redis connection (§7's "cached and refreshed", §10).
 *
 * One key per job **and destination** — `<prefix>:delivery:eta:<jobId>:<PICKUP|DROPOFF>`. Putting
 * the destination in the key rather than inside the value is what makes the pickup boundary
 * self-cleaning: when a job moves to `PICKED_UP` the reader starts asking a different key, so the
 * pickup estimate is not merely ignored but unreachable. There is no code path that could serve
 * one as the other, and none that could let one job's key collide with another's.
 *
 * Shared rather than per-process, which is what §5's "do not make cache correctness depend on
 * in-memory process state" asks for: a driver's fix landing on one node and a customer's refresh
 * on another see the same estimate instead of two separately-computed ones that differ by a few
 * seconds for no reason a customer could understand.
 *
 * Both operations are total. An unreachable Redis produces a miss and a dropped write, never an
 * exception — the fallback is to recompute, which is strictly better than a failed request.
 */
@Injectable()
export class RedisEtaCache implements IEtaCachePort {
  constructor(
    private readonly redis: RedisService,
    private readonly config: AppConfigService,
  ) {}

  async get(jobId: string, destination: RouteDestination): Promise<CachedEta | null> {
    const raw = await this.redis.get(this.keyFor(jobId, destination));
    return raw === null ? null : parse(raw);
  }

  async set(
    jobId: string,
    destination: RouteDestination,
    entry: CachedEta,
  ): Promise<void> {
    const payload: CachedEtaJson = {
      originLat: entry.originLat,
      originLng: entry.originLng,
      distanceMeters: entry.distanceMeters,
      durationSeconds: entry.durationSeconds,
      computedAt: entry.computedAt.toISOString(),
    };
    await this.redis.set(
      this.keyFor(jobId, destination),
      JSON.stringify(payload),
      this.ttlSeconds(),
    );
  }

  private keyFor(jobId: string, destination: RouteDestination): string {
    return this.redis.key('delivery', 'eta', jobId, destination);
  }

  private ttlSeconds(): number {
    return ttlFrom(this.config);
  }
}

/**
 * The same port with no Redis behind it — a bounded in-process map for when `REDIS_URL` is unset.
 *
 * It costs only extra routing calls, never a wrong answer: two nodes each keeping their own
 * estimate for the same delivery compute the same route from the same position, so the worst case
 * is duplicated work. That is why a per-process fallback is acceptable here when it would not be
 * for anything holding a fact.
 */
@Injectable()
export class InMemoryEtaCache implements IEtaCachePort {
  private readonly entries = new Map<string, { value: CachedEta; expiresAt: number }>();

  constructor(private readonly config: AppConfigService) {}

  async get(jobId: string, destination: RouteDestination): Promise<CachedEta | null> {
    const key = `${jobId}:${destination}`;
    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(jobId: string, destination: RouteDestination, entry: CachedEta): Promise<void> {
    const key = `${jobId}:${destination}`;
    if (this.entries.size >= IN_MEMORY_CAPACITY && !this.entries.has(key)) {
      this.evict();
    }
    this.entries.set(key, {
      value: entry,
      expiresAt: Date.now() + ttlFrom(this.config) * 1_000,
    });
  }

  private evict(): void {
    // Expired entries first; only if that frees nothing does insertion order decide. A Map
    // iterates in insertion order, so the first key is the least recently added.
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
}

function ttlFrom(config: AppConfigService): number {
  const configured = config.get<number>(ETA_CACHE_TTL_CONFIG_KEY);
  return typeof configured === 'number' && Number.isInteger(configured) && configured > 0
    ? configured
    : DEFAULT_DELIVERY_ETA_CACHE_TTL_SECONDS;
}

/**
 * Parses an entry defensively.
 *
 * A cache outlives a deployment, so an entry written by the previous version of this code is
 * ordinary rather than anomalous. A shape this version cannot read degrades to a miss — which
 * recomputes — and never to an exception on the tracking path.
 */
function parse(raw: string): CachedEta | null {
  try {
    const parsed = JSON.parse(raw) as Partial<CachedEtaJson>;
    const computedAt = new Date(String(parsed.computedAt));
    if (
      typeof parsed.originLat !== 'number' ||
      typeof parsed.originLng !== 'number' ||
      typeof parsed.distanceMeters !== 'number' ||
      typeof parsed.durationSeconds !== 'number' ||
      Number.isNaN(computedAt.getTime())
    ) {
      return null;
    }
    return {
      originLat: parsed.originLat,
      originLng: parsed.originLng,
      distanceMeters: parsed.distanceMeters,
      durationSeconds: parsed.durationSeconds,
      computedAt,
    };
  } catch {
    return null;
  }
}
