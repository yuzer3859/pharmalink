import { Inject, Injectable } from '@nestjs/common';
import { CART_REPOSITORY, ICartRepository } from '../../domain/repositories/cart.repository';

export interface ClearCartInput {
  customerUserId: string;
}

/**
 * `DELETE /cart` (module-06 `06-orders-spec.md` §9.1) — removes every item, the cart itself
 * remains `ACTIVE` (§3.1's schema-level `CartStatus`; `markConverted` is a distinct, checkout-
 * owned transition, out of this task's scope). A customer with no `ACTIVE` cart yet has nothing
 * to clear — resolved as a no-op, matching `DELETE`'s natural idempotency, not an error (no
 * `CART_NOT_FOUND`-style code is named anywhere in §10 for this case). No `IUnitOfWork` (§11's
 * "Cart concurrency" resolution — no audit/outbox co-location for a cart edit).
 */
@Injectable()
export class ClearCartCommand {
  constructor(@Inject(CART_REPOSITORY) private readonly carts: ICartRepository) {}

  async execute(input: ClearCartInput): Promise<void> {
    const cart = await this.carts.findActiveByCustomer(input.customerUserId);
    if (!cart) {
      return;
    }
    await this.carts.clearItems(cart.id);
  }
}
