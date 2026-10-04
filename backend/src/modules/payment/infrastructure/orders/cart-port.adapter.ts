import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { ActiveCartView, ICartPort } from '../../application/ports/outbound/cart.port';

/**
 * Module 07's own `ICartPort` adapter — a direct, in-process `PrismaService` read of Module 06's
 * `carts`/`cart_items`, never a Prisma relation (ADR-002). Own copy, exactly like this module's
 * `OrderPortAdapter`: `OrdersModule` exports nothing, so every consumer builds its own.
 *
 * Read-only by construction: it exposes no write method, because Module 07 never mutates a cart.
 *
 * `indicativePrice` is deliberately not projected. Module 06's own checkout ignores it in favour
 * of fresh Module 03 prices, and a coupon quote must not be built on a staler number than the
 * order it will be applied to — see `CouponLineResolver`.
 */
@Injectable()
export class CartPortAdapter implements ICartPort {
  constructor(private readonly prisma: PrismaService) {}

  async getActiveCart(customerUserId: string): Promise<ActiveCartView | null> {
    const cart = await this.prisma.cart.findFirst({
      where: { customerUserId, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        customerUserId: true,
        items: {
          orderBy: { addedAt: 'asc' },
          select: { catalogProductId: true, quantity: true },
        },
      },
    });
    if (!cart) {
      return null;
    }
    return {
      id: cart.id,
      customerUserId: cart.customerUserId,
      lines: cart.items.map((item) => ({
        catalogProductId: item.catalogProductId,
        quantity: item.quantity,
      })),
    };
  }
}
