import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  DELIVERY_JOB_REFERENCE_ELIGIBLE_STATUSES,
  DeliveryJobReferenceCandidate,
  IDeliveryJobReferenceCandidateRepository,
} from '../../domain/repositories/delivery-job-reference-candidate.repository';

/**
 * `IDeliveryJobReferenceCandidateRepository` over Prisma: one bounded `SELECT id, orderId` on Module
 * 06's own `fulfillments`, keyset-paged on the primary key — never a full scan into memory.
 */
@Injectable()
export class PrismaDeliveryJobReferenceCandidateRepository implements IDeliveryJobReferenceCandidateRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listUnreferenced(afterId: string | null, limit: number): Promise<DeliveryJobReferenceCandidate[]> {
    const rows = await this.prisma.fulfillment.findMany({
      where: {
        deliveryJobId: null,
        status: { in: [...DELIVERY_JOB_REFERENCE_ELIGIBLE_STATUSES] },
        ...(afterId ? { id: { gt: afterId } } : {}),
      },
      select: { id: true, orderId: true },
      orderBy: { id: 'asc' },
      take: limit,
    });
    return rows.map((r) => ({ fulfillmentId: r.id, orderId: r.orderId }));
  }
}
