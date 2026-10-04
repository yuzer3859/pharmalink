import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { IUnitOfWork } from '../../application/ports/unit-of-work.port';

/**
 * ADR-013: every mutation that co-locates a state change with an `AuditService.record` call and
 * an outbox write runs at `Serializable` isolation — exactly mirroring
 * `modules/orders/infrastructure/persistence/prisma-unit-of-work.ts` and its Module 07 sibling
 * (own copy per ADR-002).
 *
 * Callers wrap `run()` in `runWithDeliveryRetry`, because `Serializable` makes a concurrent
 * creator's conflict a retryable error rather than a lost write.
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
