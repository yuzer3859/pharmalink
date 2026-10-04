import { PharmacyInventoryErrors } from '../errors';

/** Non-negative integer wrapper (module-04 §3.8). Rejects negative/NaN/non-integer values. */
export class Quantity {
  private constructor(readonly value: number) {}

  static of(value: number): Quantity {
    if (!Number.isInteger(value) || value < 0) {
      throw PharmacyInventoryErrors.validation('Quantity must be a non-negative integer.', {
        field: 'quantity',
      });
    }
    return new Quantity(value);
  }
}
