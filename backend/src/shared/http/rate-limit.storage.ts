import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppLogger } from '../logging/app-logger.service';
import { RedisService } from '../redis/redis.service';

type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

/** At most one fallback warning per minute, so a Redis outage cannot flood the log. */
const FALLBACK_WARNING_INTERVAL_MS = 60_000;

/**
 * Rate-limit counters (Work 59).
 *
 * - **`REDIS_URL` set:** counters live in Redis, so every backend instance shares them and a limit
 *   holds across replicas. The key is the throttler's hash of route + client, never a raw IP.
 * - **`REDIS_URL` unset:** counters are in this process's memory. Correct for one instance only;
 *   with N instances a client could make up to N times the limit. Documented, not hidden.
 * - **Redis configured but failing:** this request is counted in memory instead, and a warning is
 *   logged. Limits stay in force per instance; a Redis outage never turns them off.
 */
@Injectable()
export class RateLimitStorage implements ThrottlerStorage, OnApplicationShutdown {
  private readonly memory = new ThrottlerStorageService();
  private lastFallbackWarning = 0;

  constructor(
    private readonly redis: RedisService,
    private readonly logger: AppLogger,
  ) {
    this.logger.setContext(RateLimitStorage.name);
  }

  /** Where counters are kept, for the startup log and tests. */
  get mode(): 'shared-redis' | 'in-memory-single-instance' {
    return this.redis.isEnabled ? 'shared-redis' : 'in-memory-single-instance';
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    if (this.redis.isEnabled) {
      const shared = await this.redis.incrementRateLimit(`${throttlerName}:${key}`, ttl, limit, blockDuration);
      if (shared) {
        return {
          totalHits: shared.hits,
          timeToExpire: Math.ceil(shared.windowRemainingMs / 1000),
          isBlocked: shared.blocked,
          timeToBlockExpire: Math.ceil(shared.blockRemainingMs / 1000),
        };
      }
      this.warnFallback();
    }
    return this.memory.increment(key, ttl, limit, blockDuration, throttlerName);
  }

  onApplicationShutdown(): void {
    this.memory.onApplicationShutdown();
  }

  private warnFallback(): void {
    const now = Date.now();
    if (now - this.lastFallbackWarning < FALLBACK_WARNING_INTERVAL_MS) return;
    this.lastFallbackWarning = now;
    this.logger.warn(
      'Redis is configured but unavailable: rate limits are being counted per instance in memory until it recovers.',
    );
  }
}
