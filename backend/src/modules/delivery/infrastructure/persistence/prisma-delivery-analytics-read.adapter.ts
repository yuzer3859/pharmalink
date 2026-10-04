import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  DeliveryAnalyticsView,
  DeliveryJobStatus,
  DriverAvailability,
  IDeliveryAnalyticsReadPort,
} from '../../application/ports/inbound/delivery-analytics-read.port';

/**
 * `IDeliveryAnalyticsReadPort` over Prisma — two `GROUP BY`s and one count in PostgreSQL. The
 * dispatchable predicate is copied from `PrismaDriverProfileRepository.findDispatchCandidates`
 * verbatim, and must stay so.
 */
@Injectable()
export class PrismaDeliveryAnalyticsReadAdapter implements IDeliveryAnalyticsReadPort {
  constructor(private readonly prisma: PrismaService) {}

  async summarizeDelivery(): Promise<DeliveryAnalyticsView> {
    const [jobGroups, driverGroups, dispatchable] = await Promise.all([
      this.prisma.deliveryJob.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.driverProfile.groupBy({ by: ['availability'], _count: { _all: true } }),
      this.prisma.driverProfile.count({
        where: { availability: DriverAvailability.ONLINE, shiftStartedAt: { not: null } },
      }),
    ]);
    const jobCounts = new Map(jobGroups.map((g) => [g.status as string, g._count._all]));
    const driverCounts = new Map(driverGroups.map((g) => [g.availability as string, g._count._all]));
    const jobs = Object.values(DeliveryJobStatus).map((status) => ({
      status,
      count: jobCounts.get(status) ?? 0,
    }));
    const drivers = Object.values(DriverAvailability).map((availability) => ({
      availability,
      count: driverCounts.get(availability) ?? 0,
    }));
    const sum = (buckets: { count: number }[]) => buckets.reduce((acc, b) => acc + b.count, 0);
    return {
      jobs: { total: sum(jobs), byStatus: jobs },
      drivers: { total: sum(drivers), dispatchable, byAvailability: drivers },
    };
  }
}
