import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { BootstrapCliModule } from './bootstrap-cli.module';

/**
 * A Nest *application context* for the first-Super-Admin CLI: providers only, no HTTP adapter and
 * no listener, so the process never serves a request. Call `declareCliProcess()` first.
 */
export function createBootstrapContext(): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext(BootstrapCliModule, { logger: ['error', 'warn'] });
}
