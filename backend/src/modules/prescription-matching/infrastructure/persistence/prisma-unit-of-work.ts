import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { IUnitOfWork } from '../../application/ports/unit-of-work.port';

/**
 * ADR-013/§2.1.1: every Module 05 mutation writes its audit entry and outbox event inside this
 * same transaction, so the audit hash chain's "no fork" guarantee requires running every
 * mutation transaction at `Serializable` isolation — exactly mirroring
 * `modules/catalog/infrastructure/persistence/prisma-unit-of-work.ts` /
 * `modules/profiles/infrastructure/persistence/prisma-unit-of-work.ts` (own copy per ADR-002,
 * not a cross-module import). Commands wrap `uow.run` with `runWithMatchRetry`
 * (`application/support/match-retry.ts`), which retries against freshly re-read/committed state
 * instead of surfacing a 500.
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
