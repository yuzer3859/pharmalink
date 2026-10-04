import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  AccountAnalyticsView,
  AccountStatus,
  IIdentityAnalyticsReadPort,
  PrimaryRole,
} from '../../application/ports/inbound/identity-analytics-read.port';

/**
 * `IIdentityAnalyticsReadPort` over Prisma — three aggregate queries and no row fetch. The same
 * unfiltered population `PrismaUserRepository.search` counts (`users`, no soft-delete predicate:
 * deletion is a status here). The `groupBy` runs in PostgreSQL; the only work done in Node is
 * laying the buckets out in enum order and filling the absent ones with zero.
 */
@Injectable()
export class PrismaIdentityAnalyticsReadAdapter implements IIdentityAnalyticsReadPort {
  constructor(private readonly prisma: PrismaService) {}

  async summarizeAccounts(): Promise<AccountAnalyticsView> {
    const [total, byStatus, byRole] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.user.groupBy({ by: ['primaryRole'], _count: { _all: true } }),
    ]);
    const statusCounts = new Map(byStatus.map((g) => [g.status as string, g._count._all]));
    const roleCounts = new Map(byRole.map((g) => [g.primaryRole as string, g._count._all]));
    return {
      total,
      byStatus: Object.values(AccountStatus).map((status) => ({
        status,
        count: statusCounts.get(status) ?? 0,
      })),
      byPrimaryRole: Object.values(PrimaryRole).map((primaryRole) => ({
        primaryRole,
        count: roleCounts.get(primaryRole) ?? 0,
      })),
    };
  }
}
