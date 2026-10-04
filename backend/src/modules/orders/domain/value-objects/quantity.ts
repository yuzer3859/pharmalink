import { OrdersErrors } from '../errors';

/**
 * Positive-integer quantity wrapper for cart items / order lines (module-06 `06-orders-spec.md`
 * §3.2/§3.7, mirroring the parent doc's `@IsInt() @Min(1) quantity` DTO shape at the domain
 * boundary — the same "business rule, not just DTO shape" split module-05 used for
 * `RejectionReason`). Zero and negative quantities are rejected; there is no maximum-quantity
 * rule anywhere in the Slice-1 specification, so none is invented here.
 */
export class Quantity {
  private constructor(readonly value: number) {}

  static of(value: number): Quantity {
    if (!Number.isInteger(value) || value < 1) {
      throw OrdersErrors.validation('quantity must be a positive integer.', { field: 'quantity' });
    }
    return new Quantity(value);
  }
}
