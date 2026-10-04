import { Global, Module } from '@nestjs/common';
import { AUDIT_READ_PORT } from './audit-read.port';
import { AuditService } from './audit.service';
import { PrismaAuditReadAdapter } from './prisma-audit-read.adapter';

/**
 * `AuditService` writes; `AUDIT_READ_PORT` reads. Two providers rather than two methods on one
 * so that the writer keeps its "never expose an update/delete path" shape and a reader cannot
 * reach the writer by injecting the read port.
 */
@Global()
@Module({
  providers: [AuditService, { provide: AUDIT_READ_PORT, useClass: PrismaAuditReadAdapter }],
  exports: [AuditService, AUDIT_READ_PORT],
})
export class AuditModule {}
