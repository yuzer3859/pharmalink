import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  DeliveryJobReference,
  IDeliveryJobReferenceReadPort,
  MAX_DELIVERY_JOB_REFERENCE_LOOKUP,
} from '../../application/ports/inbound/delivery-job-reference-read.port';

/**
 * `IDeliveryJobReferenceReadPort` over Prisma: one `SELECT id, fulfillmentId, orderId ... WHERE
 * fulfillmentId IN (...)`, served by the unique index on `delivery_jobs.fulfillmentId`.
 */
@Injectable()
export class PrismaDeliveryJobReferenceReadAdapter implements IDeliveryJobReferenceReadPort {
  constructor(private readonly prisma: PrismaService) {}

  async findByFulfillmentIds(fulfillmentIds: readonly string[]): Promise<DeliveryJobReference[]> {
    if (fulfillmentIds.length === 0) return [];
    if (fulfillmentIds.length > MAX_DELIVERY_JOB_REFERENCE_LOOKUP) {
      throw new Error(`At most ${MAX_DELIVERY_JOB_REFERENCE_LOOKUP} fulfillment ids per lookup.`);
    }
    const rows = await this.prisma.deliveryJob.findMany({
      where: { fulfillmentId: { in: [...fulfillmentIds] } },
      select: { id: true, fulfillmentId: true, orderId: true },
    });
    return rows.map((r) => ({ jobId: r.id, fulfillmentId: r.fulfillmentId, orderId: r.orderId }));
  }
}
