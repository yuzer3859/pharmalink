import { Inject, Injectable } from '@nestjs/common';
import {
  CART_REPOSITORY,
  CartItemSnapshot,
  ICartRepository,
} from '../../domain/repositories/cart.repository';
import { OrdersErrors } from '../../domain/errors';
import { CartPolicy } from '../../domain/services/cart-policy';
import { RxClassificationPolicy } from '../../domain/services/rx-classification-policy';
import { Quantity } from '../../domain/value-objects/quantity';
import { CATALOG_PORT, ICatalogPort } from '../ports/outbound/catalog.port';

export interface AddCartItemInput {
  customerUserId: string;
  catalogProductId: string;
  quantity: number;
}

/**
 * `POST /cart/items` (module-06 `06-orders-spec.md` §9.1, §3.2). Resolves the customer's
 * `ACTIVE` cart, creating one lazily if this is their first item (§3.1 — no cart row is
 * persisted until a customer actually adds something). `requiresRx`/`indicativePrice` are cached
 * from a fresh `ICatalogPort.getProduct()` read at add-time (§3.2's `sellable`-cache precedent,
 * ADR-006) — re-validated fresh again at `/cart/validate`/checkout, never trusted stale by any
 * later reader of this cache.
 *
 * `CartPolicy.assertUniqueProduct()` rejects a normal duplicate-add attempt with a friendly
 * `VALIDATION_ERROR` (the client should `PATCH /cart/items/:id` instead) before this command ever
 * calls the repository; `ICartRepository.addItem()`'s own `upsert` against `CartItem`'s
 * `@@unique([cartId, catalogProductId])` constraint remains the sole backstop for the rare
 * concurrent-race case where two requests both pass this pre-check (§11's "Cart concurrency" —
 * the DB constraint, not a transaction, is cart mutations' actual concurrency-safety mechanism).
 *
 * No `IUnitOfWork`/`Serializable` transaction wrapping: this command writes no audit entry and no
 * outbox event (no cart event is cataloged, §8), so ADR-013's "state + audit + outbox co-located
 * in one transaction" trigger never fires here — mirrors §11's own explicit "no `Serializable`
 * isolation is required for cart mutations alone (low stakes, no audit-chain co-location needed
 * for a pre-order cart edit)" resolution.
 */
@Injectable()
export class AddCartItemCommand {
  constructor(
    @Inject(CART_REPOSITORY) private readonly carts: ICartRepository,
    @Inject(CATALOG_PORT) private readonly catalog: ICatalogPort,
  ) {}

  async execute(input: AddCartItemInput): Promise<CartItemSnapshot> {
    const quantity = Quantity.of(input.quantity);

    const product = await this.catalog.getProduct(input.catalogProductId);
    if (!product || product.status !== 'ACTIVE') {
      throw OrdersErrors.catalogProductUnavailable();
    }

    let cart = await this.carts.findActiveByCustomer(input.customerUserId);
    if (!cart) {
      cart = await this.carts.create(input.customerUserId);
    }

    CartPolicy.assertUniqueProduct(
      cart.items.map((item) => item.catalogProductId),
      input.catalogProductId,
    );

    return this.carts.addItem(cart.id, {
      catalogProductId: input.catalogProductId,
      quantity: quantity.value,
      indicativePrice: product.price,
      requiresRx: RxClassificationPolicy.requiresPrescription(product.rxClassification),
    });
  }
}
