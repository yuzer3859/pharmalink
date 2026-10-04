import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { AppConfigService } from './app-config.service';
import { ConfigOverrideRegistry } from './config-override.registry';
import { CONFIG_PORT } from './config.port';
import { PlatformConfigResolver } from './platform-config.resolver';
import { deliveryConfig } from './delivery.config';
import { validateEnv } from './env.validation';
import { ordersConfig } from './orders.config';
import { redisConfig } from './redis.config';

@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
      // Namespaced business parameters. `validate` only checks the flat environment; a `load`
      // factory is what actually gives `ConfigService` a value for a dotted key like
      // `orders.platformFeePercent`, which feature modules have been reading all along.
      load: [ordersConfig, deliveryConfig, redisConfig],
    }),
  ],
  providers: [
    AppConfigService,
    // The handover point for Module 16's published overrides. Empty until something fills it, and
    // an empty registry means every lookup resolves exactly as it did before Module 16 existed.
    ConfigOverrideRegistry,
    PlatformConfigResolver,
    // `CONFIG_PORT` now resolves to the effective-value resolver rather than straight to the
    // environment reader. The interface is unchanged, so no consumer changes; what changes is that
    // a governed key can be answered by an administrator's published value.
    //
    // `AppConfigService` is still exported and still injected directly by the things that must
    // *never* be administrable — `JwtTokenService`, `CryptoService`, `RedisService`, `main.ts`.
    // Those read secrets and infrastructure settings through its typed accessors, which the
    // resolver has no path to and the override snapshot never carries.
    { provide: CONFIG_PORT, useExisting: PlatformConfigResolver },
  ],
  exports: [AppConfigService, ConfigOverrideRegistry, PlatformConfigResolver, CONFIG_PORT],
})
export class AppConfigModule {}
