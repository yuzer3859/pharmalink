import { Inject, Injectable } from '@nestjs/common';
import { CART_REPOSITORY, ICartRepository } from '../../domain/repositories/cart.repository';
import { OrdersErrors } from '../../domain/errors';

export interface RemoveCartItemInput {
  customerUserId: string;
  cartItemId: string;
}

/**
 * `DELETE /cart/items/:id` (module-06 `06-orders-spec.md` §9.1). Ownership is enforced by
 * loading the item's parent `Cart` and comparing `customerUserId` — same no-existence-leakage
 * discipline as `UpdateCartItemQuantityCommand`. No `IUnitOfWork` (§11's "Cart concurrency"
 * resolution — a single-row delete, no audit/outbox co-location).
 */
@Injectable()
export class RemoveCartItemCommand {
  constructor(@Inject(CART_REPOSITORY) private readonly carts: ICartRepository) {}

  async execute(input: RemoveCartItemInput): Promise<void> {
    const item = await this.carts.findItemById(input.cartItemId);
    if (!item) {
      throw OrdersErrors.notFound();
    }
    const cart = await this.carts.findById(item.cartId);
    if (!cart || cart.customerUserId !== input.customerUserId) {
      throw OrdersErrors.notFound();
    }

    await this.carts.removeItem(input.cartItemId);
  }
}
