import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { IUnitOfWork } from '../../application/ports/unit-of-work.port';

/**
 * ADR-013: every Module 06 mutation that co-locates a state change with an `AuditService.record`
 * call and an outbox write must run at `Serializable` isolation — exactly mirroring
 * `modules/prescription-matching/infrastructure/persistence/prisma-unit-of-work.ts` /
 * `modules/catalog/.../prisma-unit-of-work.ts` (own copy per ADR-002, not a cross-module
 * import). Future commands wrap `uow.run` with this module's own bounded-retry helper
 * (`runWithOrderRetry`, §11, not built by this task).
 */
@Injectable()
export class PrismaUnitOfWork implements IUnitOfWork {
  constructor(private readonly prisma: PrismaService) {}

  run<T>(work: (tx: unknown) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => work(tx), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  }
}
