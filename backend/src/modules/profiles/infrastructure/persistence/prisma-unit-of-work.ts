import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { IUnitOfWork } from '../../application/ports/unit-of-work.port';

/**
 * DEFECT-PROFILES-002 / ADR-010: every Profile/Address mutation now writes its audit entry
 * (see `AuditService.record`) inside this same transaction, so the "no fork" guarantee for the
 * hash chain — previously provided by `AuditService`'s own dedicated Serializable transaction —
 * must now come from here. Running every mutation at Serializable isolation means concurrent
 * transactions that would otherwise both read the same "last hash" (or race the default-address
 * partial unique index, DEFECT-PROFILES-001) instead abort with a write-conflict; commands wrap
 * `uow.run` with `runWithDefaultAddressRetry` (application/support/default-address-conflict.ts),
 * which retries against freshly re-read/committed state instead of surfacing a 500.
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
