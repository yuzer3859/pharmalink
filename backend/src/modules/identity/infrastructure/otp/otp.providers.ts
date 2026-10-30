import { Provider } from '@nestjs/common';
import { AppConfigService } from '../../../../shared/config/app-config.service';
import { OTP_HASH_SECRET_ENV, OTP_STORE_ENV, resolveOtpStore } from '../../../../shared/config/otp.config';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { RedisService } from '../../../../shared/redis/redis.service';
import { IOtpService, OTP_SERVICE } from '../../application/ports/otp.service';
import { OTP_STORE_PROBE } from '../../application/ports/otp-store-probe.port';
import { InMemoryOtpService } from './in-memory-otp.service';
import { RedisOtpService } from './redis-otp.service';

/**
 * Chooses the `IOtpService` at startup (Work 60). The rule lives in `resolveOtpStore`: production
 * resolves to `redis` only, and `redis` requires `REDIS_URL` and `OTP_HASH_SECRET`. Only the
 * selected adapter is constructed, and nothing switches stores later — a Redis outage makes OTP
 * requests fail, it does not move them to memory.
 */
export function selectOtpService(config: AppConfigService, redis: RedisService, logger: AppLogger): IOtpService {
  const store = resolveOtpStore({
    nodeEnv: config.nodeEnv,
    store: config.get<string>(OTP_STORE_ENV),
    redisUrl: config.get<string>('REDIS_URL'),
    hashSecret: config.get<string>(OTP_HASH_SECRET_ENV),
    otherSecrets: [config.jwtAccessSecret, config.jwtRefreshSecret, config.masterEncryptionKey],
  });

  if (store === 'redis') {
    const service = new RedisOtpService(redis, config, logger);
    // Names the store only; the local staging rehearsal checks for this line (Work 61).
    logger.log('OTP challenges are stored in Redis (OTP_STORE=redis).');
    return service;
  }

  logger.setContext('OtpStore');
  logger.warn(
    'OTP challenges are kept in memory (OTP_STORE=memory): one process only, lost on restart. Local development and tests only.',
  );
  return new InMemoryOtpService(config, logger);
}

/** The identity module's OTP binding; spread into `IdentityModule.providers`. */
export const otpProviders: Provider[] = [
  {
    provide: OTP_SERVICE,
    useFactory: selectOtpService,
    inject: [AppConfigService, RedisService, AppLogger],
  },
  // The same instance, seen through its readiness probe (Work 65).
  { provide: OTP_STORE_PROBE, useExisting: OTP_SERVICE },
];
