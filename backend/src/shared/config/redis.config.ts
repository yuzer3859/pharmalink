import { registerAs } from '@nestjs/config';

/**
 * Connection string for the shared Redis instance, e.g. `redis://localhost:6379`.
 *
 * **Deliberately optional, and the application must boot without it.** Redis is a *hot* store
 * here, never a system of record: the delivery tracking work uses it for last-known-location
 * caching and for cross-instance pub/sub fan-out, and both of those degrade to a working
 * single-node system when it is absent (`architecture/module-08-delivery-tracking.md` §7). Making
 * it required would mean a developer could not run the API, or a single test, without a Redis
 * container — a cost paid by everyone for a feature that one module uses.
 *
 * What it must never become is a dependency of durability. `RedisService` exposes `isEnabled` so
 * every caller has to decide what it does without Redis, rather than discovering at runtime that
 * a write it believed durable went to a cache that was not there.
 */
export const REDIS_URL_ENV = 'REDIS_URL';

/**
 * Namespace prefix applied to every key and channel, so one Redis instance can safely back more
 * than one environment.
 *
 * Staging and production sharing a Redis with no prefix would put a staging driver's position on
 * a production customer's map. The default is deliberately explicit rather than empty.
 */
export const REDIS_KEY_PREFIX_ENV = 'REDIS_KEY_PREFIX';

export const DEFAULT_REDIS_KEY_PREFIX = 'pharmalink';

/** Parses the prefix, falling back to the default when unset or blank. */
export function readRedisKeyPrefix(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[REDIS_KEY_PREFIX_ENV];
  return raw === undefined || String(raw).trim() === ''
    ? DEFAULT_REDIS_KEY_PREFIX
    : String(raw).trim();
}

/** Reads the URL, normalising "unset" and "set to blank" to the same `null`. */
export function readRedisUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[REDIS_URL_ENV];
  return raw === undefined || String(raw).trim() === '' ? null : String(raw).trim();
}

/**
 * The `redis` configuration namespace.
 *
 * Its own namespace rather than a key under `delivery`, because the connection is shared
 * infrastructure: Module 01's OTP store and permission cache are both documented as moving to
 * Redis, and they must reach for this rather than opening a second client.
 */
export const redisConfig = registerAs('redis', () => ({
  url: readRedisUrl(),
  keyPrefix: readRedisKeyPrefix(),
}));
