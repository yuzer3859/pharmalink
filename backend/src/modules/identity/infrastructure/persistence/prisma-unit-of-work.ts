import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { IUnitOfWork, UnitOfWorkOptions } from '../../application/ports/unit-of-work.port';

/** Serialization failures (Prisma `P2034`, SQLSTATE 40001/40P01) are retried this many times in all. */
const SERIALIZABLE_ATTEMPTS = 3;

function isSerializationFailure(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'P2034' || code === '40001' || code === '40P01';
}

@Injectable()
export class PrismaUnitOfWork implements IUnitOfWork {
  constructor(private readonly prisma: PrismaService) {}

  async run<T>(work: (tx: unknown) => Promise<T>, options: UnitOfWorkOptions = {}): Promise<T> {
    if (options.isolation !== 'serializable') {
      return this.prisma.$transaction((tx) => work(tx));
    }
    // Serializable runs the whole unit as if alone, so a concurrent writer that read the same rows
    // (or the audit chain's last hash) aborts instead of interleaving. The loser re-runs from the
    // start and re-reads the state the winner committed.
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.prisma.$transaction((tx) => work(tx), {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (err) {
        if (attempt >= SERIALIZABLE_ATTEMPTS || !isSerializationFailure(err)) throw err;
      }
    }
  }
}
