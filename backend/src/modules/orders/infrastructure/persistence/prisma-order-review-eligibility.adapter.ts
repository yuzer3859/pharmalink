import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  FulfillmentStatus,
  IOrderReviewEligibilityPort,
  OrderStatus,
  ReviewableOrderView,
} from '../../application/ports/inbound/order-review-eligibility.port';

/** `IOrderReviewEligibilityPort` over Prisma: one read of the order and its fulfilments. */
@Injectable()
export class PrismaOrderReviewEligibilityAdapter implements IOrderReviewEligibilityPort {
  constructor(private readonly prisma: PrismaService) {}

  async findOrder(orderId: string): Promise<ReviewableOrderView | null> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, customerUserId: true, status: true, completedAt: true, fulfillments: { select: { pharmacyId: true, status: true } } },
    });
    if (!order) return null;
    return {
      orderId: order.id,
      customerUserId: order.customerUserId,
      status: order.status as OrderStatus,
      completedAt: order.completedAt,
      fulfillments: order.fulfillments.map((f) => ({ pharmacyId: f.pharmacyId, status: f.status as FulfillmentStatus })),
    };
  }
}
