import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  CustomerOrderReference,
  IOrderOwnershipReadPort,
} from '../../application/ports/inbound/order-ownership-read.port';

/** Module 06's own tables, read for `ORDER_OWNERSHIP_READ_PORT` (Work 86). */
@Injectable()
export class PrismaOrderOwnershipReadAdapter implements IOrderOwnershipReadPort {
  constructor(private readonly prisma: PrismaService) {}

  async findOrder(orderId: string): Promise<CustomerOrderReference | null> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, orderNumber: true, customerUserId: true },
    });
    if (!order) return null;
    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      customerUserId: order.customerUserId,
    };
  }
}
