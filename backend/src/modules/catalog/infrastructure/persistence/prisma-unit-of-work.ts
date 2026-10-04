import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { IUnitOfWork } from '../../application/ports/unit-of-work.port';

/**
 * ADR-010: every Catalog mutation writes its audit entry and outbox event inside this same
 * transaction, so the audit hash chain's "no fork" guarantee requires running every mutation
 * transaction at Serializable isolation, exactly mirroring
 * `modules/profiles/infrastructure/persistence/prisma-unit-of-work.ts` (built in from day one
 * here, rather than retrofitted after a defect as in Module 02 — see 03-catalog-spec.md §9).
 * Commands wrap `uow.run` with `runWithDedupRetry` (application/support/dedup-conflict.ts), which
 * retries against freshly re-read/committed state instead of surfacing a 500.
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
