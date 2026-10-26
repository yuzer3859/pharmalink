import { ExecutionContext, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppConfigService } from '../config/app-config.service';
import { RateLimitGuard } from './rate-limit.guard';
import { SENSITIVE_RATE_LIMIT_KEY } from './rate-limit.decorator';
import { RateLimitStorage } from './rate-limit.storage';

export const DEFAULT_THROTTLER = 'default';
export const AUTH_THROTTLER = 'auth';

const isSensitive = (context: ExecutionContext): boolean =>
  Reflect.getMetadata(SENSITIVE_RATE_LIMIT_KEY, context.getHandler()) === true ||
  Reflect.getMetadata(SENSITIVE_RATE_LIMIT_KEY, context.getClass()) === true;

/** Provides the counter store to `ThrottlerModule.forRootAsync`'s factory. */
@Module({ providers: [RateLimitStorage], exports: [RateLimitStorage] })
export class RateLimitStorageModule {}

/**
 * Global HTTP rate limiting (Work 59).
 *
 * - `default`: every HTTP route, `RATE_LIMIT_DEFAULT_LIMIT` per `RATE_LIMIT_DEFAULT_TTL_SECONDS`,
 *   per client, per route. The health probes opt out with `@SkipThrottle()`.
 * - `auth`: only routes marked `@SensitiveRateLimit()`, `RATE_LIMIT_AUTH_LIMIT` per
 *   `RATE_LIMIT_AUTH_TTL_SECONDS`, per client, per route, in addition to `default`.
 *
 * A client that exceeds a limit is refused until the window it opened expires (block duration =
 * window). Limits come from validated configuration; there is no way to configure them off.
 * Security headers and trusted proxies are applied at bootstrap by `applyHttpSecurity`.
 */
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      imports: [RateLimitStorageModule],
      inject: [AppConfigService, RateLimitStorage],
      useFactory: (config: AppConfigService, storage: RateLimitStorage) => ({
        storage,
        throttlers: [
          {
            name: DEFAULT_THROTTLER,
            limit: Number(config.get('RATE_LIMIT_DEFAULT_LIMIT')),
            ttl: Number(config.get('RATE_LIMIT_DEFAULT_TTL_SECONDS')) * 1000,
          },
          {
            name: AUTH_THROTTLER,
            limit: Number(config.get('RATE_LIMIT_AUTH_LIMIT')),
            ttl: Number(config.get('RATE_LIMIT_AUTH_TTL_SECONDS')) * 1000,
            skipIf: (context: ExecutionContext) => !isSensitive(context),
          },
        ],
      }),
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: RateLimitGuard }],
})
export class HttpSecurityModule {}
