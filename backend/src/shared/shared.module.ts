import { Global, Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module';
import { LoggingModule } from './logging/logging.module';
import { PrismaModule } from './prisma/prisma.module';
import { CryptoModule } from './crypto/crypto.module';
import { EventBusModule } from './events/event-bus.module';
import { OutboxModule } from './outbox/outbox.module';
import { AuditModule } from './audit/audit.module';
import { RbacModule } from './rbac/rbac.module';
import { RedisModule } from './redis/redis.module';

/**
 * Aggregates all Phase-0 cross-cutting infrastructure. Every submodule is @Global, so importing
 * SharedModule once (in AppModule) makes config, logging, Prisma, crypto, the event bus, the
 * outbox, audit, RBAC and Redis available to every feature module without re-importing.
 */
@Global()
@Module({
  imports: [
    AppConfigModule,
    LoggingModule,
    PrismaModule,
    CryptoModule,
    EventBusModule,
    OutboxModule,
    AuditModule,
    RbacModule,
    RedisModule,
  ],
  exports: [
    AppConfigModule,
    LoggingModule,
    PrismaModule,
    CryptoModule,
    EventBusModule,
    OutboxModule,
    AuditModule,
    RbacModule,
    RedisModule,
  ],
})
export class SharedModule {}
