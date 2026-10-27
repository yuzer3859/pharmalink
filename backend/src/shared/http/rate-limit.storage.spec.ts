import { AppLogger } from '../logging/app-logger.service';
import { RateLimitCount, RedisService } from '../redis/redis.service';
import { RateLimitStorage } from './rate-limit.storage';

/** Work 59: where rate-limit counters live, and that a Redis failure never disables a limit. */
describe('RateLimitStorage', () => {
  const logger = () => {
    const l = new AppLogger();
    jest.spyOn(l, 'warn').mockImplementation(() => undefined);
    return l;
  };
  const redis = (enabled: boolean, result: RateLimitCount | null) =>
    ({ isEnabled: enabled, incrementRateLimit: jest.fn().mockResolvedValue(result) }) as unknown as RedisService & {
      incrementRateLimit: jest.Mock;
    };

  it('counts in memory when Redis is not configured (single instance only)', async () => {
    const r = redis(false, null);
    const storage = new RateLimitStorage(r, logger());
    expect(storage.mode).toBe('in-memory-single-instance');
    const first = await storage.increment('k', 60_000, 2, 60_000, 'auth');
    await storage.increment('k', 60_000, 2, 60_000, 'auth');
    const third = await storage.increment('k', 60_000, 2, 60_000, 'auth');
    expect(first).toMatchObject({ totalHits: 1, isBlocked: false });
    expect(third.isBlocked).toBe(true);
    expect(r.incrementRateLimit).not.toHaveBeenCalled();
    storage.onApplicationShutdown();
  });

  it('uses shared Redis counters when configured, converting milliseconds to seconds', async () => {
    const r = redis(true, { hits: 4, windowRemainingMs: 1500, blocked: true, blockRemainingMs: 59_001 });
    const storage = new RateLimitStorage(r, logger());
    expect(storage.mode).toBe('shared-redis');
    expect(await storage.increment('k', 60_000, 3, 60_000, 'auth')).toEqual({
      totalHits: 4,
      timeToExpire: 2,
      isBlocked: true,
      timeToBlockExpire: 60,
    });
    expect(r.incrementRateLimit).toHaveBeenCalledWith('auth:k', 60_000, 3, 60_000);
    storage.onApplicationShutdown();
  });

  it('falls back to per-instance counters (still limited) when Redis fails, warning at most once a minute', async () => {
    const r = redis(true, null);
    const l = logger();
    const storage = new RateLimitStorage(r, l);
    await storage.increment('k', 60_000, 1, 60_000, 'auth');
    const second = await storage.increment('k', 60_000, 1, 60_000, 'auth');
    expect(second.isBlocked).toBe(true);
    expect(l.warn).toHaveBeenCalledTimes(1);
    expect(String((l.warn as jest.Mock).mock.calls[0][0])).toMatch(/counted per instance in memory/);
    storage.onApplicationShutdown();
  });
});
