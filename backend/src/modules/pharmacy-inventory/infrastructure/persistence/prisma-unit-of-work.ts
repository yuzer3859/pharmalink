import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { IUnitOfWork } from '../../application/ports/outbound/unit-of-work.port';

/**
 * Module-04 §8: `Read Committed` (Postgres default) is sufficient for the reserve flow because
 * correctness comes from the explicit `SELECT ... FOR UPDATE` row lock, not from the
 * transaction isolation level — deliberately NOT `Serializable` (unlike Module 02/03's
 * audit-hash-chain transactions), to avoid an unnecessary throughput hit under NFR-PERF-05.
 */
@Injectable()
export class PrismaUnitOfWork implements IUnitOfWork {
  constructor(private readonly prisma: PrismaService) {}

  run<T>(work: (tx: unknown) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => work(tx), {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    });
  }
}
