import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { IAdminUnitOfWork } from '../../application/ports/unit-of-work.port';

/**
 * Admin's unit of work. `ReadCommitted` (the default): the maker-checker transitions are decided by
 * conditional updates and unique indexes, which hold at any isolation level.
 */
@Injectable()
export class PrismaUnitOfWork implements IAdminUnitOfWork {
  constructor(private readonly prisma: PrismaService) {}

  run<T>(work: (tx: unknown) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => work(tx));
  }
}
