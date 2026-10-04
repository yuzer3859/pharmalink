import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';

/**
 * The shared Redis connection (§7). Global, so the tracking gateway and any later consumer —
 * Module 01's OTP store and permission cache both name Redis as their destination — reach the
 * same client rather than opening a second one.
 */
@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
