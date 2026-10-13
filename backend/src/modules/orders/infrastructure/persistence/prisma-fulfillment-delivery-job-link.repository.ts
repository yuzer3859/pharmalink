import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  DeliveryJobLinkInput,
  DeliveryJobLinkOutcome,
  IFulfillmentDeliveryJobLinkRepository,
} from '../../domain/repositories/fulfillment-delivery-job-link.repository';

/**
 * `IFulfillmentDeliveryJobLinkRepository` over Prisma.
 *
 * One guarded `UPDATE ... WHERE id = ? AND orderId = ? AND deliveryJobId IS NULL`: it either sets
 * the reference or touches nothing, so two concurrent deliveries of the same event cannot both
 * write, and a different reference already present is never replaced. When nothing was updated,
 * one read explains why. `fulfillments` has no `updatedAt`, so nothing else on the row changes.
 */
@Injectable()
export class PrismaFulfillmentDeliveryJobLinkRepository implements IFulfillmentDeliveryJobLinkRepository {
  constructor(private readonly prisma: PrismaService) {}

  async link(input: DeliveryJobLinkInput): Promise<DeliveryJobLinkOutcome> {
    const { count } = await this.prisma.fulfillment.updateMany({
      where: { id: input.fulfillmentId, orderId: input.orderId, deliveryJobId: null },
      data: { deliveryJobId: input.deliveryJobId },
    });
    if (count === 1) return 'LINKED';

    const current = await this.prisma.fulfillment.findUnique({
      where: { id: input.fulfillmentId },
      select: { orderId: true, deliveryJobId: true },
    });
    if (!current) return 'FULFILLMENT_NOT_FOUND';
    if (current.orderId !== input.orderId) return 'ORDER_MISMATCH';
    if (current.deliveryJobId === input.deliveryJobId) return 'ALREADY_LINKED';
    // A null here would mean the guarded update and this read disagree — only possible if the
    // reference was cleared in between, which nothing does. Reported as a conflict, not retried.
    return 'CONFLICT';
  }
}
