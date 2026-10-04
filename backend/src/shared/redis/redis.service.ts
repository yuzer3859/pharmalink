import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis, { RedisOptions } from 'ioredis';
import { AppConfigService } from '../config/app-config.service';
import { AppLogger } from '../logging/app-logger.service';

/** A message received on a subscribed channel. The raw payload; parsing belongs to the caller. */
export type RedisChannelListener = (message: string, channel: string) => void;

/**
 * How ioredis reconnects. Capped backoff rather than the library default, which grows without
 * bound: a Redis that comes back after ten minutes must be picked up within seconds, because
 * every second beyond that is a customer watching a map that has stopped moving.
 */
const RECONNECT_BACKOFF_MS = (attempt: number): number => Math.min(attempt * 200, 3_000);

/**
 * The platform's **single** Redis client (`architecture/module-08-delivery-tracking.md` §7).
 *
 * Shared rather than owned by Module 08, deliberately. Module 01's OTP store and permission cache
 * both carry comments saying they move to Redis, and Module 08's tracking is simply the first
 * feature that needs it. Two modules each opening their own connection pool would double the
 * connection count, split the key namespace and give operators two things to configure; this is
 * the one place a connection is made, and everything else asks it.
 *
 * ## Optional, and every caller must handle its absence
 *
 * `REDIS_URL` is unset in development and in most test runs, and that is a supported
 * configuration — see `redis.config.ts`. `isEnabled` reports whether a connection was even
 * attempted, and every method below is total: it returns `null` or `false` instead of throwing
 * when Redis is absent or unreachable. That shape is chosen so a caller cannot accidentally treat
 * Redis as durable — there is no method that can only succeed.
 *
 * A connection failure at boot is logged and survived rather than fatal. Redis holds no fact this
 * platform cannot recompute from Postgres, so refusing to start would trade a degraded feature
 * for a total outage.
 *
 * ## Two connections, because Redis requires it
 *
 * A connection in subscribe mode may not issue ordinary commands, so a publisher and a subscriber
 * cannot be the same socket. `data` serves `get`/`set`/`publish`; `subscriber` is a duplicate used
 * only for `SUBSCRIBE`. Channel subscriptions are reference-counted, so many logical subscribers
 * to one channel cost one `SUBSCRIBE` and the channel is released only when the last of them
 * leaves.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private data: Redis | null = null;
  private subscriber: Redis | null = null;

  /** channel -> the listeners this process has registered for it. */
  private readonly listeners = new Map<string, Set<RedisChannelListener>>();

  private readonly url: string | null;
  private readonly prefix: string;

  constructor(
    private readonly config: AppConfigService,
    private readonly logger: AppLogger,
  ) {
    this.logger.setContext(RedisService.name);
    this.url = this.config.get<string>('redis.url') ?? null;
    this.prefix = this.config.get<string>('redis.keyPrefix') ?? 'pharmalink';
  }

  /** Whether a Redis connection is configured at all. `false` means every operation no-ops. */
  get isEnabled(): boolean {
    return this.url !== null;
  }

  /**
   * Whether Redis is configured *and* the connection is currently usable.
   *
   * Distinct from `isEnabled` because the two failure modes need different handling: unconfigured
   * is a deployment choice that callers fall back around silently, while configured-but-down is an
   * incident worth reporting. Callers that must not overstate what happened — a tracking publish
   * telling a driver their position was relayed — read this one.
   */
  get isConnected(): boolean {
    return this.data?.status === 'ready';
  }

  async onModuleInit(): Promise<void> {
    if (this.url === null) {
      this.logger.log('REDIS_URL is not set — tracking fan-out runs in single-process mode.');
      return;
    }

    const options: RedisOptions = {
      lazyConnect: true,
      // Fail a command fast instead of queueing it forever. A location publish that cannot go out
      // now is worthless in three seconds' time, and an unbounded offline queue would turn a
      // Redis outage into unbounded memory growth on every API node.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      retryStrategy: RECONNECT_BACKOFF_MS,
    };

    this.data = new Redis(this.url, options);
    this.subscriber = this.data.duplicate();

    // Without an `error` listener ioredis emits on the process and an unhandled 'error' event
    // terminates Node. A Redis outage must degrade this platform, never stop it.
    this.data.on('error', (err: Error) => this.onConnectionError('data', err));
    this.subscriber.on('error', (err: Error) => this.onConnectionError('subscriber', err));

    this.subscriber.on('message', (channel: string, message: string) => {
      for (const listener of this.listeners.get(channel) ?? []) {
        try {
          listener(message, channel);
        } catch (err) {
          // One bad listener must not stop the others on the same channel, nor kill the shared
          // subscriber connection every other channel depends on.
          this.logger.warn(
            `Redis channel listener failed for ${channel}: ${(err as Error).message}`,
          );
        }
      }
    });

    // A reconnect gives us a connection that has forgotten every SUBSCRIBE. Re-issuing them here
    // is what makes reconnection transparent to callers — otherwise a customer's socket would
    // survive a Redis blip while silently receiving nothing ever again.
    this.subscriber.on('ready', () => {
      const channels = [...this.listeners.keys()];
      if (channels.length === 0) {
        return;
      }
      void this.subscriber?.subscribe(...channels).catch((err: Error) => {
        this.logger.error(`Failed to restore ${channels.length} subscriptions: ${err.message}`);
      });
    });

    try {
      await Promise.all([this.data.connect(), this.subscriber.connect()]);
      this.logger.log('Redis connected.');
    } catch (err) {
      // Survived, not fatal: see the class comment.
      this.logger.error(`Redis connection failed, continuing degraded: ${(err as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.listeners.clear();
    // `disconnect` rather than `quit`: quit waits for a graceful handshake that a connection in a
    // retry loop never completes, which would hang shutdown and, in tests, hang Jest.
    this.data?.disconnect();
    this.subscriber?.disconnect();
    this.data = null;
    this.subscriber = null;
  }

  /** Namespaces a key, so two environments can share one Redis instance. */
  key(...parts: string[]): string {
    return [this.prefix, ...parts].join(':');
  }

  /** Reads a key, or `null` when it is absent, Redis is off, or the read failed. */
  async get(key: string): Promise<string | null> {
    if (!this.data) {
      return null;
    }
    try {
      return await this.data.get(key);
    } catch (err) {
      this.logger.warn(`Redis GET ${key} failed: ${(err as Error).message}`);
      return null;
    }
  }

  /** Writes a key with a TTL. Returns whether it was actually stored. */
  async set(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    if (!this.data) {
      return false;
    }
    try {
      await this.data.set(key, value, 'EX', Math.max(1, Math.floor(ttlSeconds)));
      return true;
    } catch (err) {
      this.logger.warn(`Redis SET ${key} failed: ${(err as Error).message}`);
      return false;
    }
  }

  async del(key: string): Promise<void> {
    if (!this.data) {
      return;
    }
    try {
      await this.data.del(key);
    } catch (err) {
      this.logger.warn(`Redis DEL ${key} failed: ${(err as Error).message}`);
    }
  }

  /**
   * Publishes to a channel. Returns whether the message actually reached Redis.
   *
   * The boolean is the point. A caller that reports a real-time update as delivered when the
   * publish failed would be telling a driver their position is on the customer's map when it is
   * not, so the failure is returned rather than swallowed or thrown.
   */
  async publish(channel: string, message: string): Promise<boolean> {
    if (!this.data) {
      return false;
    }
    try {
      await this.data.publish(channel, message);
      return true;
    } catch (err) {
      this.logger.warn(`Redis PUBLISH ${channel} failed: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Registers a listener on a channel, issuing `SUBSCRIBE` only for the first one.
   *
   * Returns an unsubscribe function rather than requiring the caller to hand back the same
   * listener reference — the caller is typically a socket handler that is disposed of by a
   * disconnect it does not control, and a release it can hold onto is much harder to leak.
   */
  async subscribe(channel: string, listener: RedisChannelListener): Promise<() => Promise<void>> {
    let channelListeners = this.listeners.get(channel);
    const isFirst = channelListeners === undefined;
    if (channelListeners === undefined) {
      channelListeners = new Set();
      this.listeners.set(channel, channelListeners);
    }
    channelListeners.add(listener);

    if (isFirst && this.subscriber) {
      try {
        await this.subscriber.subscribe(channel);
      } catch (err) {
        this.logger.warn(`Redis SUBSCRIBE ${channel} failed: ${(err as Error).message}`);
      }
    }

    let released = false;
    return async () => {
      // Idempotent: a socket that both unsubscribes and then disconnects releases twice, and the
      // second release must not decrement a count it has already given up.
      if (released) {
        return;
      }
      released = true;
      await this.releaseListener(channel, listener);
    };
  }

  private async releaseListener(channel: string, listener: RedisChannelListener): Promise<void> {
    const channelListeners = this.listeners.get(channel);
    if (!channelListeners) {
      return;
    }
    channelListeners.delete(listener);
    if (channelListeners.size > 0) {
      return;
    }

    this.listeners.delete(channel);
    if (!this.subscriber) {
      return;
    }
    try {
      await this.subscriber.unsubscribe(channel);
    } catch (err) {
      this.logger.warn(`Redis UNSUBSCRIBE ${channel} failed: ${(err as Error).message}`);
    }
  }

  private onConnectionError(which: string, err: Error): void {
    this.logger.warn(`Redis ${which} connection error: ${err.message}`);
  }
}
