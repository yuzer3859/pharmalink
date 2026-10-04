import { Inject, Injectable } from '@nestjs/common';
import {
  CART_REPOSITORY,
  CartItemSnapshot,
  ICartRepository,
} from '../../domain/repositories/cart.repository';
import { OrdersErrors } from '../../domain/errors';
import { Quantity } from '../../domain/value-objects/quantity';

export interface UpdateCartItemQuantityInput {
  customerUserId: string;
  cartItemId: string;
  quantity: number;
}

/**
 * `PATCH /cart/items/:id` (module-06 `06-orders-spec.md` §9.1). Ownership is enforced by loading
 * the item's parent `Cart` and comparing `customerUserId` — a missing item and an item owned by a
 * different customer both resolve to the same generic not-found response (no existence leakage
 * across customers, mirroring module-05's `ReuploadPrescriptionCommand`/`GetPrescriptionQuery`).
 * No `IUnitOfWork` — a single-row update with no audit/outbox co-location (§11's "Cart
 * concurrency" resolution, same reasoning as `AddCartItemCommand`).
 */
@Injectable()
export class UpdateCartItemQuantityCommand {
  constructor(@Inject(CART_REPOSITORY) private readonly carts: ICartRepository) {}

  async execute(input: UpdateCartItemQuantityInput): Promise<CartItemSnapshot> {
    const quantity = Quantity.of(input.quantity);

    const item = await this.carts.findItemById(input.cartItemId);
    if (!item) {
      throw OrdersErrors.notFound();
    }
    const cart = await this.carts.findById(item.cartId);
    if (!cart || cart.customerUserId !== input.customerUserId) {
      throw OrdersErrors.notFound();
    }

    return this.carts.updateItemQuantity(input.cartItemId, quantity.value);
  }
}
