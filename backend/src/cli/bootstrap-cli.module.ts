import { Module } from '@nestjs/common';
import { IdentityModule } from '../modules/identity/identity.module';
import { SharedModule } from '../shared/shared.module';

/**
 * The first-Super-Admin CLI's module (Work 65): shared infrastructure (config, Prisma, Redis,
 * e-mail, audit, outbox) and Identity, nothing else. Loaded into an application context, never an
 * HTTP application, and with the process declared a CLI so no background timer starts.
 */
@Module({ imports: [SharedModule, IdentityModule] })
export class BootstrapCliModule {}
