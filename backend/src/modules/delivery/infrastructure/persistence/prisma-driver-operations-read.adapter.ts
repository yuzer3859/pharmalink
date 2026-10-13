import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  DeliveryJobStatus,
  DriverOperationsFilter,
  DriverOperationsPage,
  DriverOperationsSummary,
  IDriverOperationsReadPort,
} from '../../application/ports/inbound/driver-operations-read.port';
import { ACTIVE_JOB_STATUSES } from '../../domain/services/driver-availability-policy';

/** The columns a summary needs — selected explicitly, so no user id, plate, area or coordinate is ever read. */
const PROFILE_SELECT = {
  id: true,
  availability: true,
  shiftStartedAt: true,
  lastOnlineAt: true,
  lastLocationAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.DriverProfileSelect;

type ProfileRow = Prisma.DriverProfileGetPayload<{ select: typeof PROFILE_SELECT }>;
type JobGroup = { assignedDriverId: string | null; status: DeliveryJobStatus; _count: { _all: number } };

/**
 * `IDriverOperationsReadPort` over Prisma — `SELECT`s only. A page of profiles, then **one**
 * `GROUP BY assignedDriverId, status` over just that page's ids (served by the existing
 * `(assignedDriverId, status)` index), so the counts cost one query whatever the page size — no
 * N+1, and no job row is loaded. The profiles, their total and the counts are read in one
 * REPEATABLE READ snapshot so a page never mixes two moments.
 */
@Injectable()
export class PrismaDriverOperationsReadAdapter implements IDriverOperationsReadPort {
  constructor(private readonly prisma: PrismaService) {}

  async listDrivers(f: DriverOperationsFilter, page: number, size: number): Promise<DriverOperationsPage> {
    const where: Prisma.DriverProfileWhereInput = {
      ...(f.availability ? { availability: f.availability } : {}),
      ...(f.onShift === undefined ? {} : { shiftStartedAt: f.onShift ? { not: null } : null }),
    };
    return this.prisma.$transaction(
      async (tx) => {
        const [rows, total] = await Promise.all([
          tx.driverProfile.findMany({
            where,
            select: PROFILE_SELECT,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            skip: (page - 1) * size,
            take: size,
          }),
          tx.driverProfile.count({ where }),
        ]);
        const groups = await countJobs(tx, rows.map((r) => r.id));
        return { items: rows.map((r) => toSummary(r, groups)), total, page, size };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async getDriver(driverProfileId: string): Promise<DriverOperationsSummary | null> {
    return this.prisma.$transaction(
      async (tx) => {
        const row = await tx.driverProfile.findUnique({ where: { id: driverProfileId }, select: PROFILE_SELECT });
        if (!row) return null;
        return toSummary(row, await countJobs(tx, [row.id]));
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}

async function countJobs(tx: Prisma.TransactionClient, driverIds: string[]): Promise<JobGroup[]> {
  if (driverIds.length === 0) return [];
  const groups = await tx.deliveryJob.groupBy({
    by: ['assignedDriverId', 'status'],
    where: { assignedDriverId: { in: driverIds } },
    orderBy: [{ assignedDriverId: 'asc' }, { status: 'asc' }],
    _count: { _all: true },
  });
  return groups.map((g) => ({ assignedDriverId: g.assignedDriverId, status: g.status, _count: { _all: g._count._all } }));
}

function toSummary(r: ProfileRow, groups: readonly JobGroup[]): DriverOperationsSummary {
  const mine = new Map(groups.filter((g) => g.assignedDriverId === r.id).map((g) => [g.status as string, g._count._all]));
  const jobsByStatus = Object.values(DeliveryJobStatus).map((status) => ({ status, count: mine.get(status) ?? 0 }));
  return {
    driverProfileId: r.id,
    availability: r.availability,
    onShift: r.shiftStartedAt !== null,
    shiftStartedAt: r.shiftStartedAt,
    lastOnlineAt: r.lastOnlineAt,
    lastLocationAt: r.lastLocationAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    totalJobs: jobsByStatus.reduce((acc, b) => acc + b.count, 0),
    activeJobCount: jobsByStatus.filter((b) => ACTIVE_JOB_STATUSES.includes(b.status)).reduce((acc, b) => acc + b.count, 0),
    jobsByStatus,
  };
}
