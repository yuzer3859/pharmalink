import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { IUnitOfWork } from '../../application/ports/unit-of-work.port';

/**
 * ADR-013: every mutation that co-locates a state change with an `AuditService.record` call and
 * an outbox write runs at `Serializable` isolation — exactly mirroring
 * `modules/orders/infrastructure/persistence/prisma-unit-of-work.ts` (own copy per ADR-002).
 *
 * Money commands need this boundary for a second reason too: a capture's `Payment` transition
 * and its double-entry postings must be one atomic unit, and `Serializable` is what makes a
 * balance derived inside the transaction (`LedgerService.balanceOf`) safe to act on — a
 * concurrent posting to the same account cannot slip in between the read and the write.
 * Callers wrap `run()` in this module's bounded-retry helper when the payment-command task adds
 * one, following `runWithOrderRetry`/`runWithMatchRetry`.
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
