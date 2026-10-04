import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  IOrderPort,
  PayableOrderLineView,
  PayableOrderView,
} from '../../application/ports/outbound/order.port';

/**
 * Module 07's own `IOrderPort` adapter — a direct, in-process `PrismaService.order.findUnique`
 * read of Module 06's `orders` table, never a Prisma relation (ADR-002). Own copy, mirroring
 * `modules/orders/infrastructure/catalog/catalog-port.adapter.ts` and
 * `modules/orders/infrastructure/identity/identity-port.adapter.ts`: `OrdersModule` exports
 * nothing, so every consumer builds its own adapter.
 *
 * Read-only by construction — it exposes no write method, because Module 07 never mutates an
 * order. It projects only the fields Module 07 needs; `grandTotal`/`currency`
 * are Module 06's already-computed authoritative total, re-read rather than re-derived.
 */
@Injectable()
export class OrderPortAdapter implements IOrderPort {
  constructor(private readonly prisma: PrismaService) {}

  async getOrder(orderId: string): Promise<PayableOrderView | null> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        customerUserId: true,
        status: true,
        grandTotal: true,
        currency: true,
        platformFee: true,
        discountTotal: true,
        isCod: true,
      },
    });
    return order ?? null;
  }

  async getOrderLines(orderId: string): Promise<PayableOrderLineView[]> {
    return this.prisma.orderLine.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
      select: {
        catalogProductId: true,
        quantity: true,
        unitPrice: true,
        lineTotal: true,
        pharmacyId: true,
      },
    });
  }

  async getFulfillmentPharmacyIds(orderId: string): Promise<string[]> {
    const fulfillments = await this.prisma.fulfillment.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
      select: { pharmacyId: true },
    });
    return fulfillments.map((fulfillment) => fulfillment.pharmacyId);
  }
}
